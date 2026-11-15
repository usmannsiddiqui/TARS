// The agent run. A new message from someone else, or the user's own chat message, starts one run:
// the model picks a tool, sees the result, picks the next, and stops when the work is ready. Its
// last words are TARS's message in the project chat (rules and tool catalog: domain/run.ts).
// Code keeps what the model may never decide: the owner comes from the caller's verified identity,
// a run only reaches projects its trigger is in scope for, tools are offered by trigger, calls and
// time are capped, and nothing here sends: propose_send only places the approval block, whose
// recipient and subjects come from stored header fields (thread.approvalBlock).
// shortcut: a run lives inside one action, so one that dies mid-way is not resumed; store its
// transcript and resume from it when runs need to outlive an action.
import { v, type Infer } from "convex/values";
import { commitmentKey } from "../packages/domain/src/attention";
import { dueInstant } from "../packages/domain/src/prepare";
import { MAX_TOOL_RESULT, RUN_INSTRUCTIONS, RUN_TOOLS, refuseCall, runSpent, toolsFor, type RunToolArgs, type RunToolName, type RunTrigger } from "../packages/domain/src/run";
import { block, dueLabel, type Block, type Step } from "../packages/domain/src/thread";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { offerStarted } from "./briefs";
import { ModelError, respond, toolResult, type ModelCall } from "./lib/model";
import { requireOwnedProject } from "./memory";
import { grantInScope } from "./prepare";
import { threadBlocks } from "./schema";
import { approvalBlock } from "./thread";

const MAX_SAY = 2_000;
const MAX_ITEM_TEXT = 2_000;
const CHAT_TURNS = 12;

// ---- What a run reads.

const projectRef = v.object({ id: v.string(), name: v.string() });
const messageContext = v.union(
  v.null(),
  v.object({
    message: v.object({ id: v.string(), from: v.optional(v.string()), subject: v.optional(v.string()), receivedAt: v.string(), text: v.string() }),
    projects: v.array(projectRef),
    user: v.object({ name: v.optional(v.string()), email: v.optional(v.string()) }),
    timezone: v.union(v.string(), v.null()),
  }),
);

/** The arrived message and the projects it is in scope for (its source's granted projects), or null when it is no longer current. */
export const loadMessage = internalQuery({
  args: { ownerId: v.string(), evidenceId: v.string() },
  returns: messageContext,
  handler: async (ctx, { ownerId, evidenceId }): Promise<Infer<typeof messageContext>> => {
    const rows = await ctx.db
      .query("evidence")
      .withIndex("by_owner_id", (q) => q.eq("ownerId", ownerId).eq("id", evidenceId))
      .collect();
    const record = rows.find((row) => row.isCurrent);
    if (record === undefined) return null;
    const projects = [];
    for (const projectId of record.projectIds) {
      const id = ctx.db.normalizeId("projects", projectId);
      const project = id === null ? null : await ctx.db.get(id);
      if (project === null || project.ownerId !== ownerId) continue;
      if ((await grantInScope(ctx, ownerId, projectId, record.sourceId, record.grantVersion)) === null) continue;
      projects.push({ id: projectId, name: project.name });
    }
    const profile = await ctx.db
      .query("ownerProfiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    const settings = await ctx.db
      .query("attentionSettings")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    const from = record.from === undefined ? undefined : record.from.name ? `${record.from.name} <${record.from.address}>` : record.from.address;
    return {
      message: { id: record.id, ...(from === undefined ? {} : { from }), ...(record.subject === undefined ? {} : { subject: record.subject }), receivedAt: record.receivedAt, text: record.text },
      projects,
      user: { ...(profile?.name ? { name: profile.name } : {}), ...(profile?.email ? { email: profile.email } : {}) },
      timezone: settings?.timezone ?? null,
    };
  },
});

/** The owner's projects by name: what a run started by his own chat message may read. */
export const listProjects = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(projectRef),
  handler: async (ctx, { ownerId }) =>
    (
      await ctx.db
        .query("projects")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .collect()
    ).map((p) => ({ id: p._id as string, name: p.name })),
});

