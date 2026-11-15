// TARS on Telegram, through a bot. The linked chat is the only identity that can instruct TARS by
// message: proven by the webhook's secret header (set when the webhook is registered) plus the stored
// link, made once with a short code he sees in the signed-in app. His message is his instruction,
// exactly like typing in the app: a project message goes through the chat's own path (thread.chatAs),
// anything else through brain-dump sorting. Inbound text is never stored as evidence. Only an exact
// SEND sends, through thread.sendAs. What goes to the phone follows the recap's rule: titles only, no
// draft text, no source excerpts, no other person's address except the recipient of an approval he
// asked for. One message per key, no retries.
import { ConvexError, v } from "convex/values";
import { z } from "zod";
import { recapText } from "../packages/domain/src/recap";
import { dueLabel, phoneHtml, type Block } from "../packages/domain/src/thread";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, httpAction, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { sortAs } from "./captures";
import { requireOwnerId } from "./lib/auth";
import { ModelError, generateStructured } from "./lib/model";
import { issueOAuthState, takeOAuthState } from "./lib/providerAuth";
import { buildRecap } from "./recap";
import { chatAs, sendAs } from "./thread";

export const TELEGRAM_PATH = "/telegram/webhook";
const PROVIDER = "telegram";
const CODE = /^TARS-[A-Z0-9]{6}$/;
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O or 1/I/L to misread
const MAX_BODY = 3_500; // Telegram allows 4,096 characters
type Ctx = Pick<QueryCtx, "db">;

const botName = () => process.env.TELEGRAM_BOT_NAME || null; // the bot's @username, shown so he knows where to send the code
const linkOf = (ctx: Ctx, ownerId: string) =>
  ctx.db
    .query("telegramLinks")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();

// ---- The card.

const outboxState = v.union(v.literal("waiting"), v.literal("queued"), v.literal("sent"), v.literal("failed"));

export const status = query({
  args: {},
  returns: v.object({
    bot: v.union(v.string(), v.null()),
    linked: v.boolean(),
    last: v.union(v.null(), v.object({ state: outboxState, at: v.number() })),
  }),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const link = await linkOf(ctx, ownerId);
    const last = (
      await ctx.db
        .query("telegramOutbox")
        .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId))
        .collect()
    )
      .filter((row) => row.state !== "waiting")
      .sort((a, b) => b.at - a.at)[0];
    return {
      bot: botName(),
      linked: link !== null,
      last: link && last ? { state: last.state, at: last.at } : null,
    };
  },
});

/** A one-time code for the signed-in owner to send from Telegram: single use, 10 minutes. */
export const startLink = mutation({
  args: {},
  returns: v.object({ code: v.string() }),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = `TARS-${Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")}`;
    await issueOAuthState(ctx, ownerId, PROVIDER, code);
    return { code };
  },
});

export const unlink = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const link = await linkOf(ctx, await requireOwnerId(ctx));
    if (link !== null) await ctx.db.delete(link._id);
    return null;
  },
});

export const sendTest = action({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const ownerId = await requireOwnerId(ctx);
    const queued: boolean = await ctx.runMutation(internal.telegram.queue, {
      ownerId,
      key: `test:${Date.now()}`,
      body: "This is a test from TARS. Message me here any time to tell me what to do.",
    });
    if (!queued) throw new ConvexError("Link your phone first");
    return null;
  },
});

// ---- Outbound: one message per key, to the linked phone only.

/** Queue one message to the owner's linked phone. False when there is no link or the key already went. */
const phoneLinks = v.array(v.object({ label: v.string(), url: v.string() }));
type PhoneLink = { label: string; url: string };

