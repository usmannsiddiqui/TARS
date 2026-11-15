// Instructed actions: the user's instruction → a durable reservation → one provider effect →
// read-back verification → exact task completion → a separately receipted outcome log.
// Only `executeIntent`, called by the authenticated user, reserves an action. Evidence, model
// output, suggestions and preparation have no path here. Nothing runs on a timer: reconciliation
// happens on the user's check or on reconnect, and a failed log is retried only when asked.
import { ConvexError, v, type Infer } from "convex/values";
import {
  actionMarker,
  checkBinding,
  contentHash,
  logMarker,
  outcomeLogEntry,
  type EffectOutcome,
} from "../packages/domain/src/actions";
import type { Artifact } from "../packages/domain/src/types";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server";
import * as composio from "./connectors/composio";
import * as gmail from "./connectors/gmail";
import * as notion from "./connectors/notion";
import * as outlook from "./connectors/outlook";
import { StoredGrantSchema } from "./evidence";
import { requireOwnerId } from "./lib/auth";
import { requireOwnedProject } from "./memory";
import { reportSendOutcome } from "./whatsapp";

const MAIL_KINDS = ["gmail", "outlook-mail"];
const normalizePage = (id: string) => id.replace(/-/g, "").toLowerCase();

const receipt = v.object({
  id: v.string(),
  kind: v.union(v.literal("update-note"), v.literal("send-mail"), v.literal("post-message"), v.literal("send-document")),
  destination: v.string(), // the address or Notion page id the user named
  revision: v.string(), // the artifact revision the instruction was bound to
  state: v.union(v.literal("pending"), v.literal("running"), v.literal("succeeded"), v.literal("failed"), v.literal("unknown")),
  externalId: v.optional(v.string()),
  verifiedAt: v.optional(v.string()),
  logState: v.union(v.literal("not-due"), v.literal("pending"), v.literal("written"), v.literal("failed")),
  reason: v.optional(v.string()),
});
type Receipt = Infer<typeof receipt>;
const clarification = v.object({ status: v.literal("needs-clarification"), reason: v.string() });
type Clarification = Infer<typeof clarification>;
const clarify = (reason: string): Clarification => ({ status: "needs-clarification", reason });

const toReceipt = (row: Doc<"actions">): Receipt => ({
  id: row._id,
  kind: row.kind,
  destination: row.destination,
  revision: row.revision,
  state: row.state,
  logState: row.logState,
  ...(row.externalId === undefined ? {} : { externalId: row.externalId }),
  ...(row.verifiedAt === undefined ? {} : { verifiedAt: row.verifiedAt }),
  ...(row.reason === undefined ? {} : { reason: row.reason }),
});

async function requireOwnedAction(ctx: Pick<QueryCtx, "db">, ownerId: string, actionId: string) {
  const id = ctx.db.normalizeId("actions", actionId);
  const row = id === null ? null : await ctx.db.get(id);
  if (row === null || row.ownerId !== ownerId) throw new ConvexError("Action not found");
  return row;
}

async function requireOwnedCommitment(ctx: Pick<QueryCtx, "db">, ownerId: string, taskId: string) {
  const id = ctx.db.normalizeId("commitments", taskId);
  const row = id === null ? null : await ctx.db.get(id);
  if (row === null || row.ownerId !== ownerId) throw new ConvexError("Task not found");
  return row;
}

// shortcut: grants has only a by_source index, so this scans; add a by_owner index if grants grow.
async function activeGrants(ctx: Pick<QueryCtx, "db">, ownerId: string, projectId: string) {
  const rows = await ctx.db.query("grants").collect();
  return rows
    .filter((row) => row.ownerId === ownerId)
    .map((row) => StoredGrantSchema.parse(row))
    .filter((grant) => grant.state === "active" && grant.projectIds.includes(projectId as never));
}

async function loadLogDestination(ctx: Pick<QueryCtx, "db">, ownerId: string, projectId: string) {
  return ctx.db
    .query("logDestinations")
    .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
    .unique();
}

const intentArgs = {
  projectId: v.string(),
  taskId: v.optional(v.string()),
  kind: v.union(v.literal("update-note"), v.literal("send-mail"), v.literal("post-message")),
  destination: v.string(),
  artifactId: v.string(),
  revision: v.string(),
  contentHash: v.string(),
  instructionId: v.string(),
};

