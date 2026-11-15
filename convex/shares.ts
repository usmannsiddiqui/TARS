// Share one artifact revision as a read-only web page. Sharing is an outside act: only the three
// user functions below (the share action, two mutations) create, move or remove a share, each from the verified session. Nothing in
// prepare, automatic runs, briefs, memory or model output calls them. The page shows a snapshot of
// one revision, so edits, undo, suggestions and new preparations never reach it.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, httpAction, internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { requireOwnedArtifact } from "./artifacts";
import { requireOwnerId } from "./lib/auth";
import { decryptSecret, encryptSecret } from "./lib/crypto";
import { requireEnv } from "./lib/providerAuth";
import { NOT_FOUND_PAGE, pageResponse, renderSharedPage, tokenHash } from "./lib/sharePage";
import { requireOwnedProject } from "./memory";

export const SHARE_PREFIX = "/p/";
const TOKEN = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 random bytes
const STALE = "The draft changed after you asked. Check the current version and share again.";

const linkFor = async (sealedToken: string) => `${requireEnv("CONVEX_SITE_URL")}${SHARE_PREFIX}${await decryptSecret(sealedToken)}`;

const shareOf = (ctx: Pick<QueryCtx, "db">, artifactId: Id<"artifacts">) =>
  ctx.db
    .query("artifactShares")
    .withIndex("by_artifact", (q) => q.eq("artifactId", artifactId))
    .unique();

/** The owner's artifact at exactly `revision`, with the project name as the page title. */
async function currentRevision(ctx: Pick<QueryCtx, "db">, ownerId: string, artifactId: string, revision: string) {
  const artifact = await requireOwnedArtifact(ctx, ownerId, artifactId);
  if (artifact.revision !== revision) throw new ConvexError(STALE);
  const project = await requireOwnedProject(ctx, ownerId, artifact.projectId);
  return { artifact, title: project.name };
}

const shareView = v.union(v.null(), v.object({ link: v.string(), revision: v.string(), sharedAt: v.number() }));

/** The share state for the owner's UI: null while private. */
export const getShare = query({
  args: { artifactId: v.string() },
  returns: shareView,
  handler: async (ctx, { artifactId }) => {
    const ownerId = await requireOwnerId(ctx);
    const artifact = await requireOwnedArtifact(ctx, ownerId, artifactId);
    const share = await shareOf(ctx, artifact._id);
    return share === null ? null : { link: await linkFor(share.sealedToken), revision: share.revision, sharedAt: share.sharedAt };
  },
});

/**
 * The user's explicit share of the current revision. An action, because the token must come from the
 * runtime's real CSPRNG, not the seeded generator queries and mutations get. An artifact already shared
 * keeps its one link.
 */
export const share = action({
  args: { artifactId: v.string(), revision: v.string() },
  returns: v.object({ link: v.string() }),
  handler: async (ctx, { artifactId, revision }): Promise<{ link: string }> => {
    const ownerId = await requireOwnerId(ctx);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const sealedToken: string = await ctx.runMutation(internal.shares.insertShare, {
      ownerId,
      artifactId,
      revision,
      tokenHash: await tokenHash(token),
      sealedToken: await encryptSecret(token),
    });
    return { link: await linkFor(sealedToken) };
  },
});

/** Ownership, current revision and the one-share rule in one transaction; returns the live share's sealed token. */
export const insertShare = internalMutation({
  args: { ownerId: v.string(), artifactId: v.string(), revision: v.string(), tokenHash: v.string(), sealedToken: v.string() },
  returns: v.string(),
  handler: async (ctx, { ownerId, artifactId, revision, tokenHash, sealedToken }) => {
    const { artifact, title } = await currentRevision(ctx, ownerId, artifactId, revision);
    const existing = await shareOf(ctx, artifact._id);
    if (existing !== null) return existing.sealedToken;
    await ctx.db.insert("artifactShares", {
      ownerId,
      artifactId: artifact._id,
      tokenHash,
      sealedToken,
      revision,
      title,
      text: artifact.text,
      sharedAt: Date.now(),
    });
    return sealedToken;
  },
});

/** The user's approval that the shared page now shows `revision` (which must be the current one). */
export const updateShare = mutation({
  args: { artifactId: v.string(), revision: v.string() },
  returns: v.null(),
  handler: async (ctx, { artifactId, revision }) => {
    const ownerId = await requireOwnerId(ctx);
    const { artifact, title } = await currentRevision(ctx, ownerId, artifactId, revision);
    const existing = await shareOf(ctx, artifact._id);
    if (existing === null) throw new ConvexError("This draft is not shared");
    await ctx.db.patch(existing._id, { revision, title, text: artifact.text, sharedAt: Date.now() });
    return null;
  },
});

/** Deletes the share: the old link is dead for good. */
export const stopSharing = mutation({
  args: { artifactId: v.string() },
  returns: v.null(),
  handler: async (ctx, { artifactId }) => {
    const ownerId = await requireOwnerId(ctx);
    const artifact = await requireOwnedArtifact(ctx, ownerId, artifactId);
    const existing = await shareOf(ctx, artifact._id);
    if (existing !== null) await ctx.db.delete(existing._id);
    return null;
  },
});

export const sharedPage = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(v.null(), v.object({ title: v.string(), text: v.string() })),
  handler: async (ctx, args) => {
    const share = await ctx.db
      .query("artifactShares")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    return share === null ? null : { title: share.title, text: share.text };
  },
});

// shortcut: no per-IP rate limit exists in this stack; a 256-bit token cannot be guessed and this route
// runs no model or tool (one indexed read), so add a limit only if the route starts costing real money.
/** GET /p/<token>: the shared page, or the same 404 for every bad, unknown or stopped token. Never logs the token. */
export const page = httpAction(async (ctx, request) => {
  const token = new URL(request.url).pathname.slice(SHARE_PREFIX.length);
  const shared = TOKEN.test(token) ? await ctx.runQuery(internal.shares.sharedPage, { tokenHash: await tokenHash(token) }) : null;
  return shared === null ? pageResponse(404, NOT_FOUND_PAGE) : pageResponse(200, renderSharedPage(shared.title, shared.text));
});