export async function queueMessage(ctx: MutationCtx, ownerId: string, key: string, body: string, links: PhoneLink[] = []): Promise<boolean> {
  if ((await linkOf(ctx, ownerId)) === null) return false;
  const existing = await ctx.db
    .query("telegramOutbox")
    .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
    .unique();
  if (existing !== null && existing.state !== "waiting") return false;
  const at = Date.now();
  const id = existing?._id ?? (await ctx.db.insert("telegramOutbox", { ownerId, key, state: "queued", at }));
  if (existing !== null) await ctx.db.patch(id, { state: "queued", at });
  await ctx.scheduler.runAfter(0, internal.telegram.deliver, { outboxId: id, body, links });
  return true;
}

export const queue = internalMutation({
  args: { ownerId: v.string(), key: v.string(), body: v.string() },
  returns: v.boolean(),
  handler: (ctx, { ownerId, key, body }) => queueMessage(ctx, ownerId, key, body),
});

export const loadDelivery = internalQuery({
  args: { outboxId: v.id("telegramOutbox") },
  returns: v.union(v.null(), v.object({ chatId: v.string() })),
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.db.get(outboxId);
    const link = row === null || row.state !== "queued" ? null : await linkOf(ctx, row.ownerId);
    return link === null ? null : { chatId: link.chatId };
  },
});

export const recordDelivery = internalMutation({
  args: { outboxId: v.id("telegramOutbox"), state: outboxState, code: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { outboxId, state, code }) => {
    if ((await ctx.db.get(outboxId)) === null) return null;
    await ctx.db.patch(outboxId, { state, at: Date.now(), ...(code === undefined ? {} : { code }) });
    return null;
  },
});

/** One POST to the bot's sendMessage. Every outcome is recorded once: sent or failed (with Telegram's own words). Never retried, no timer. */
export const deliver = internalAction({
  args: { outboxId: v.id("telegramOutbox"), body: v.string(), links: phoneLinks },
  returns: v.null(),
  handler: async (ctx, { outboxId, body, links }): Promise<null> => {
    const target: { chatId: string } | null = await ctx.runQuery(internal.telegram.loadDelivery, { outboxId });
    const record = (state: "sent" | "failed", code?: string) => ctx.runMutation(internal.telegram.recordDelivery, { outboxId, state, ...(code === undefined ? {} : { code }) });
    if (target === null) return record("failed", "not_linked");
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return record("failed", "not_configured");
    let response: Response;
    try {
      // The words are escaped before any mark is added (phoneHtml), so nothing in a message can break its own formatting.
      response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: target.chatId,
          text: phoneHtml(body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body, links),
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return record("failed", "network");
    }
    const reply = (await response.json().catch(() => ({}))) as { ok?: unknown; error_code?: unknown; description?: unknown };
    if (response.ok && reply.ok === true) return record("sent");
    return record("failed", `${String(reply.error_code ?? `http_${response.status}`)}${typeof reply.description === "string" ? `: ${reply.description.slice(0, 120)}` : ""}`);
  },
});

/** One-time setup, run by hand after the bot's token is set: tell Telegram where his messages go and which secret header proves they came from it. */
export const register = internalAction({
  args: {},
  returns: v.string(),
  handler: async (): Promise<string> => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const site = process.env.CONVEX_SITE_URL;
    if (!token || !secret || !site) return "not_configured";
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `${site}${TELEGRAM_PATH}`, secret_token: secret, allowed_updates: ["message"] }),
      signal: AbortSignal.timeout(10_000),
    });
    const reply = (await response.json().catch(() => ({}))) as { ok?: unknown; description?: unknown };
    return reply.ok === true ? "registered" : `failed: ${String(reply.description ?? response.status).slice(0, 120)}`;
  },
});

// ---- What TARS says to the phone.

/** A nudge offer just opened for a newly seen due commitment: its title and due time, nothing else. */
export async function queueNudge(ctx: MutationCtx, ownerId: string, key: string, title: string, dueAt: string | undefined, started: boolean) {
  const settings = await ctx.db
    .query("attentionSettings")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
  const due = settings && dueAt !== undefined ? ` It's due ${dueLabel(dueAt, settings.timezone)}.` : "";
  const lead = started ? `I started “${title}” for you while you were busy.` : `“${title}” is ready for you.`;
  await queueMessage(ctx, ownerId, `nudge:${key}`, `${lead}${due} Open TARS or reply here.`);
}