// ---- The user's instruction.

/** A clear instruction is the approval. A stale version is a question back, not a send. */
export const executeIntent = action({
  args: intentArgs,
  returns: v.union(receipt, clarification),
  handler: async (ctx, intent): Promise<Receipt | Clarification> => {
    const ownerId = await requireOwnerId(ctx);
    if (intent.instructionId.trim().length === 0) throw new ConvexError("instructionId is required");
    const existing: Receipt | null = await ctx.runQuery(internal.actions.receiptForInstruction, {
      ownerId,
      instructionId: intent.instructionId,
    });
    if (existing !== null) return existing; // the same instruction never executes twice
    const artifact: Artifact = await ctx.runQuery(internal.artifacts.loadArtifact, { ownerId, artifactId: intent.artifactId });
    const check = checkBinding(intent, artifact, await contentHash(artifact.text));
    if (!check.ok) return clarify(check.reason);

    const reserved: { actionId: string } | Receipt | Clarification = await ctx.runMutation(internal.actions.reserve, {
      ownerId,
      ...intent,
    });
    if (!("actionId" in reserved)) return reserved;
    const row: Doc<"actions"> = await ctx.runQuery(internal.actions.loadAction, { ownerId, actionId: reserved.actionId });
    return runReserved(ctx, row);
  },
});

/** Durable reservation, written before any provider call, in one transaction with every check. */
export const reserve = internalMutation({
  args: { ownerId: v.string(), ...intentArgs },
  returns: v.union(v.object({ actionId: v.string() }), receipt, clarification),
  handler: (ctx, { ownerId, ...intent }) => reserveAction(ctx, ownerId, intent),
});

/** What a send-document reservation binds beyond the intent: the mail itself and its document (none for a reply). */
type DocumentMail = { subject: string; body: string; documentId?: Id<"artifactDocuments">; stages: NonNullable<Doc<"actions">["stages"]> };
type Intent = Omit<Infer<ReturnType<typeof v.object<typeof intentArgs>>>, "kind"> & { kind: Doc<"actions">["kind"] };

/** The reservation itself; `mail` is required for (and only for) send-document. */
export async function reserveAction(
  ctx: MutationCtx,
  ownerId: string,
  intent: Intent,
  mail?: DocumentMail,
): Promise<{ actionId: string } | Receipt | Clarification> {
  if ((intent.kind === "send-document") !== (mail !== undefined)) throw new ConvexError("A document send needs its mail");
  const existing = await ctx.db
    .query("actions")
    .withIndex("by_instruction", (q) => q.eq("ownerId", ownerId).eq("instructionId", intent.instructionId))
    .unique();
  if (existing !== null) return toReceipt(existing);
  await requireOwnedProject(ctx, ownerId, intent.projectId);
  const artifactId = ctx.db.normalizeId("artifacts", intent.artifactId);
  const artifact = artifactId === null ? null : await ctx.db.get(artifactId);
  // Text is immutable per revision, so an equal revision still carries the hashed text.
  if (artifact === null || artifact.ownerId !== ownerId || artifact.revision !== intent.revision) {
    return clarify("The draft changed after you asked. Check the current version and ask again.");
  }
  if (intent.taskId !== undefined) {
    const taskId = ctx.db.normalizeId("commitments", intent.taskId);
    const task = taskId === null ? null : await ctx.db.get(taskId);
    if (task === null || task.ownerId !== ownerId || task.projectId !== intent.projectId) {
      return clarify("That task is not part of this project.");
    }
  }

  const grants = await activeGrants(ctx, ownerId, intent.projectId);
  let route: { sourceId: string; provider: string };
  if (intent.kind !== "update-note") {
    const kinds = intent.kind === "post-message" ? ["slack"] : MAIL_KINDS;
    const senders = [];
    for (const grant of grants.filter((g) => kinds.includes(g.kind))) {
      const permission = await ctx.db
        .query("sendPermissions")
        .withIndex("by_source", (q) => q.eq("sourceId", grant.id))
        .unique();
      if (permission?.ownerId !== ownerId) continue;
      const connection = await ctx.db
        .query("connections")
        .withIndex("by_source", (q) => q.eq("sourceId", grant.id))
        .unique();
      senders.push({ sourceId: grant.id, provider: connection?.broker === "composio" ? `composio-${grant.kind}` : grant.kind });
    }
    // Never a silent downgrade: no send consent means no send.
    if (senders.length === 0) throw new ConvexError("missing-send-permission");
    if (senders.length > 1) return clarify(intent.kind === "post-message" ? "Which Slack workspace should post it?" : "Which mailbox should send it?");
    route = senders[0]!;
    // The document mail carries its own subject, which only the Composio Gmail send passes through.
    if (intent.kind === "send-document" && route.provider !== "composio-gmail") return clarify("Connect Gmail through Composio to send the document.");
  } else {
    const page = grants.find(
      (g) => g.kind === "notion" && g.writeTargets.some((w) => normalizePage(w) === normalizePage(intent.destination)),
    );
    // shortcut: update-note to an Obsidian note is not wired as an action (only as the log); add a desktop-reported path if needed.
    if (page === undefined) return clarify("That page is not one you designated for TARS to write to.");
    route = { sourceId: page.id, provider: "notion" };
  }
  const actionId = await ctx.db.insert("actions", {
    ownerId,
    ...intent,
    ...route,
    body: artifact.text,
    ...(mail === undefined ? {} : mail),
    state: "running",
    logState: "not-due",
  });
  return { actionId };
}

