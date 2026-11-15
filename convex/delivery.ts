// Approve in the chat -> a Word document of that exact revision -> an unguessable download link ->
// one verified Gmail send through the existing action flow (actions.reserveAction / runReserved).
// Sending is an outside act: only approveAndSend, called by the signed-in user, starts it. Nothing
// in prepare, automatic runs, briefs, memory, model output or evidence calls anything here, and the
// requester found in evidence is only a suggestion: the recipient is the one the user's call names.
import { ConvexError, v } from "convex/values";
import { checkBinding, contentHash, mailSubject } from "../packages/domain/src/actions";
import { commitmentKey } from "../packages/domain/src/attention";
import { DOCX_TYPE, deliveryMail, docx, requesterFrom, safeFilename } from "../packages/domain/src/delivery";
import type { Artifact } from "../packages/domain/src/types";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, httpAction, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { reserveAction, runReserved } from "./actions";
import { requireOwnedArtifact } from "./artifacts";
import { requireOwnerId } from "./lib/auth";
import { decryptSecret, encryptSecret } from "./lib/crypto";
import { requireEnv } from "./lib/providerAuth";
import { NOT_FOUND_PAGE, pageResponse, tokenHash } from "./lib/sharePage";
import { requireOwnedProject } from "./memory";
import { actionStage } from "./schema";

export const DOWNLOAD_PREFIX = "/d/";
const TOKEN = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 random bytes
// The wording the desktop already uses for an unsent and an unconfirmed send (Panel.tsx ReceiptLine).
const NOT_SENT = "Not sent. Your draft is kept.";
const NOT_CONFIRMED = "We could not confirm this was sent. Nothing has been repeated. Check again in the app.";
const NOT_ARRIVED = "Sent, but we could not confirm it arrived. Nothing has been repeated. Check again in the app.";

type Stage = Doc<"actions">["stages"] extends (infer S)[] | undefined ? S : never;
type StageName = Stage["name"];
const clarification = v.object({ status: v.literal("needs-clarification"), reason: v.string() });
const clarify = (reason: string) => ({ status: "needs-clarification" as const, reason });
const requesterView = v.object({ name: v.optional(v.string()), address: v.string(), subject: v.optional(v.string()) });

const linkFor = async (sealedToken: string) => `${requireEnv("CONVEX_SITE_URL")}${DOWNLOAD_PREFIX}${await decryptSecret(sealedToken)}`;

async function findCommitment(ctx: Pick<QueryCtx, "db">, ownerId: string, projectId: string, key: string) {
  const rows = await ctx.db
    .query("commitments")
    .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
    .collect();
  return rows.find((c) => commitmentKey(c) === key) ?? null;
}

/** The sender of the mail this commitment cites, from the stored header fields only. */
export async function requesterFor(ctx: Pick<QueryCtx, "db">, ownerId: string, projectId: string, key: string) {
  const commitment = await findCommitment(ctx, ownerId, projectId, key);
  if (commitment === null) return null;
  const cited: Doc<"evidence">[] = [];
  for (const id of commitment.evidenceIds) {
    const rows = await ctx.db
      .query("evidence")
      .withIndex("by_owner_id", (q) => q.eq("ownerId", ownerId).eq("id", id))
      .collect();
    cited.push(...rows.filter((row) => row.projectIds.includes(projectId)));
  }
  return requesterFrom(cited);
}

const documentFor = (ctx: Pick<QueryCtx, "db">, artifactId: Id<"artifacts">, revision: string) =>
  ctx.db
    .query("artifactDocuments")
    .withIndex("by_artifact_revision", (q) => q.eq("artifactId", artifactId).eq("revision", revision))
    .unique();

// ---- What the chat calls.

/** A suggestion for the recipient: who asked, for the user to see and change. Null when not mail or ambiguous. */
export const requester = query({
  args: { projectId: v.string(), commitmentKey: v.string() },
  returns: v.union(v.null(), requesterView),
  handler: async (ctx, { projectId, commitmentKey }) => {
    const ownerId = await requireOwnerId(ctx);
    await requireOwnedProject(ctx, ownerId, projectId);
    return requesterFor(ctx, ownerId, projectId, commitmentKey);
  },
});