/** His explicit "Stop for now": today's recap, item titles only, once per stop. */
export async function queueRecap(ctx: MutationCtx, ownerId: string, stopId: Id<"sessionEvents">) {
  if ((await linkOf(ctx, ownerId)) === null) return;
  const settings = await ctx.db
    .query("attentionSettings")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
  await queueMessage(ctx, ownerId, `recap:${stopId}`, recapText(await buildRecap(ctx, ownerId, settings?.timezone ?? "UTC")));
}

const OUTCOME_TEXT = {
  succeeded: (what: string, to: string) => `Done: ${what} went to ${to}, and I checked it arrived.`,
  failed: (what: string, to: string) => `Not done: ${what} did not send to ${to}. Open TARS to see what stopped it.`,
  unknown: (what: string, to: string) => `I sent ${what} to ${to} but could not confirm it arrived. Open TARS to check again; I will not resend it on my own.`,
};

/** In the transaction that settles a send, wherever he approved it (the app's button or SEND here): one message. */
export async function reportSendOutcome(ctx: MutationCtx, row: Doc<"actions">, state: keyof typeof OUTCOME_TEXT) {
  await queueMessage(ctx, row.ownerId, `send:${row._id}`, OUTCOME_TEXT[state](row.subject ? `“${row.subject}”` : "it", row.destination));
}

/** The run's morning message for his phone: once per day's key, only to a linked phone. */
export const queueBrief = internalMutation({
  args: { ownerId: v.string(), key: v.string(), body: v.string(), links: phoneLinks },
  returns: v.boolean(),
  handler: (ctx, { ownerId, key, body, links }) => queueMessage(ctx, ownerId, `brief:${key}`, body, links),
});

export const isLinked = async (ctx: Pick<QueryCtx, "db">, ownerId: string) => (await linkOf(ctx, ownerId)) !== null;

type Approval = Extract<Block, { type: "approval" }>["props"];

function approvalText(a: Approval): string {
  if (a.recipient === "") return `“${a.document}” is ready, but there is no recipient yet. Open TARS to add one.`;
  const to = a.recipientName ? `${a.recipientName} <${a.recipient}>` : a.recipient;
  const what = a.form === "reply" ? `“${a.document}” as a reply by email` : `“${a.document}” as a Word document link by email`;
  return `Ready to send ${what} to ${to}, subject “${a.replySubject}”.\nReply SEND to send it, or NOT YET to hold it.`;
}

/** TARS's reply blocks as short plain text: what it did, what it said or asks, and any approval. */
function replyText(project: string, blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "work") {
      const failed = b.props.steps.find((s) => s.status === "failed");
      if (failed) parts.push(`I could not finish that: ${failed.error ?? "it stopped"}.`);
    } else if (b.type === "document" && b.props.changeSummary !== undefined) {
      parts.push(`Revised “${b.props.title}” to revision ${b.props.revision}.`);
    } else if (b.type === "say") {
      parts.push(b.props.text);
    } else if (b.type === "approval") {
      parts.push(approvalText(b.props));
    }
  }
  return `${project}: ${parts.join("\n") || "Done."}`;
}

// ---- Inbound.

const UpdateSchema = z.object({
  update_id: z.number(),
  message: z.object({ chat: z.object({ id: z.number(), type: z.string() }), text: z.string().optional() }).optional(),
});

const sameSecret = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** POST /telegram/webhook: check Telegram's secret header, answer at once, do the work in a scheduled action. Only a private chat's text goes on. */
export const inbound = httpAction(async (ctx, request) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !sameSecret(request.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) return new Response("Forbidden", { status: 403 });
  const update = UpdateSchema.safeParse(await request.json().catch(() => null));
  if (update.success && update.data.message?.chat.type === "private") {
    const { chat, text } = update.data.message;
    await ctx.runMutation(internal.telegram.accept, { from: String(chat.id), messageSid: String(update.data.update_id), text: (text ?? "").trim() });
  }
  return new Response("ok", { status: 200 });
});