const projectState = v.object({
  openRequests: v.array(v.object({ text: v.string(), dueAt: v.optional(v.string()) })),
  draft: v.union(v.null(), v.object({ title: v.optional(v.string()), form: v.optional(v.string()), revision: v.string(), text: v.string() })),
  chat: v.array(v.object({ role: v.string(), text: v.string() })),
});

/** The project's open requests, current draft and recent chat (what each side said, oldest first). */
export const loadProjectState = internalQuery({
  args: { ownerId: v.string(), projectId: v.string(), beforeMessage: v.optional(v.id("threadMessages")) },
  returns: projectState,
  handler: async (ctx, { ownerId, projectId, beforeMessage }): Promise<Infer<typeof projectState>> => {
    await requireOwnedProject(ctx, ownerId, projectId);
    const commitments = await ctx.db
      .query("commitments")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
      .collect();
    const draft = await ctx.db
      .query("artifacts")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
      .unique();
    const messages = await ctx.db
      .query("threadMessages")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
      .collect();
    const cut = beforeMessage === undefined ? messages.length : messages.findIndex((m) => m._id === beforeMessage);
    const chat = messages.slice(0, cut === -1 ? messages.length : cut).flatMap((m) => {
      const said = m.role === "user" ? m.text : m.blocks.find((b) => b.type === "say")?.props?.text;
      return typeof said === "string" && said.length > 0 ? [{ role: m.role, text: said }] : [];
    });
    return {
      openRequests: commitments.filter((c) => c.ownership === "user" && c.state === "open").map((c) => ({ text: c.text, ...(c.dueAt === undefined ? {} : { dueAt: c.dueAt }) })),
      draft: draft && { ...(draft.title === undefined ? {} : { title: draft.title }), ...(draft.form === undefined ? {} : { form: draft.form }), revision: draft.revision, text: draft.text },
      chat: chat.slice(-CHAT_TURNS),
    };
  },
});

// ---- What a run writes.

const started = v.union(v.object({ error: v.string() }), v.object({ key: v.string(), messageId: v.id("threadMessages"), dueAt: v.optional(v.string()) }));

/**
 * The run found a request for the user in the arrived message: one commitment, whose identity is that
 * message, and TARS's message in the project chat that the run then fills. Once per message.
 */
export const startRequest = internalMutation({
  args: { ownerId: v.string(), evidenceId: v.string(), projectId: v.string(), request: v.string(), dueLocal: v.union(v.string(), v.null()), blocks: threadBlocks },
  returns: started,
  handler: async (ctx, { ownerId, evidenceId, projectId, request, dueLocal, blocks }): Promise<Infer<typeof started>> => {
    const record = (
      await ctx.db
        .query("evidence")
        .withIndex("by_owner_id", (q) => q.eq("ownerId", ownerId).eq("id", evidenceId))
        .collect()
    ).find((row) => row.isCurrent);
    const id = ctx.db.normalizeId("projects", projectId);
    const project = id === null ? null : await ctx.db.get(id);
    if (record === undefined || project === null || project.ownerId !== ownerId || !record.projectIds.includes(projectId)) return { error: "That project is not one this message belongs to." };
    if ((await grantInScope(ctx, ownerId, projectId, record.sourceId, record.grantVersion)) === null) return { error: "That project is not one this message belongs to." };

    const settings = await ctx.db
      .query("attentionSettings")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    const dueAt = dueInstant(dueLocal, [Date.parse(record.occurredAt)], settings?.timezone ?? null);
    const existing = (
      await ctx.db
        .query("commitments")
        .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
        .collect()
    ).find((c) => c.evidenceIds[0] === evidenceId);
    const key = existing ? commitmentKey(existing) : `${commitmentKey({ projectId, text: request })}#${evidenceId}`;
    if (existing === undefined) {
      await ctx.db.insert("commitments", { ownerId, projectId, text: request, ownership: "user", state: "open", evidenceIds: [evidenceId], key, ...(dueAt === undefined ? {} : { dueAt }) });
    }
    const spoken = await ctx.db
      .query("threadMessages")
      .withIndex("by_owner_commitment", (q) => q.eq("ownerId", ownerId).eq("commitmentKey", key))
      .first();
    if (spoken !== null) return { error: "This request was already started earlier. Stop here." };
    const messageId = await ctx.db.insert("threadMessages", { ownerId, projectId, role: "tars", blocks, commitmentKey: key, createdAt: Date.now() });
    return { key, messageId, ...(dueAt === undefined ? {} : { dueAt }) };
  },
});