/**
 * The user's approval: reserve the send of a Word document of exactly `revision` to `recipient`, then
 * make the document, its link and the verified send in the background. Returns the action id at once
 * (subscribe to `status`). Approving the same revision to the same address again returns the same action.
 */
export const approveAndSend = action({
  args: { projectId: v.string(), artifactId: v.string(), revision: v.string(), commitmentKey: v.string(), recipient: v.string() },
  returns: v.union(v.object({ actionId: v.string() }), clarification),
  handler: async (ctx, args): Promise<{ actionId: string } | { status: "needs-clarification"; reason: string }> => approveAs(ctx, await requireOwnerId(ctx), args),
});

/** The reservation for an owner the caller resolved from a verified identity (the app's session or the linked phone). */
export async function approveAs(
  ctx: ActionCtx,
  ownerId: string,
  args: { projectId: string; artifactId: string; revision: string; commitmentKey: string; recipient: string },
): Promise<{ actionId: string } | { status: "needs-clarification"; reason: string }> {
  const recipient = args.recipient.trim();
  const artifact: Artifact = await ctx.runQuery(internal.artifacts.loadArtifact, { ownerId, artifactId: args.artifactId });
  const hash = await contentHash(artifact.text);
  // The same binding check as every send: this project, this revision, one plain address.
  const check = checkBinding({ ...args, kind: "send-mail", destination: recipient, contentHash: hash }, artifact, hash);
  if (!check.ok) return clarify(check.reason);
  // The token comes from the action runtime's real CSPRNG; only its hash and a sealed copy are stored.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return ctx.runMutation(internal.delivery.reserveDelivery, {
    ownerId,
    ...args,
    recipient,
    contentHash: hash,
    tokenHash: await tokenHash(token),
    sealedToken: await encryptSecret(token),
  });
}

/** One action's stages and receipt, for the chat to subscribe to. */
export const status = query({
  args: { actionId: v.string() },
  returns: v.object({
    state: v.union(v.literal("pending"), v.literal("running"), v.literal("succeeded"), v.literal("failed"), v.literal("unknown")),
    reason: v.optional(v.string()),
    stages: v.array(actionStage),
    recipient: v.string(),
    subject: v.string(),
    filename: v.union(v.null(), v.string()),
    link: v.union(v.null(), v.string()), // null once the document is removed
    sentAt: v.optional(v.number()),
    verified: v.boolean(),
    verifiedAt: v.optional(v.string()),
  }),
  handler: async (ctx, { actionId }) => {
    const ownerId = await requireOwnerId(ctx);
    const id = ctx.db.normalizeId("actions", actionId);
    const row = id === null ? null : await ctx.db.get(id);
    if (row === null || row.ownerId !== ownerId || row.kind !== "send-document") throw new ConvexError("Action not found");
    const document = row.documentId === undefined ? null : await ctx.db.get(row.documentId);
    const stages = row.stages ?? [];
    const send = stages.find((s) => s.name === "send");
    return {
      state: row.state,
      ...(row.reason === undefined ? {} : { reason: row.reason }),
      stages,
      recipient: row.destination,
      subject: row.subject ?? "",
      filename: document?.filename ?? null,
      link: document === null ? null : await linkFor(document.sealedToken),
      ...(send?.state === "done" && send.endedAt !== undefined ? { sentAt: send.endedAt } : {}),
      verified: row.state === "succeeded",
      ...(row.verifiedAt === undefined ? {} : { verifiedAt: row.verifiedAt }),
    };
  },
});

/** Deletes the document and its file: its link is dead for good. A later approval makes a new link. */
export const removeDocument = mutation({
  args: { artifactId: v.string(), revision: v.string() },
  returns: v.null(),
  handler: async (ctx, { artifactId, revision }) => {
    const ownerId = await requireOwnerId(ctx);
    const artifact = await requireOwnedArtifact(ctx, ownerId, artifactId);
    const document = await documentFor(ctx, artifact._id, revision);
    if (document === null || document.ownerId !== ownerId) return null;
    if (document.storageId !== undefined) await ctx.storage.delete(document.storageId);
    await ctx.db.delete(document._id);
    return null;
  },
});