/** Drop redeliveries; link on a valid code; otherwise only a linked phone's message goes on, to its owner. */
export const accept = internalMutation({
  args: { from: v.string(), messageSid: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, { from, messageSid, text }) => {
    const seen = await ctx.db
      .query("telegramInbound")
      .withIndex("by_sid", (q) => q.eq("messageSid", messageSid))
      .first();
    if (seen !== null) return null;
    await ctx.db.insert("telegramInbound", { messageSid, at: Date.now() });

    const code = text.toUpperCase();
    if (CODE.test(code)) {
      const bound = await takeOAuthState(ctx, code);
      if (bound?.provider !== PROVIDER) return null; // wrong, used or expired: nothing is linked
      for (const old of [await linkOf(ctx, bound.ownerId), ...(await ctx.db.query("telegramLinks").withIndex("by_chat", (q) => q.eq("chatId", from)).collect())]) {
        if (old !== null) await ctx.db.delete(old._id); // one chat per owner, one owner per chat
      }
      await ctx.db.insert("telegramLinks", { ownerId: bound.ownerId, chatId: from, linkedAt: Date.now() });
      await queueMessage(ctx, bound.ownerId, `reply:${messageSid}`, "Linked. Message me here about any project, or dump whatever is on your mind.");
      return null;
    }

    const link = await ctx.db
      .query("telegramLinks")
      .withIndex("by_chat", (q) => q.eq("chatId", from))
      .unique();
    if (link === null) return null;
    if (text === "" || text.startsWith("/start")) return null; // media only, or Telegram's own first message to a bot
    await ctx.scheduler.runAfter(0, internal.telegram.handle, { ownerId: link.ownerId, messageSid, text });
    return null;
  },
});

export const projects = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.object({ id: v.string(), name: v.string() })),
  handler: async (ctx, { ownerId }) =>
    (
      await ctx.db
        .query("projects")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .collect()
    ).map((p) => ({ id: p._id as string, name: p.name })),
});

export const replyBlocks = internalQuery({
  args: { ownerId: v.string(), messageId: v.id("threadMessages") },
  returns: v.array(v.any()),
  handler: async (ctx, { ownerId, messageId }) => {
    const row = await ctx.db.get(messageId);
    return row === null || row.ownerId !== ownerId ? [] : row.blocks;
  },
});

export const sortedLines = internalQuery({
  args: { ownerId: v.string(), captureId: v.string() },
  returns: v.array(v.object({ text: v.string(), project: v.union(v.string(), v.null()) })),
  handler: async (ctx, { ownerId, captureId }) => {
    const rows = await ctx.db
      .query("captureItems")
      .withIndex("by_owner_capture", (q) => q.eq("ownerId", ownerId).eq("captureId", captureId))
      .collect();
    const out = [];
    for (const row of rows) {
      const id = row.projectId === undefined ? null : ctx.db.normalizeId("projects", row.projectId);
      out.push({ text: row.text, project: (id === null ? null : (await ctx.db.get(id))?.name) ?? null });
    }
    return out;
  },
});

/**
 * The newest approval in any of his projects, only if it is still open, with the draft's current
 * revision. An older open approval never answers a SEND.
 */
export const newestApproval = internalQuery({
  args: { ownerId: v.string() },
  returns: v.union(v.null(), v.object({ approval: v.any(), currentRevision: v.union(v.string(), v.null()) })),
  handler: async (ctx, { ownerId }) => {
    const messages = await ctx.db
      .query("threadMessages")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId))
      .collect();
    const newest = messages
      .filter((m) => m.blocks.some((b) => b.type === "approval"))
      .sort((a, b) => b.createdAt - a.createdAt || b._creationTime - a._creationTime)[0];
    const approval = newest?.blocks.findLast((b) => b.type === "approval")?.props as Approval | undefined;
    if (approval === undefined || approval.state !== "open") return null;
    const id = ctx.db.normalizeId("artifacts", approval.artifactId);
    const artifact = id === null ? null : await ctx.db.get(id);
    return { approval, currentRevision: artifact?.ownerId === ownerId ? artifact.revision : null };
  },
});

