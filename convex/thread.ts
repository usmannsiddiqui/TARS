// The project chat. TARS speaks first when a run finds a request for the user in a new message;
// after that each user message starts a run in this project (convex/runs.ts).
// The user's chat text is his instruction; evidence is untrusted data and can never instruct. The
// model never fills an approval: the suggested recipient and subjects come from the asking mail's
// stored header fields (delivery.requesterFor), never from body text, and the user can change the
// recipient. Only `send`, the approval's primary action, sends: through delivery.approveAndSend.
import { ConvexError, v, type Infer } from "convex/values";
import { mailSubject } from "../packages/domain/src/actions";
import { deliveryMail, replyMail, type Requester } from "../packages/domain/src/delivery";
import { block, type Block, type Step } from "../packages/domain/src/thread";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { approveAs, requesterFor } from "./delivery";
import { requireOwnerId } from "./lib/auth";
import { requireOwnedProject } from "./memory";
import { answerChat } from "./runs";
import { threadBlocks } from "./schema";

const MAX_MESSAGE = 2_000;
type Ctx = Pick<QueryCtx, "db">;

const messageView = v.object({
  _id: v.id("threadMessages"),
  role: v.union(v.literal("tars"), v.literal("user")),
  text: v.optional(v.string()),
  blocks: threadBlocks,
  createdAt: v.number(),
});

const projectMessages = (ctx: Ctx, ownerId: string, projectId: string) =>
  ctx.db
    .query("threadMessages")
    .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
    .collect();

/** The project's thread, oldest first, for the chat to subscribe to. */
export const listThread = query({
  args: { projectId: v.string() },
  returns: v.array(messageView),
  handler: async (ctx, { projectId }) => {
    const ownerId = await requireOwnerId(ctx);
    await requireOwnedProject(ctx, ownerId, projectId);
    return (await projectMessages(ctx, ownerId, projectId)).map(({ _id, role, text, blocks, createdAt }) => ({
      _id,
      role,
      ...(text === undefined ? {} : { text }),
      blocks,
      createdAt,
    }));
  },
});

// ---- The user's turn.

const reading = (startedAt: number): Step => ({ id: "read", label: "Reading your message", doneLabel: "Read your message", status: "running", startedAt });

/** Store his message and TARS's running reply; returns the reply's id. */
export const postUser = internalMutation({
  args: { ownerId: v.string(), projectId: v.string(), text: v.string() },
  returns: v.id("threadMessages"),
  handler: async (ctx, { ownerId, projectId, text }) => {
    await requireOwnedProject(ctx, ownerId, projectId);
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE) throw new ConvexError(`A message is 1-${MAX_MESSAGE} characters`);
    const now = Date.now();
    const replyTo = await ctx.db.insert("threadMessages", { ownerId, projectId, role: "user", text: trimmed, blocks: [], createdAt: now });
    return await ctx.db.insert("threadMessages", { ownerId, projectId, role: "tars", replyTo, blocks: [block("work", "work", { steps: [reading(now)] })], createdAt: now });
  },
});

/** Try again: the failed reply runs again in place. */
export const restart = internalMutation({
  args: { ownerId: v.string(), messageId: v.id("threadMessages") },
  returns: v.null(),
  handler: async (ctx, { ownerId, messageId }) => {
    const row = await ctx.db.get(messageId);
    if (row === null || row.ownerId !== ownerId || row.role !== "tars" || row.replyTo === undefined) throw new ConvexError("Message not found");
    const now = Date.now();
    await ctx.db.patch(row._id, { blocks: [block("work", "work", { steps: [reading(now)] })], createdAt: now });
    return null;
  },
});

export const finishReply = internalMutation({
  args: { ownerId: v.string(), messageId: v.id("threadMessages"), blocks: threadBlocks },
  returns: v.null(),
  handler: async (ctx, { ownerId, messageId, blocks }) => {
    const row = await ctx.db.get(messageId);
    if (row === null || row.ownerId !== ownerId) throw new ConvexError("Message not found");
    await ctx.db.patch(row._id, { blocks });
    return null;
  },
});

const draftView = v.union(
  v.null(),
  v.object({ id: v.id("artifacts"), revision: v.string(), text: v.string(), title: v.string(), form: v.union(v.literal("document"), v.literal("reply")) }),
);
const requesterView = v.union(v.null(), v.object({ name: v.optional(v.string()), address: v.string(), subject: v.optional(v.string()) }));

/** The project's current draft, the due commitment TARS started from, and who asked (header fields only). */
async function approvalContext(ctx: Ctx, ownerId: string, projectId: string) {
  const artifact = await ctx.db
    .query("artifacts")
    .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
    .unique();
  const prepared = await ctx.db
    .query("preparedWork")
    .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
    .unique();
  const commitmentKey = (await projectMessages(ctx, ownerId, projectId)).findLast((m) => m.commitmentKey !== undefined)?.commitmentKey ?? "";
  return {
    artifact: artifact && {
      id: artifact._id,
      revision: artifact.revision,
      text: artifact.text,
      title: artifact.title ?? prepared?.work?.title ?? "Your draft",
      form: artifact.form ?? ("document" as const),
    },
    commitmentKey,
    requester: commitmentKey === "" ? null : await requesterFor(ctx, ownerId, projectId, commitmentKey),
  };
}
type ApprovalContext = Awaited<ReturnType<typeof approvalContext>>;