// shortcut: no per-IP rate limit exists in this stack; a 256-bit token cannot be guessed and this route
// runs no model or tool (one indexed read and one file read), so add a limit only if it starts costing real money.
/** GET /d/<token>: the Word document, or the same 404 for every bad, unknown or removed token. Never logs the token. */
export const download = httpAction(async (ctx, request) => {
  const token = new URL(request.url).pathname.slice(DOWNLOAD_PREFIX.length);
  const file = TOKEN.test(token) ? await ctx.runQuery(internal.delivery.fileByToken, { tokenHash: await tokenHash(token) }) : null;
  const blob = file === null ? null : await ctx.storage.get(file.storageId);
  if (file === null || blob === null) return pageResponse(404, NOT_FOUND_PAGE);
  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": DOCX_TYPE,
      "Content-Disposition": `attachment; filename="${file.filename}"`, // safeFilename: ASCII letters, digits, space, . _ -
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});

// ---- Internal steps.

/**
 * One transaction: the document row (new, or this revision's existing one), the mail that carries its
 * link, and the reservation that binds recipient, subject, body, revision and content hash. The run
 * that makes and sends it is scheduled only with a new reservation.
 */
export const reserveDelivery = internalMutation({
  args: {
    ownerId: v.string(),
    projectId: v.string(),
    artifactId: v.string(),
    revision: v.string(),
    commitmentKey: v.string(),
    recipient: v.string(),
    contentHash: v.string(),
    tokenHash: v.string(),
    sealedToken: v.string(),
  },
  returns: v.union(v.object({ actionId: v.string() }), clarification),
  handler: async (ctx, args) => {
    const { ownerId, projectId, revision, recipient } = args;
    const project = await requireOwnedProject(ctx, ownerId, projectId);
    const artifact = await requireOwnedArtifact(ctx, ownerId, args.artifactId);
    const commitment = await findCommitment(ctx, ownerId, projectId, args.commitmentKey);
    const asker = await requesterFor(ctx, ownerId, projectId, args.commitmentKey);
    const existing = await documentFor(ctx, artifact._id, revision);
    const documentId =
      existing?._id ??
      (await ctx.db.insert("artifactDocuments", {
        ownerId,
        artifactId: artifact._id,
        revision,
        contentHash: args.contentHash,
        filename: safeFilename(project.name),
        tokenHash: args.tokenHash,
        sealedToken: args.sealedToken,
        createdAt: Date.now(),
      }));
    const document = (await ctx.db.get(documentId))!;
    // A reply to the asker's thread only when the user is sending it to the asker.
    const replyTo = asker?.address.toLowerCase() === recipient.toLowerCase() ? asker.subject : undefined;
    const mail = deliveryMail({
      filename: document.filename,
      link: await linkFor(document.sealedToken),
      ...(replyTo === undefined ? {} : { replyTo }),
      fallbackSubject: mailSubject(artifact.text).replace(/^#+\s*/, ""),
    });
    const stages = (["document", "link", "send", "verify"] as const).map((name) => ({ name, state: "pending" as const }));
    // shortcut: one instruction per (revision, recipient), so a double click never sends twice; a refused
    // send of the same revision to the same address is retried by editing the draft (a new revision).
    const instructionId = `deliver:${artifact._id}:${revision}:${recipient.toLowerCase()}`;
    const reserved = await reserveAction(
      ctx,
      ownerId,
      {
        projectId,
        ...(commitment === null ? {} : { taskId: commitment._id }),
        kind: "send-document",
        destination: recipient,
        artifactId: artifact._id,
        revision,
        contentHash: args.contentHash,
        instructionId,
      },
      { ...mail, documentId, stages },
    );
    if ("actionId" in reserved) {
      await ctx.scheduler.runAfter(0, internal.delivery.run, { actionId: reserved.actionId as Id<"actions"> });
      return { actionId: reserved.actionId };
    }
    if (existing === null) await ctx.db.delete(documentId); // nothing reserved: no new document either
    return "id" in reserved ? { actionId: reserved.id } : reserved;
  },
});

/** The reserved send-document action, its document and the text of exactly its revision. */
export const loadJob = internalQuery({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const row = await ctx.db.get(actionId);
    if (row === null || row.kind !== "send-document" || row.documentId === undefined) return null;
    const document = await ctx.db.get(row.documentId);
    const artifactId = ctx.db.normalizeId("artifacts", row.artifactId)!;
    const current = await ctx.db.get(artifactId);
    const text =
      current?.revision === row.revision
        ? current.text
        : (
            await ctx.db
              .query("artifactVersions")
              .withIndex("by_artifact_revision", (q) => q.eq("artifactId", artifactId).eq("revision", row.revision))
              .first()
          )?.text;
    const project = await requireOwnedProject(ctx, row.ownerId, row.projectId);
    return { row, document, text: text ?? null, title: project.name };
  },
});