/** The run is done with a request it started: the one "started for you" offer. */
export const announce = internalMutation({
  args: { ownerId: v.string(), projectId: v.string(), key: v.string(), title: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId, projectId, key, title }) => {
    const commitment = (
      await ctx.db
        .query("commitments")
        .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
        .collect()
    ).find((c) => commitmentKey(c) === key);
    if (commitment !== undefined) await offerStarted(ctx, commitment, title);
    return null;
  },
});

// ---- The loop.

type Run = {
  ownerId: string;
  trigger: RunTrigger;
  /** Projects this run may read: the arrived message's in-scope projects, or (he asked) all of the user's. It writes only in `projectId`. */
  projects: Map<string, string>;
  evidenceId?: string;
  timezone: string | null;
  /** Set once the run speaks in a project: by start_request for a message, from the start for chat. */
  projectId?: string;
  messageId?: Id<"threadMessages">;
  key?: string;
  steps: Step[];
  /** Items this run read, by id: the only things it can name as sources. */
  items: Map<string, { label: string; kind?: string; url?: string }>;
  sources?: { id: string; label: string; kind?: string; url?: string }[];
  calls: string[]; // tool names in the order the model called them, for the one log line
  document?: Block;
  approval?: Block;
};

const fail = (error: string) => ({ error });

/** The current blocks of the run's message: the steps so far, then what the work produced. */
const blocksOf = (run: Run, say?: string): Block[] => [
  block("work", "work", { steps: run.steps }),
  ...(run.document ? [run.document] : []),
  ...(say ? [block("say", "say", { text: say.slice(0, MAX_SAY), ...(run.sources?.length ? { sources: run.sources } : {}) })] : []),
  ...(run.approval ? [run.approval] : []),
];

async function show(ctx: ActionCtx, run: Run, say?: string) {
  if (run.messageId !== undefined) await ctx.runMutation(internal.thread.finishReply, { ownerId: run.ownerId, messageId: run.messageId, blocks: blocksOf(run, say) });
}