/** Exactly what `send` would do, from stored data: the subjects are the ones delivery's mail will carry. */
export function approvalBlock(projectId: string, artifact: NonNullable<ApprovalContext["artifact"]>, commitmentKey: string, requester: Requester | null): Block {
  const fallbackSubject = mailSubject(artifact.text).replace(/^#+\s*/, "");
  const mail = (replyTo?: string) => {
    const args = { fallbackSubject, ...(replyTo === undefined ? {} : { replyTo }) };
    return (artifact.form === "reply" ? replyMail({ text: artifact.text, ...args }) : deliveryMail({ filename: "", link: "", ...args })).subject;
  };
  return block("approval", "approval", {
    projectId,
    artifactId: artifact.id,
    revision: artifact.revision,
    commitmentKey,
    recipient: requester?.address ?? "",
    ...(requester?.name ? { recipientName: requester.name } : {}),
    replySubject: mail(requester?.subject),
    subject: mail(),
    document: artifact.title,
    form: artifact.form,
    primary: "Send it",
    secondary: "Not yet",
    state: "open",
  });
}

const answerContext = v.object({
  projectId: v.string(),
  text: v.string(),
  startedAt: v.number(),
  artifact: draftView,
  commitmentKey: v.string(),
  requester: requesterView,
});

export const loadAnswerContext = internalQuery({
  args: { ownerId: v.string(), messageId: v.id("threadMessages") },
  returns: answerContext,
  handler: async (ctx, { ownerId, messageId }): Promise<Infer<typeof answerContext>> => {
    const reply = await ctx.db.get(messageId);
    const asked = reply?.replyTo === undefined ? null : await ctx.db.get(reply.replyTo);
    if (reply === null || reply.ownerId !== ownerId || asked === null || asked.ownerId !== ownerId) throw new ConvexError("Message not found");
    const { projectId } = reply;
    await requireOwnedProject(ctx, ownerId, projectId);
    return { projectId, text: asked.text ?? "", startedAt: reply.createdAt, ...(await approvalContext(ctx, ownerId, projectId)) };
  },
});

/**
 * His message to a project, from the app's chat or his linked Telegram: stored, then answered by a
 * run (runs.answerChat). Returns TARS's reply message. The caller resolves `ownerId` from a verified identity.
 */
export async function chatAs(ctx: ActionCtx, ownerId: string, projectId: string, text: string): Promise<Id<"threadMessages">> {
  const messageId: Id<"threadMessages"> = await ctx.runMutation(internal.thread.postUser, { ownerId, projectId, text });
  await answerChat(ctx, ownerId, messageId);
  return messageId;
}

export const sendMessage = action({
  args: { projectId: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, text }): Promise<null> => {
    await chatAs(ctx, await requireOwnerId(ctx), projectId, text);
    return null;
  },
});

/** Try again on a failed reply. */
export const retry = action({
  args: { messageId: v.id("threadMessages") },
  returns: v.null(),
  handler: async (ctx, { messageId }): Promise<null> => {
    const ownerId = await requireOwnerId(ctx);
    await ctx.runMutation(internal.thread.restart, { ownerId, messageId });
    await answerChat(ctx, ownerId, messageId);
    return null;
  },
});

const MISSING_SEND_PERMISSION = "Sending from Gmail hasn't been allowed yet. Allow it below, then press Send it.";
const NO_GMAIL = "Sending from Gmail hasn't been allowed yet, and this project has no Gmail connected through Composio. Connect Gmail in Connections, then ask me to send it again.";

/**
 * The project's Gmail sources that can send the document: active grants for this project whose
 * connection is through Composio (the only route delivery sends a document by).
 */
export const gmailSenders = internalQuery({
  args: { ownerId: v.string(), projectId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { ownerId, projectId }) => {
    const grants = (await ctx.db.query("grants").collect()).filter(
      (g) => g.ownerId === ownerId && g.state === "active" && g.kind === "gmail" && g.projectIds.includes(projectId),
    );
    const out = [];
    for (const grant of grants) {
      const connection = await ctx.db
        .query("connections")
        .withIndex("by_source", (q) => q.eq("sourceId", grant.id))
        .unique();
      if (connection?.broker === "composio" && connection.ownerId === ownerId) out.push(grant.id);
    }
    return out;
  },
});

export const loadApprovalContext = internalQuery({
  args: { ownerId: v.string(), projectId: v.string() },
  returns: v.object({ artifact: draftView, commitmentKey: v.string(), requester: requesterView }),
  handler: async (ctx, { ownerId, projectId }) => {
    await requireOwnedProject(ctx, ownerId, projectId);
    return approvalContext(ctx, ownerId, projectId);
  },
});