const RouteSchema = z.strictObject({ projectId: z.string().nullable() });
const ROUTE_INSTRUCTIONS = [
  "You route one Telegram message the user sent to their own assistant, TARS. input.message is the user's own words.",
  "projectId: the id from input.projects when the message is clearly about that one project (asks to change, send or explain its draft, or asks about it). Otherwise null: a brain dump, a list of thoughts, several projects, or none. Never invent an id.",
].join("\n");

/** His exact SEND: the newest approval, still open and still the current revision, goes out through the chat's send. */
async function confirmSend(ctx: ActionCtx, ownerId: string): Promise<string | null> {
  const found: { approval: Approval; currentRevision: string | null } | null = await ctx.runQuery(internal.telegram.newestApproval, { ownerId });
  if (found === null) return "There is nothing waiting for your SEND, so nothing was sent.";
  const { approval } = found;
  if (found.currentRevision !== approval.revision) return `“${approval.document}” changed after I asked, so nothing was sent. Ask me to send it again.`;
  if (approval.recipient === "") return approvalText(approval);
  const result = await sendAs(ctx, ownerId, {
    projectId: approval.projectId,
    artifactId: approval.artifactId,
    revision: approval.revision,
    commitmentKey: approval.commitmentKey,
    recipient: approval.recipient,
  });
  if ("actionId" in result) return null; // one message when the send settles (reportSendOutcome)
  if (result.status === "missing-send-permission") return "Sending from Gmail hasn't been allowed yet. Allow it in TARS under Connections → Gmail, then reply SEND again.";
  return `${result.reason} Nothing was sent.`;
}

/** One message from the linked phone, owner resolved from the stored link by `accept`. */
export const handle = internalAction({
  args: { ownerId: v.string(), messageSid: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId, messageSid, text }): Promise<null> => {
    const reply = async (body: string | null) => {
      if (body !== null) await ctx.runMutation(internal.telegram.queue, { ownerId, key: `reply:${messageSid}`, body });
      return null;
    };
    if (/^send$/i.test(text)) return reply(await confirmSend(ctx, ownerId));
    if (/^not yet$/i.test(text)) return reply("Held. Nothing was sent.");

    const list: { id: string; name: string }[] = await ctx.runQuery(internal.telegram.projects, { ownerId });
    let projectId: string | null;
    try {
      // JSON keeps his words inside one string value.
      ({ projectId } = await generateStructured({ name: "telegram_route", schema: RouteSchema, instructions: ROUTE_INSTRUCTIONS, input: JSON.stringify({ projects: list, message: text }) }));
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      return reply(`I could not read that just now (${error.code}). Try again in a minute.`);
    }
    const project = list.find((p) => p.id === projectId);
    if (project !== undefined) {
      const messageId = await chatAs(ctx, ownerId, project.id, text.slice(0, 2_000));
      const blocks = (await ctx.runQuery(internal.telegram.replyBlocks, { ownerId, messageId })) as Block[]; // stored only through block()
      return reply(replyText(project.name, blocks));
    }
    const captureId = `telegram:${messageSid}`;
    const sorted = await sortAs(ctx, ownerId, captureId, text);
    if (sorted.status === "failed") return reply(`I could not sort that just now (${sorted.code}). Try again in a minute.`);
    const lines: { text: string; project: string | null }[] = await ctx.runQuery(internal.telegram.sortedLines, { ownerId, captureId });
    return reply([`Sorted into ${lines.length} ${lines.length === 1 ? "line" : "lines"}:`, ...lines.map((l) => `- ${l.text}${l.project ? ` (${l.project})` : ""}`)].join("\n"));
  },
});