const TOOLS: { [T in RunToolName]: (ctx: ActionCtx, run: Run, args: RunToolArgs<T>, step: Step) => Promise<unknown> } = {
  async read_project(ctx, run, { projectId }, step) {
    const name = run.projects.get(projectId);
    if (name === undefined) return fail("That project is not available to this piece of work.");
    Object.assign(step, { label: `Reading ${name}`, doneLabel: `Read ${name}` });
    const { evidence, sources, memory, kinds } = await ctx.runQuery(internal.prepare.loadPreparationContext, { ownerId: run.ownerId, projectId });
    const state = await ctx.runQuery(internal.runs.loadProjectState, { ownerId: run.ownerId, projectId, ...(run.trigger === "chat" && run.messageId ? { beforeMessage: run.messageId } : {}) });
    step.sources = sources;
    const items = [];
    let size = 0;
    for (const e of evidence) {
      const item = { id: e.id, ...(e.from ? { from: e.from.name ?? e.from.address } : {}), ...(e.subject ? { subject: e.subject } : {}), at: e.occurredAt, text: e.text.slice(0, MAX_ITEM_TEXT) };
      size += JSON.stringify(item).length;
      if (size > MAX_TOOL_RESULT) break; // newest first: what does not fit is left out, never cut mid-item
      items.push(item);
      const whole = e.subject ?? e.text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "Source";
      const label = whole.length > 48 ? `${whole.slice(0, 47)}…` : whole;
      const kind = kinds.find((k) => k.sourceId === e.sourceId)?.kind;
      run.items.set(e.id, { label, ...(kind ? { kind } : {}), ...(e.sourceUrl?.startsWith("https://") ? { url: e.sourceUrl } : {}) });
    }
    return { project: name, ...state, remembered: memory, items, itemsLeftOut: evidence.length - items.length };
  },

  async start_request(ctx, run, { projectId, request, dueLocal }, step) {
    Object.assign(step, { label: "Recording the request", doneLabel: "Recorded the request" });
    if (run.evidenceId === undefined) return fail("There is no arrived message to record a request from.");
    if (run.key !== undefined) return fail("You already recorded this message's request.");
    const result = await ctx.runMutation(internal.runs.startRequest, { ownerId: run.ownerId, evidenceId: run.evidenceId, projectId, request, dueLocal, blocks: blocksOf(run) });
    if ("error" in result) return result;
    Object.assign(run, { projectId, key: result.key, messageId: result.messageId });
    return { recorded: true, due: result.dueAt && run.timezone ? dueLabel(result.dueAt, run.timezone) : "no due time" };
  },

  async write_draft(ctx, run, { title, form, text, changeSummary }, step) {
    Object.assign(step, { label: `Drafting “${title}”`, doneLabel: `Drafted “${title}”` });
    if (run.projectId === undefined) return fail("Record the request with start_request before writing a draft.");
    let result;
    try {
      result = await ctx.runMutation(internal.artifacts.writeDraft, { ownerId: run.ownerId, projectId: run.projectId, title, form, text, changeSummary });
    } catch {
      return fail("The draft could not be saved: it is empty or too long.");
    }
    const { artifact, undoRevision } = result;
    run.document = block("document", "document", { artifactId: artifact.id, title, revision: artifact.revision, ...(undoRevision ? { changeSummary, undoRevision } : {}) });
    delete run.approval; // an approval shown for an earlier revision in this run no longer matches
    return { saved: true, revision: artifact.revision };
  },

  async cite_sources(_ctx, run, { itemIds }, step) {
    Object.assign(step, { label: "Noting the sources", doneLabel: "Noted the sources" });
    // Only items this run read, with their stored links: the model never writes a link.
    run.sources = [...new Set(itemIds)].flatMap((id) => {
      const item = run.items.get(id);
      return item ? [{ id, ...item }] : [];
    });
    return { noted: run.sources.length };
  },

  async propose_send(ctx, run, _args, step) {
    Object.assign(step, { label: "Preparing what will go out", doneLabel: "Prepared what will go out" });
    if (run.projectId === undefined) return fail("There is no project to send from.");
    const c = await ctx.runQuery(internal.thread.loadApprovalContext, { ownerId: run.ownerId, projectId: run.projectId });
    if (c.artifact === null) return fail("There is no draft in this project yet, so there is nothing to send.");
    run.approval = approvalBlock(run.projectId, c.artifact, c.commitmentKey, c.requester);
    return { shown: true, note: "The user now sees exactly what would go out and can press the button. Nothing has been sent." };
  },
};

/** One tool call: refused by the rules, rejected for bad arguments, or run. Errors go back to the model as results. */
async function runCall(ctx: ActionCtx, run: Run, call: ModelCall, earlier: readonly { name: string; args: string }[], elapsedMs: number) {
  const startedAt = Date.now();
  const step: Step = { id: call.callId, label: "Working", status: "running", startedAt };
  const refused = refuseCall({ name: call.name, args: call.args, earlier, elapsedMs });
  if (refused !== null) return fail(refused); // never shown: nothing was done
  if (!toolsFor(run.trigger).includes(call.name as RunToolName)) return fail(`${call.name} is not available here.`);
  const name = call.name as RunToolName;
  let args;
  try {
    args = RUN_TOOLS[name].args.parse(JSON.parse(call.args));
  } catch {
    return fail("Those arguments are not valid for this tool.");
  }
  for (const s of run.steps) if (s.status === "running") Object.assign(s, { status: "done", endedAt: startedAt }); // the step that was waiting on the model
  run.steps.push(step);
  const result = await (TOOLS[name] as (ctx: ActionCtx, run: Run, args: unknown, step: Step) => Promise<unknown>)(ctx, run, args, step);
  const error = typeof result === "object" && result !== null && "error" in result ? String(result.error) : undefined;
  Object.assign(step, { status: error === undefined ? "done" : "failed", endedAt: Date.now(), ...(error === undefined ? {} : { error }) });
  await show(ctx, run);
  return result;
}