export const setStage = internalMutation({
  args: { actionId: v.id("actions"), name: actionStage.fields.name, state: actionStage.fields.state, detail: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { actionId, name, state, detail }) => {
    const row = await ctx.db.get(actionId);
    if (row?.stages === undefined) return null;
    const now = Date.now();
    const stages = row.stages.map((s): Stage => {
      if (s.name !== name) return s;
      const startedAt = s.startedAt ?? now;
      return { name, state, startedAt, ...(state === "running" ? {} : { endedAt: now }), ...(detail === undefined ? {} : { detail }) };
    });
    await ctx.db.patch(actionId, { stages });
    return null;
  },
});

/** Attach the stored file to its document row; false (and the caller deletes the file) if it is gone or already has one. */
export const attachFile = internalMutation({
  args: { documentId: v.id("artifactDocuments"), storageId: v.id("_storage") },
  returns: v.boolean(),
  handler: async (ctx, { documentId, storageId }) => {
    const document = await ctx.db.get(documentId);
    if (document === null || document.storageId !== undefined) return false;
    await ctx.db.patch(documentId, { storageId });
    return true;
  },
});

export const fileByToken = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(v.null(), v.object({ storageId: v.id("_storage"), filename: v.string() })),
  handler: async (ctx, args) => {
    const document = await ctx.db
      .query("artifactDocuments")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    return document?.storageId === undefined ? null : { storageId: document.storageId, filename: document.filename };
  },
});

/** Scheduled once by a new reservation: document, link, send, check, each stage recorded as it happens. */
export const run = internalAction({
  args: { actionId: v.id("actions") },
  returns: v.null(),
  handler: async (ctx, { actionId }): Promise<null> => {
    const job = await ctx.runQuery(internal.delivery.loadJob, { actionId });
    if (job === null || job.row.state !== "running") return null;
    const stage = (name: StageName, state: Stage["state"], detail?: string) =>
      ctx.runMutation(internal.delivery.setStage, { actionId, name, state, ...(detail === undefined ? {} : { detail }) });
    const stop = async (name: StageName, reason: string) => {
      await stage(name, "failed", NOT_SENT);
      await ctx.runMutation(internal.actions.recordOutcome, { actionId, state: "failed", reason });
      return null;
    };

    await stage("document", "running");
    const { row, document, text, title } = job;
    // The document is made from exactly the bound text, or not at all.
    if (document === null) return stop("document", "document_removed");
    if (text === null || (await contentHash(text)) !== row.contentHash || document.contentHash !== row.contentHash) {
      return stop("document", "revision_mismatch");
    }
    if (document.storageId === undefined) {
      const storageId = await ctx.storage.store(new Blob([docx(title, text)], { type: DOCX_TYPE }));
      if (!(await ctx.runMutation(internal.delivery.attachFile, { documentId: document._id, storageId }))) await ctx.storage.delete(storageId);
    }
    await stage("document", "done");

    await stage("link", "running");
    // The link is live when the route can serve it: the row with this token hash has its file.
    if ((await ctx.runQuery(internal.delivery.fileByToken, { tokenHash: document.tokenHash })) === null) return stop("link", "document_removed");
    await stage("link", "done");

    await stage("send", "running");
    let sent = false;
    const receipt = await runReserved(ctx, row, async () => {
      sent = true;
      await stage("send", "done");
      await stage("verify", "running");
    });
    if (receipt.state === "failed") await stage(sent ? "verify" : "send", "failed", NOT_SENT);
    if (receipt.state === "unknown") await stage(sent ? "verify" : "send", "unknown", sent ? NOT_ARRIVED : NOT_CONFIRMED);
    return null;
  },
});