// ---- Effects and lookups, one per supported write. No arbitrary tool executor.

/** The one effect for a reserved, running action, then its outcome. `onSent`: the provider accepted it, before read-back. */
export async function runReserved(ctx: ActionCtx, row: Doc<"actions">, onSent?: () => Promise<void>): Promise<Receipt> {
  return settle(ctx, row, await perform(ctx, row, onSent));
}

function perform(ctx: ActionCtx, row: Doc<"actions">, onSent?: () => Promise<void>): Promise<EffectOutcome> {
  const mail = { actionId: row._id, sourceId: row.sourceId, to: row.destination, body: row.body };
  if (row.provider.startsWith("composio-")) return composio.perform(ctx, row, onSent);
  if (row.provider === "gmail") return gmail.sendMail(ctx, mail);
  if (row.provider === "outlook-mail") return outlook.sendMail(ctx, mail);
  return notion.appendMarked(ctx, noteJob(row));
}

function lookup(ctx: ActionCtx, row: Doc<"actions">): Promise<EffectOutcome> {
  const mail = {
    actionId: row._id,
    sourceId: row.sourceId,
    to: row.destination,
    body: row.body,
    ...(row.externalId === undefined ? {} : { externalId: row.externalId }),
  };
  if (row.provider.startsWith("composio-")) return composio.lookup(ctx, row);
  if (row.provider === "gmail") return gmail.lookupSentMail(ctx, mail);
  if (row.provider === "outlook-mail") return outlook.lookupSentMail(ctx, mail);
  return notion.lookupMarked(ctx, noteJob(row));
}

const noteJob = (row: Doc<"actions">) => {
  const marker = actionMarker(row._id);
  return { sourceId: row.sourceId, pageId: row.destination, marker, text: `${row.body}\n\n[${marker}]` };
};

