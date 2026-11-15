// TARS on WhatsApp, through Twilio. The linked phone is the only identity that can instruct TARS by
// message: proven by Twilio's X-Twilio-Signature plus the stored link, made once with a short code he
// sees in the signed-in app. His message is his instruction, exactly like typing in the app: a project
// message goes through the chat's own path (thread.chatAs), anything else through brain-dump sorting.
// Inbound text is never stored as evidence. Only an exact SEND sends, through thread.sendAs. What goes
// to the phone follows the recap's rule: titles only, no draft text, no source excerpts, no other
// person's address except the recipient of an approval he asked for. One message per key, no retries.
import { ConvexError, v } from "convex/values";
import { z } from "zod";
import { recapText } from "../packages/domain/src/recap";
import { dueLabel, type Block } from "../packages/domain/src/thread";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, httpAction, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { sortAs } from "./captures";
import { requireOwnerId } from "./lib/auth";
import { ModelError, generateStructured } from "./lib/model";
import { issueOAuthState, takeOAuthState, verifyTwilioSignature } from "./lib/providerAuth";
import { buildRecap } from "./recap";
import { chatAs, sendAs } from "./thread";

export const WHATSAPP_PATH = "/twilio/whatsapp";
export const STATUS_PATH = "/twilio/whatsapp/status";
const PROVIDER = "whatsapp";
const CODE = /^TARS-[A-Z0-9]{6}$/;
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O or 1/I/L to misread
const MAX_BODY = 1_000; // Twilio allows 1,600; a phone screen wants far less
const WINDOW_CODES = new Set(["63016"]); // "Outside messaging window": the 24-hour session lapsed
type Ctx = Pick<QueryCtx, "db">;

const sandboxNumber = () => process.env.TWILIO_WHATSAPP_FROM?.replace(/^whatsapp:/, "") || null;
const linkOf = (ctx: Ctx, ownerId: string) =>
  ctx.db
    .query("whatsappLinks")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();

// ---- The card.

const outboxState = v.union(v.literal("waiting"), v.literal("queued"), v.literal("sent"), v.literal("refused"), v.literal("failed"));

export const status = query({
  args: {},
  returns: v.object({
    sandbox: v.union(v.string(), v.null()),
    linked: v.boolean(),
    phone: v.union(v.string(), v.null()),
    windowClosed: v.boolean(),
    last: v.union(v.null(), v.object({ state: outboxState, at: v.number() })),
  }),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const link = await linkOf(ctx, ownerId);
    const last = (
      await ctx.db
        .query("whatsappOutbox")
        .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId))
        .collect()
    )
      .filter((row) => row.state !== "waiting")
      .sort((a, b) => b.at - a.at)[0];
    return {
      sandbox: sandboxNumber(),
      linked: link !== null,
      phone: link?.phone.replace(/^whatsapp:/, "") ?? null,
      windowClosed: link?.windowClosedAt !== undefined,
      last: link && last ? { state: last.state, at: last.at } : null,
    };
  },
});