/** A TARS message with these blocks. */
export const postReply = internalMutation({
  args: { ownerId: v.string(), projectId: v.string(), blocks: threadBlocks },
  returns: v.null(),
  handler: async (ctx, { ownerId, projectId, blocks }) => {
    await requireOwnedProject(ctx, ownerId, projectId);
    await ctx.db.insert("threadMessages", { ownerId, projectId, role: "tars", blocks, createdAt: Date.now() });
    return null;
  },
});

/** The send is reserved: the approval reads approved and the thread follows this action (once per action). */
export const recordSend = internalMutation({
  args: { ownerId: v.string(), projectId: v.string(), artifactId: v.string(), revision: v.string(), actionId: v.string(), recipient: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId, projectId, artifactId, revision, actionId, recipient }) => {
    const messages = await projectMessages(ctx, ownerId, projectId);
    const isOpen = (b: Doc<"threadMessages">["blocks"][number]) =>
      b.type === "approval" && b.props?.artifactId === artifactId && b.props?.revision === revision && b.props?.state === "open";
    for (const m of messages.filter((m) => m.blocks.some(isOpen))) {
      await ctx.db.patch(m._id, { blocks: m.blocks.map((b) => (isOpen(b) ? { ...b, props: { ...b.props, state: "approved" } } : b)) });
    }
    if (messages.some((m) => m.blocks.some((b) => b.type === "delivery" && b.props?.actionId === actionId))) return null;
    await ctx.db.insert("threadMessages", { ownerId, projectId, role: "tars", blocks: [block("delivery", "delivery", { actionId, recipient })], createdAt: Date.now() });
    return null;
  },
});

export type SendResult = { actionId: string } | { status: "needs-clarification"; reason: string } | { status: "missing-send-permission" };
type SendArgs = { projectId: string; artifactId: string; revision: string; commitmentKey: string; recipient: string };

/**
 * THE SEND: the approval's primary action, and the only way the chat sends. A Word document of
 * exactly `revision`, as a link (or, for a reply, that revision's text as the email), to the recipient as the user left the field (delivery.approveAndSend
 * binds and verifies it, and never sends the same revision to the same address twice). A missing send
 * permission or a needed clarification is answered in the thread in plain words.
 */
export const send = action({
  args: { projectId: v.string(), artifactId: v.string(), revision: v.string(), commitmentKey: v.string(), recipient: v.string() },
  returns: v.union(
    v.object({ actionId: v.string() }),
    v.object({ status: v.literal("needs-clarification"), reason: v.string() }),
    v.object({ status: v.literal("missing-send-permission") }),
  ),
  handler: async (ctx, args): Promise<SendResult> => sendAs(ctx, await requireOwnerId(ctx), args),
});

/** The send itself: the approval's button in the app, or his exact SEND from the linked phone. */
export async function sendAs(ctx: ActionCtx, ownerId: string, args: SendArgs): Promise<SendResult> {
  const reply = (blocks: Block[]) => ctx.runMutation(internal.thread.postReply, { ownerId, projectId: args.projectId, blocks });
  let result: { actionId: string } | { status: "needs-clarification"; reason: string };
  try {
    result = await approveAs(ctx, ownerId, args);
  } catch (error) {
    if (!(error instanceof ConvexError) || error.data !== "missing-send-permission") throw error;
    // The permission is asked for right here, for the Gmail the send would go through; it never sends by itself.
    const senders: string[] = await ctx.runQuery(internal.thread.gmailSenders, { ownerId, projectId: args.projectId });
    await reply(
      senders.length === 0
        ? [block("say", "say", { text: NO_GMAIL })]
        : [block("say", "say", { text: MISSING_SEND_PERMISSION }), ...senders.map((sourceId) => block(`allow-${sourceId}`, "allowSend", { sourceId, account: "Gmail" }))],
    );
    return { status: "missing-send-permission" };
  }
  if ("actionId" in result) {
    await ctx.runMutation(internal.thread.recordSend, {
      ownerId,
      projectId: args.projectId,
      artifactId: args.artifactId,
      revision: args.revision,
      actionId: result.actionId,
      recipient: args.recipient.trim(),
    });
    return result;
  }
  // The draft moved on since the approval was shown: say so, and offer exactly the current revision.
  const current: ApprovalContext = await ctx.runQuery(internal.thread.loadApprovalContext, { ownerId, projectId: args.projectId });
  const fresh = current.artifact !== null && current.artifact.revision !== args.revision ? current.artifact : null;
  await reply([
    block("say", "say", { text: fresh ? `${result.reason} Here is revision ${fresh.revision}, ready to send.` : result.reason }),
    ...(fresh ? [approvalBlock(args.projectId, fresh, current.commitmentKey, current.requester)] : []),
  ]);
  return result;
}