/** Record an outcome; a verified one completes its task and makes the log due (tried once now). */
async function settle(ctx: ActionCtx, row: Doc<"actions">, outcome: EffectOutcome): Promise<Receipt> {
  await ctx.runMutation(internal.actions.recordOutcome, {
    actionId: row._id,
    state: outcome.state,
    ...(outcome.externalId === undefined ? {} : { externalId: outcome.externalId }),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
  if (outcome.state === "succeeded") await writeLog(ctx, row.ownerId, row._id);
  return ctx.runQuery(internal.actions.receiptById, { actionId: row._id });
}

export const recordOutcome = internalMutation({
  args: {
    actionId: v.id("actions"),
    state: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("unknown")),
    externalId: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { actionId, state, externalId, reason }) => {
    const row = await ctx.db.get(actionId);
    if (row === null || (row.state !== "running" && row.state !== "unknown")) return null; // settled ones stay settled
    const verified = state === "succeeded";
    const destination = verified ? await loadLogDestination(ctx, row.ownerId, row.projectId) : null;
    await ctx.db.patch(actionId, {
      state,
      externalId: externalId ?? row.externalId,
      reason: verified ? undefined : reason,
      ...(verified ? { verifiedAt: new Date().toISOString(), logState: destination === null ? "not-due" : "pending" } : {}),
      // A later check that proves delivery closes the send and verify stages it left open.
      ...(verified && row.stages !== undefined ? { stages: row.stages.map((s) => (s.state === "done" ? s : { name: s.name, state: "done" as const, ...(s.startedAt === undefined ? {} : { startedAt: s.startedAt }), endedAt: Date.now() })) } : {}),
    });
    await reportSendOutcome(ctx, row, state); // one message to his linked phone
    if (verified && row.taskId !== undefined) {
      const taskId = ctx.db.normalizeId("commitments", row.taskId);
      const task = taskId === null ? null : await ctx.db.get(taskId);
      // Exactly the bound task, re-checked: same owner and project.
      if (task !== null && task.ownerId === row.ownerId && task.projectId === row.projectId) {
        await ctx.db.patch(task._id, { state: "verified-done" });
      }
    }
    return null;
  },
});

/** Look an unknown outcome up by its deterministic marker/id. Never resends. */
export const reconcileAction = action({
  args: { actionId: v.string() },
  returns: receipt,
  handler: async (ctx, { actionId }): Promise<Receipt> => {
    const ownerId = await requireOwnerId(ctx);
    const row: Doc<"actions"> = await ctx.runQuery(internal.actions.loadAction, { ownerId, actionId });
    if (row.state !== "unknown") return toReceipt(row);
    return settle(ctx, row, await lookup(ctx, row));
  },
});

/** Reconnect with outstanding receipts on this source (called by the consent callbacks). */
export const reconcileOutstanding = internalAction({
  args: { ownerId: v.string(), sourceId: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId, sourceId }): Promise<null> => {
    const rows: Doc<"actions">[] = await ctx.runQuery(internal.actions.unknownForSource, { ownerId, sourceId });
    for (const row of rows) await settle(ctx, row, await lookup(ctx, row));
    return null;
  },
});

// ---- Outcome log: its own marker and receipt. Never repeats or undoes the action.

async function writeLog(ctx: ActionCtx, ownerId: string, actionId: string): Promise<void> {
  const { row, destination }: { row: Doc<"actions">; destination: Doc<"logDestinations"> | null } = await ctx.runQuery(
    internal.actions.loadForLog,
    { ownerId, actionId },
  );
  if (row.state !== "succeeded" || row.logState === "written" || destination === null) return;
  if (destination.kind === "obsidian") {
    // The Mac performs the append (local-log.ts) and reports back through reportLocalLog.
    await ctx.runMutation(internal.actions.setLogState, { actionId: row._id, logState: "pending" });
    return;
  }
  const marker = logMarker(row._id);
  const outcome = await notion.appendMarked(ctx, {
    sourceId: destination.sourceId,
    pageId: destination.target,
    marker,
    text: logEntryFor(row),
  });
  // Unknown counts as failed for a log: a retry checks the marker first, so it cannot duplicate.
  await ctx.runMutation(internal.actions.setLogState, {
    actionId: row._id,
    logState: outcome.state === "succeeded" ? "written" : "failed",
  });
}

const logEntryFor = (row: Doc<"actions">) =>
  outcomeLogEntry({
    actionId: row._id,
    kind: row.kind,
    destination: row.destination,
    ...(row.externalId === undefined ? {} : { externalId: row.externalId }),
    ...(row.verifiedAt === undefined ? {} : { verifiedAt: row.verifiedAt }),
  });

/** User-triggered: write (or re-write) the log of a verified action. The action is not touched. */
export const appendOutcomeLog = action({
  args: { actionId: v.string() },
  returns: receipt,
  handler: async (ctx, { actionId }): Promise<Receipt> => {
    const ownerId = await requireOwnerId(ctx);
    const { row, destination }: { row: Doc<"actions">; destination: Doc<"logDestinations"> | null } = await ctx.runQuery(
      internal.actions.loadForLog,
      { ownerId, actionId },
    );
    if (row.state !== "succeeded") throw new ConvexError("Only a verified action is logged");
    if (destination === null) throw new ConvexError("Choose where outcomes are logged first");
    await writeLog(ctx, ownerId, row._id);
    return ctx.runQuery(internal.actions.receiptById, { actionId: row._id });
  },
});