/** The loop itself. Returns the model's last words. Throws ModelError when a model request fails. */
async function work(ctx: ActionCtx, run: Run, first: unknown): Promise<string> {
  const input: unknown[] = [{ role: "user", content: JSON.stringify(first) }];
  const instructions = RUN_INSTRUCTIONS[run.trigger];
  const offered = toolsFor(run.trigger).map((name) => ({ name, description: RUN_TOOLS[name].description, args: RUN_TOOLS[name].args }));
  const startedAt = Date.now();
  const earlier: { name: string; args: string }[] = [];
  for (;;) {
    const spent = runSpent(earlier.length, Date.now() - startedAt);
    const turn = await respond({ instructions, input, tools: spent ? [] : offered });
    input.push(...turn.items);
    if (turn.calls.length === 0 || spent) {
      if (turn.text.trim().length > 0 || run.messageId === undefined) return turn.text.trim();
      // The work is saved but the model said nothing: ask once, with no tools, for its words.
      input.push({ role: "user", content: "Now write your message to the user." });
      return (await respond({ instructions, input, tools: [] })).text.trim();
    }
    for (const call of turn.calls) {
      const result = await runCall(ctx, run, call, earlier, Date.now() - startedAt);
      earlier.push({ name: call.name, args: call.args });
      run.calls.push(call.name);
      input.push(toolResult(call.callId, result));
    }
  }
}

/** One line per run: what started it, the tools it called, how it ended. Never any source or model text. */
const log = (run: Run, outcome: string) => console.info(`run ${run.trigger}: ${run.calls.join(",") || "no tools"} -> ${outcome}`);

/** A failed model request ends the run where it is: the step that was waiting on it reads failed. */
async function stopOnModelError(ctx: ActionCtx, run: Run, error: unknown, retry: boolean) {
  if (!(error instanceof ModelError)) throw error;
  log(run, `model request failed (${error.code})`);
  if (run.messageId === undefined) return;
  const now = Date.now();
  const steps = run.steps.length > 0 ? run.steps : [{ id: "think", label: "Thinking", status: "running" as const, startedAt: now }];
  const last = steps[steps.length - 1]!;
  const failed: Step = last.status === "running" ? { ...last, status: "failed", endedAt: now, error: `The model request failed (${error.code}).` } : { id: "think", label: "Thinking", status: "failed", startedAt: now, endedAt: now, error: `The model request failed (${error.code}).` };
  const shown = last.status === "running" ? [...steps.slice(0, -1), failed] : [...steps, failed];
  await ctx.runMutation(internal.thread.finishReply, {
    ownerId: run.ownerId,
    messageId: run.messageId,
    blocks: [block("work", "work", { steps: shown, ...(retry ? { retry: true } : {}) }), ...(run.document ? [run.document] : [])],
  });
}

/** Now, as the user's wall clock reads it ("2026-11-15 09:00"), or UTC when no time zone is stored. */
const localNow = (timezone: string | null) =>
  timezone ? new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, dateStyle: "short", timeStyle: "short" }).format(new Date()) : new Date().toISOString();