/** A one-time code for the signed-in owner to send from WhatsApp: single use, 10 minutes. */
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
    const queued: boolean = await ctx.runMutation(internal.whatsapp.queue, {
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
export async function queueMessage(ctx: MutationCtx, ownerId: string, key: string, body: string): Promise<boolean> {
  if ((await linkOf(ctx, ownerId)) === null) return false;
  const existing = await ctx.db
    .query("whatsappOutbox")
    .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
    .unique();
  if (existing !== null && existing.state !== "waiting") return false;
  const at = Date.now();
  const id = existing?._id ?? (await ctx.db.insert("whatsappOutbox", { ownerId, key, state: "queued", at }));
  if (existing !== null) await ctx.db.patch(id, { state: "queued", at });
  await ctx.scheduler.runAfter(0, internal.whatsapp.deliver, { outboxId: id, body });
  return true;
}

export const queue = internalMutation({
  args: { ownerId: v.string(), key: v.string(), body: v.string() },
  returns: v.boolean(),
  handler: (ctx, { ownerId, key, body }) => queueMessage(ctx, ownerId, key, body),
});

export const loadDelivery = internalQuery({
  args: { outboxId: v.id("whatsappOutbox") },
  returns: v.union(v.null(), v.object({ phone: v.string() })),
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.db.get(outboxId);
    const link = row === null || row.state !== "queued" ? null : await linkOf(ctx, row.ownerId);
    return link === null ? null : { phone: link.phone };
  },
});

export const recordDelivery = internalMutation({
  args: { outboxId: v.id("whatsappOutbox"), state: outboxState, twilioSid: v.optional(v.string()), code: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { outboxId, state, twilioSid, code }) => {
    const row = await ctx.db.get(outboxId);
    if (row === null) return null;
    await ctx.db.patch(outboxId, { state, at: Date.now(), ...(twilioSid === undefined ? {} : { twilioSid }), ...(code === undefined ? {} : { code }) });
    if (state === "refused") await closeWindow(ctx, row.ownerId);
    return null;
  },
});

async function closeWindow(ctx: MutationCtx, ownerId: string) {
  const link = await linkOf(ctx, ownerId);
  if (link !== null) await ctx.db.patch(link._id, { windowClosedAt: Date.now() });
}

/**
 * One POST to Twilio's Messages API. Every outcome is recorded once: sent (with Twilio's sid, for its
 * status callback), refused (outside the 24-hour window) or failed. Never retried, no timer.
 */
export const deliver = internalAction({
  args: { outboxId: v.id("whatsappOutbox"), body: v.string() },
  returns: v.null(),
  handler: async (ctx, { outboxId, body }): Promise<null> => {
    const target: { phone: string } | null = await ctx.runQuery(internal.whatsapp.loadDelivery, { outboxId });
    const record = (state: "sent" | "refused" | "failed", extra: { twilioSid?: string; code?: string } = {}) =>
      ctx.runMutation(internal.whatsapp.recordDelivery, { outboxId, state, ...extra });
    if (target === null) return record("failed", { code: "not_linked" });
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_WHATSAPP_FROM;
    const site = process.env.CONVEX_SITE_URL;
    if (!sid || !token || !from || !site) return record("failed", { code: "not_configured" });
    let response: Response;
    try {
      response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          From: from.startsWith("whatsapp:") ? from : `whatsapp:${from}`,
          To: target.phone,
          Body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body,
          StatusCallback: `${site}${STATUS_PATH}`,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return record("failed", { code: "network" });
    }
    const reply = (await response.json().catch(() => ({}))) as { sid?: unknown; code?: unknown; error_code?: unknown; status?: unknown };
    const code = String(reply.code ?? reply.error_code ?? "");
    if (!response.ok) return record(WINDOW_CODES.has(code) ? "refused" : "failed", { code: code || `http_${response.status}` });
    return record("sent", typeof reply.sid === "string" ? { twilioSid: reply.sid } : {});
  },
});

/** Twilio's later word on a sent message: a failure is recorded on its row (refused for the window). */
export const recordStatus = internalMutation({
  args: { twilioSid: v.string(), messageStatus: v.string(), errorCode: v.string() },
  returns: v.null(),
  handler: async (ctx, { twilioSid, messageStatus, errorCode }) => {
    if (messageStatus !== "failed" && messageStatus !== "undelivered") return null;
    // shortcut: a callback that beats deliver's own write of the sid finds no row and is dropped; Twilio's
    // first callback comes after queued->sent, well after that write, so upgrade only if one is ever lost.
    const row = await ctx.db
      .query("whatsappOutbox")
      .withIndex("by_twilio_sid", (q) => q.eq("twilioSid", twilioSid))
      .unique();
    if (row === null) return null;
    const refused = WINDOW_CODES.has(errorCode);
    await ctx.db.patch(row._id, { state: refused ? "refused" : "failed", code: errorCode || messageStatus, at: Date.now() });
    if (refused) await closeWindow(ctx, row.ownerId);
    return null;
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
  succeeded: (to: string) => `Sent to ${to} · checked: it arrived.`,
  failed: (to: string) => `It did not send to ${to}. Open TARS to see what stopped it.`,
  unknown: (to: string) => `I sent it to ${to} but could not confirm it arrived. Open TARS to check again; I will not resend it on my own.`,
};

/** In the transaction that settles a send, wherever he approved it (the app's button or SEND here): one message. */
export async function reportSendOutcome(ctx: MutationCtx, row: Doc<"actions">, state: keyof typeof OUTCOME_TEXT) {
  await queueMessage(ctx, row.ownerId, `send:${row._id}`, OUTCOME_TEXT[state](row.destination));
}

/** The run's morning message for his phone: once per day's key, only to a linked phone. */
export const queueBrief = internalMutation({
  args: { ownerId: v.string(), key: v.string(), body: v.string() },
  returns: v.boolean(),
  handler: (ctx, { ownerId, key, body }) => queueMessage(ctx, ownerId, `brief:${key}`, body),
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

const twiml = () => new Response("<Response></Response>", { status: 200, headers: { "Content-Type": "text/xml" } });

/** The signed request's form parameters, or null. The URL is the one configured in Twilio: this deployment's site URL. */
async function signedParams(request: Request, path: string): Promise<URLSearchParams | null> {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const site = process.env.CONVEX_SITE_URL;
  if (!token || !site) return null;
  const params = new URLSearchParams(await request.text());
  const url = `${site}${path}${new URL(request.url).search}`;
  return (await verifyTwilioSignature(token, url, params, request.headers.get("x-twilio-signature") ?? "")) ? params : null;
}

/** POST /twilio/whatsapp: verify, answer at once with empty TwiML, do the work in a scheduled action. */
export const inbound = httpAction(async (ctx, request) => {
  const params = await signedParams(request, WHATSAPP_PATH);
  if (params === null) return new Response("Forbidden", { status: 403 });
  const from = params.get("From") ?? "";
  const messageSid = params.get("MessageSid") ?? "";
  if (from.startsWith("whatsapp:") && messageSid !== "") {
    await ctx.runMutation(internal.whatsapp.accept, { from, messageSid, text: (params.get("Body") ?? "").trim() });
  }
  return twiml();
});

/** POST /twilio/whatsapp/status: Twilio's status callback for messages TARS sent. */
export const statusCallback = httpAction(async (ctx, request) => {
  const params = await signedParams(request, STATUS_PATH);
  if (params === null) return new Response("Forbidden", { status: 403 });
  const twilioSid = params.get("MessageSid") ?? "";
  if (twilioSid !== "") {
    await ctx.runMutation(internal.whatsapp.recordStatus, { twilioSid, messageStatus: params.get("MessageStatus") ?? "", errorCode: params.get("ErrorCode") ?? "" });
  }
  return twiml();
});

/** Drop redeliveries; link on a valid code; otherwise only a linked phone's message goes on, to its owner. */
export const accept = internalMutation({
  args: { from: v.string(), messageSid: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, { from, messageSid, text }) => {
    const seen = await ctx.db
      .query("whatsappInbound")
      .withIndex("by_sid", (q) => q.eq("messageSid", messageSid))
      .first();
    if (seen !== null) return null;
    await ctx.db.insert("whatsappInbound", { messageSid, at: Date.now() });

    const code = text.toUpperCase();
    if (CODE.test(code)) {
      const bound = await takeOAuthState(ctx, code);
      if (bound?.provider !== PROVIDER) return null; // wrong, used or expired: nothing is linked
      for (const old of [await linkOf(ctx, bound.ownerId), ...(await ctx.db.query("whatsappLinks").withIndex("by_phone", (q) => q.eq("phone", from)).collect())]) {
        if (old !== null) await ctx.db.delete(old._id); // one phone per owner, one owner per phone
      }
      await ctx.db.insert("whatsappLinks", { ownerId: bound.ownerId, phone: from, linkedAt: Date.now() });
      await queueMessage(ctx, bound.ownerId, `reply:${messageSid}`, "Linked. Message me here about any project, or dump whatever is on your mind.");
      return null;
    }

    const link = await ctx.db
      .query("whatsappLinks")
      .withIndex("by_phone", (q) => q.eq("phone", from))
      .unique();
    if (link === null) return null;
    if (link.windowClosedAt !== undefined) await ctx.db.patch(link._id, { windowClosedAt: undefined }); // his message opens a new 24-hour window
    if (text === "" || /^join \S+$/i.test(text)) return null; // media only, or Twilio's sandbox join keyword
    await ctx.scheduler.runAfter(0, internal.whatsapp.handle, { ownerId: link.ownerId, messageSid, text });
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
  "You route one WhatsApp message the user sent to their own assistant, TARS. input.message is the user's own words.",
  "projectId: the id from input.projects when the message is clearly about that one project (asks to change, send or explain its draft, or asks about it). Otherwise null: a brain dump, a list of thoughts, several projects, or none. Never invent an id.",
].join("\n");

/** His exact SEND: the newest approval, still open and still the current revision, goes out through the chat's send. */
async function confirmSend(ctx: ActionCtx, ownerId: string): Promise<string | null> {
  const found: { approval: Approval; currentRevision: string | null } | null = await ctx.runQuery(internal.whatsapp.newestApproval, { ownerId });
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
      if (body !== null) await ctx.runMutation(internal.whatsapp.queue, { ownerId, key: `reply:${messageSid}`, body });
      return null;
    };
    if (/^send$/i.test(text)) return reply(await confirmSend(ctx, ownerId));
    if (/^not yet$/i.test(text)) return reply("Held. Nothing was sent.");

    const list: { id: string; name: string }[] = await ctx.runQuery(internal.whatsapp.projects, { ownerId });
    let projectId: string | null;
    try {
      // JSON keeps his words inside one string value.
      ({ projectId } = await generateStructured({ name: "whatsapp_route", schema: RouteSchema, instructions: ROUTE_INSTRUCTIONS, input: JSON.stringify({ projects: list, message: text }) }));
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      return reply(`I could not read that just now (${error.code}). Try again in a minute.`);
    }
    const project = list.find((p) => p.id === projectId);
    if (project !== undefined) {
      const messageId = await chatAs(ctx, ownerId, project.id, text.slice(0, 2_000));
      const blocks = (await ctx.runQuery(internal.whatsapp.replyBlocks, { ownerId, messageId })) as Block[]; // stored only through block()
      return reply(replyText(project.name, blocks));
    }
    const captureId = `whatsapp:${messageSid}`;
    const sorted = await sortAs(ctx, ownerId, captureId, text);
    if (sorted.status === "failed") return reply(`I could not sort that just now (${sorted.code}). Try again in a minute.`);
    const lines: { text: string; project: string | null }[] = await ctx.runQuery(internal.whatsapp.sortedLines, { ownerId, captureId });
    return reply([`Sorted into ${lines.length} ${lines.length === 1 ? "line" : "lines"}:`, ...lines.map((l) => `- ${l.text}${l.project ? ` (${l.project})` : ""}`)].join("\n"));
  },
});