/** The desktop's result for an Obsidian append it performed. */
export const reportLocalLog = mutation({
  args: { actionId: v.string(), result: v.union(v.literal("written"), v.literal("failed")) },
  returns: v.null(),
  handler: async (ctx, { actionId, result }) => {
    const ownerId = await requireOwnerId(ctx);
    const row = await requireOwnedAction(ctx, ownerId, actionId);
    const destination = await loadLogDestination(ctx, ownerId, row.projectId);
    if (row.state !== "succeeded" || destination?.kind !== "obsidian") throw new ConvexError("No local log is due");
    if (row.logState !== "written") await ctx.db.patch(row._id, { logState: result });
    return null;
  },
});

/** For the desktop to subscribe to: Obsidian log appends it should perform now. */
export const pendingLocalLogs = query({
  args: {},
  returns: v.array(v.object({ actionId: v.string(), target: v.string(), marker: v.string(), entry: v.string() })),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const rows = await ctx.db
      .query("actions")
      .withIndex("by_owner_log", (q) => q.eq("ownerId", ownerId).eq("logState", "pending"))
      .collect();
    const due = [];
    for (const row of rows) {
      const destination = await loadLogDestination(ctx, ownerId, row.projectId);
      if (destination?.kind === "obsidian") {
        due.push({ actionId: row._id, target: destination.target, marker: logMarker(row._id), entry: logEntryFor(row) });
      }
    }
    return due;
  },
});

/** The user picks the log location; it must be a write target of their active grant for this project. */
export const setLogDestination = mutation({
  args: { projectId: v.string(), kind: v.union(v.literal("notion"), v.literal("obsidian")), target: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, kind, target }) => {
    const ownerId = await requireOwnerId(ctx);
    await requireOwnedProject(ctx, ownerId, projectId);
    const same = (w: string) => (kind === "notion" ? normalizePage(w) === normalizePage(target) : w === target);
    const grant = (await activeGrants(ctx, ownerId, projectId)).find((g) => g.kind === kind && g.writeTargets.some(same));
    // A write target is never ingested (Notion `readable`, source-watch), so the log cannot create obligations.
    if (grant === undefined) throw new ConvexError("Choose a page or note you designated as a write target");
    const existing = await loadLogDestination(ctx, ownerId, projectId);
    const next = { ownerId, projectId, kind, sourceId: grant.id, target };
    if (existing === null) await ctx.db.insert("logDestinations", next);
    else await ctx.db.replace(existing._id, next);
    return null;
  },
});

/**
 * What the chooser shows as set. A Notion page id is a cloud id and is returned as the label; an
 * Obsidian target is an opaque hash with no stored label, so none is returned.
 */
export const getLogDestination = query({
  args: { projectId: v.string() },
  returns: v.union(
    v.null(),
    v.object({ kind: v.union(v.literal("notion"), v.literal("obsidian")), label: v.optional(v.string()) }),
  ),
  handler: async (ctx, { projectId }) => {
    const ownerId = await requireOwnerId(ctx);
    await requireOwnedProject(ctx, ownerId, projectId);
    const row = await loadLogDestination(ctx, ownerId, projectId);
    if (row === null) return null;
    return row.kind === "notion" ? { kind: row.kind, label: row.target } : { kind: row.kind };
  },
});

// ---- Completion the user reports.

/** "I did it": user-reported-done, never shown as verified. Starts nothing else. */
export const reportDone = mutation({
  args: { taskId: v.string() },
  returns: v.union(v.literal("user-reported-done"), v.literal("verified-done")),
  handler: async (ctx, { taskId }) => {
    const ownerId = await requireOwnerId(ctx);
    const task = await requireOwnedCommitment(ctx, ownerId, taskId);
    if (task.state === "verified-done") return "verified-done";
    await ctx.db.patch(task._id, { state: "user-reported-done", doneAt: Date.now() });
    return "user-reported-done";
  },
});

// ---- Queries for the UI.