/** A new message arrived from a source that allows cloud processing: decide what it asks, and start the work. */
export const onMessage = internalAction({
  args: { ownerId: v.string(), evidenceId: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId, evidenceId }): Promise<null> => {
    const c = await ctx.runQuery(internal.runs.loadMessage, { ownerId, evidenceId });
    if (c === null || c.projects.length === 0) return null;
    const run: Run = { ownerId, trigger: "message", projects: new Map(c.projects.map((p) => [p.id, p.name])), evidenceId, timezone: c.timezone, steps: [], items: new Map(), calls: [] };
    try {
      const said = await work(ctx, run, { now: localNow(c.timezone), timezone: c.timezone, user: c.user, projects: c.projects, message: c.message });
      if (run.messageId === undefined || run.projectId === undefined || run.key === undefined) {
        log(run, "nothing asked of the user");
        return null;
      }
      await show(ctx, run, said);
      const title = run.document?.type === "document" ? run.document.props.title : "Your request";
      await ctx.runMutation(internal.runs.announce, { ownerId, projectId: run.projectId, key: run.key, title });
      log(run, "started a request");
    } catch (error) {
      await stopOnModelError(ctx, run, error, false);
    }
    return null;
  },
});

/** The user's stored chat message (`messageId` is TARS's reply to it, already showing a running step). */
export async function answerChat(ctx: ActionCtx, ownerId: string, messageId: Id<"threadMessages">) {
  const c = await ctx.runQuery(internal.thread.loadAnswerContext, { ownerId, messageId });
  const { projectName, timezone } = await ctx.runQuery(internal.prepare.loadPreparationContext, { ownerId, projectId: c.projectId });
  const state = await ctx.runQuery(internal.runs.loadProjectState, { ownerId, projectId: c.projectId, beforeMessage: messageId });
  const projects = await ctx.runQuery(internal.runs.listProjects, { ownerId });
  const read: Step = { id: "read", label: "Reading your message", doneLabel: "Read your message", status: "running", startedAt: c.startedAt };
  const run: Run = { ownerId, trigger: "chat", projects: new Map(projects.map((p) => [p.id, p.name])), timezone, projectId: c.projectId, messageId, steps: [read], items: new Map(), calls: [] };
  try {
    // His message is the last entry of the stored chat; it goes in `message`, the rest is context.
    const said = await work(ctx, run, { project: { id: c.projectId, name: projectName }, projects, chat: state.chat.slice(0, -1), draft: state.draft, message: c.text });
    if (read.status === "running") Object.assign(read, { status: "done", endedAt: Date.now() });
    await show(ctx, run, said);
    log(run, "replied");
  } catch (error) {
    await stopOnModelError(ctx, run, error, true);
  }
}

const MAX_PHONE = 1_500; // one Telegram message

/** The owner's projects, name and time zone for a run nobody typed: only what the stored profile and settings hold. */
export const loadOwner = internalQuery({
  args: { ownerId: v.string() },
  returns: v.object({ projects: v.array(projectRef), user: v.object({ name: v.optional(v.string()) }), timezone: v.union(v.string(), v.null()) }),
  handler: async (ctx, { ownerId }) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
    const profile = await ctx.db
      .query("ownerProfiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    const settings = await ctx.db
      .query("attentionSettings")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    return { projects: projects.map((p) => ({ id: p._id as string, name: p.name })), user: profile?.name ? { name: profile.name } : {}, timezone: settings?.timezone ?? null };
  },
});

/** The morning brief's time came (briefs.prepareDaily): a read-only run writes the day's message for his linked phone. */
export const onMorning = internalAction({
  args: { ownerId: v.string(), key: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId, key }): Promise<null> => {
    const c = await ctx.runQuery(internal.runs.loadOwner, { ownerId });
    const run: Run = { ownerId, trigger: "brief", projects: new Map(c.projects.map((p) => [p.id, p.name])), timezone: c.timezone, steps: [], items: new Map(), calls: [] };
    try {
      const said = await work(ctx, run, { now: localNow(c.timezone), timezone: c.timezone, user: c.user, projects: c.projects });
      if (said.length > 0) await ctx.runMutation(internal.telegram.queueBrief, { ownerId, key, body: said.slice(0, MAX_PHONE) });
      log(run, said.length > 0 ? "wrote the morning brief" : "had nothing to say");
    } catch (error) {
      await stopOnModelError(ctx, run, error, false);
    }
    return null;
  },
});