export const getReceipt = query({
  args: { actionId: v.string() },
  returns: receipt,
  handler: async (ctx, { actionId }) => toReceipt(await requireOwnedAction(ctx, await requireOwnerId(ctx), actionId)),
});

export const listReceipts = query({
  args: { projectId: v.string() },
  returns: v.array(receipt),
  handler: async (ctx, { projectId }) => {
    const ownerId = await requireOwnerId(ctx);
    await requireOwnedProject(ctx, ownerId, projectId);
    const rows = await ctx.db
      .query("actions")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
      .collect();
    return rows.map(toReceipt);
  },
});

// ---- Internal steps.

export const receiptForInstruction = internalQuery({
  args: { ownerId: v.string(), instructionId: v.string() },
  returns: v.union(v.null(), receipt),
  handler: async (ctx, { ownerId, instructionId }) => {
    const row = await ctx.db
      .query("actions")
      .withIndex("by_instruction", (q) => q.eq("ownerId", ownerId).eq("instructionId", instructionId))
      .unique();
    return row === null ? null : toReceipt(row);
  },
});

export const loadAction = internalQuery({
  args: { ownerId: v.string(), actionId: v.string() },
  handler: (ctx, { ownerId, actionId }): Promise<Doc<"actions">> => requireOwnedAction(ctx, ownerId, actionId),
});

export const loadForLog = internalQuery({
  args: { ownerId: v.string(), actionId: v.string() },
  handler: async (ctx, { ownerId, actionId }) => {
    const row = await requireOwnedAction(ctx, ownerId, actionId);
    return { row, destination: await loadLogDestination(ctx, ownerId, row.projectId) };
  },
});

export const receiptById = internalQuery({
  args: { actionId: v.id("actions") },
  returns: receipt,
  handler: async (ctx, { actionId }) => toReceipt((await ctx.db.get(actionId))!),
});

export const unknownForSource = internalQuery({
  args: { ownerId: v.string(), sourceId: v.string() },
  handler: async (ctx, { ownerId, sourceId }): Promise<Doc<"actions">[]> => {
    const rows = await ctx.db
      .query("actions")
      .withIndex("by_source_state", (q) => q.eq("sourceId", sourceId).eq("state", "unknown"))
      .collect();
    return rows.filter((row) => row.ownerId === ownerId);
  },
});

export const setLogState = internalMutation({
  args: { actionId: v.id("actions"), logState: v.union(v.literal("pending"), v.literal("written"), v.literal("failed")) },
  returns: v.null(),
  handler: async (ctx, { actionId, logState }) => {
    const row = await ctx.db.get(actionId);
    if (row !== null && row.logState !== "written") await ctx.db.patch(actionId, { logState });
    return null;
  },
});

// ---- Send consent (separate from the read connection).

export const saveSendPermission = internalMutation({
  args: { ownerId: v.string(), sourceId: v.string(), provider: v.string(), credential: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const grant = await ctx.db
      .query("grants")
      .withIndex("by_source", (q) => q.eq("id", args.sourceId))
      .unique();
    if (grant === null || grant.ownerId !== args.ownerId || grant.kind !== args.provider) {
      throw new ConvexError("Source is not available");
    }
    const existing = await ctx.db
      .query("sendPermissions")
      .withIndex("by_source", (q) => q.eq("sourceId", args.sourceId))
      .unique();
    if (existing === null) await ctx.db.insert("sendPermissions", args);
    else await ctx.db.replace(existing._id, args);
    return null;
  },
});

/** Sealed send credential for internal provider code only; null without send consent. */
export const sendCredential = internalQuery({
  args: { sourceId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { sourceId }) => {
    const row = await ctx.db
      .query("sendPermissions")
      .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
      .unique();
    return row?.credential ?? null;
  },
});

/** Microsoft rotates refresh tokens; the new one replaces the old. */
export const rotateSendCredential = internalMutation({
  args: { sourceId: v.string(), credential: v.string() },
  returns: v.null(),
  handler: async (ctx, { sourceId, credential }) => {
    const row = await ctx.db
      .query("sendPermissions")
      .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
      .unique();
    if (row !== null) await ctx.db.patch(row._id, { credential });
    return null;
  },
});
