// Connector seam: connection rows, status, and the path from a provider item to `ingest`.
// Credentials stay sealed here; only internal functions return a connection row.
import { ConvexError, v } from "convex/values";
import type { Evidence, SourceGrant } from "../packages/domain/src/types";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { type ActionCtx, internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import { StoredGrantSchema } from "./evidence";
import { requireOwnerId } from "./lib/auth";
import { ProviderError } from "./lib/providerAuth";
import { availability } from "./schema";

export type SourceContext = { grant: SourceGrant | null; connection: Doc<"connections"> | null };
type RunCtx = Pick<ActionCtx, "runQuery" | "runMutation">;

async function loadContext(ctx: QueryCtx, sourceId: string): Promise<SourceContext> {
  const grantRow = await ctx.db
    .query("grants")
    .withIndex("by_source", (q) => q.eq("id", sourceId))
    .unique();
  const connection = await ctx.db
    .query("connections")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .unique();
  return { grant: grantRow === null ? null : StoredGrantSchema.parse(grantRow), connection };
}

/**
 * Status of the caller's connections for the UI, with the grant's state, version, selection and
 * projects (cloud selectors are ids, returned to their owner). Never credentials or secrets.
 */
export const listConnections = query({
  args: {},
  returns: v.array(
    v.object({
      sourceId: v.string(),
      provider: v.string(),
      availability,
      lastCheckedAt: v.optional(v.string()),
      lastError: v.optional(v.string()),
      subscriptionExpiresAt: v.optional(v.number()),
      state: v.string(),
      version: v.number(),
      selectors: v.array(v.string()),
      projectIds: v.array(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const rows = await ctx.db
      .query("connections")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
    const out = [];
    for (const row of rows) {
      const { grant } = await loadContext(ctx, row.sourceId);
      if (grant === null || grant.ownerId !== ownerId) continue;
      out.push({
        sourceId: row.sourceId,
        provider: row.provider,
        availability: row.availability,
        ...(row.lastCheckedAt === undefined ? {} : { lastCheckedAt: row.lastCheckedAt }),
        ...(row.lastError === undefined ? {} : { lastError: row.lastError }),
        ...(row.subscriptionExpiresAt === undefined ? {} : { subscriptionExpiresAt: row.subscriptionExpiresAt }),
        state: grant.state,
        version: grant.version,
        selectors: grant.selectors,
        projectIds: grant.projectIds,
      });
    }
    return out;
  },
});

export const context = internalQuery({
  args: { sourceId: v.string() },
  handler: (ctx, { sourceId }): Promise<SourceContext> => loadContext(ctx, sourceId),
});

/** Maps a delivery's provider-side account (e.g. Slack team id) to its source. */
export const byAccount = internalQuery({
  args: { provider: v.string(), accountKey: v.string() },
  handler: async (ctx, { provider, accountKey }): Promise<SourceContext | null> => {
    const connection = await ctx.db
      .query("connections")
      .withIndex("by_account", (q) => q.eq("provider", provider).eq("accountKey", accountKey))
      .unique();
    return connection === null ? null : loadContext(ctx, connection.sourceId);
  },
});

/** Create or replace a connection. `credential` must already be sealed (sealCredential). */
export const save = internalMutation({
  args: {
    ownerId: v.string(),
    sourceId: v.string(),
    provider: v.string(),
    accountKey: v.string(),
    credential: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { grant, connection } = await loadContext(ctx, args.sourceId);
    if (grant === null || grant.ownerId !== args.ownerId || grant.kind !== args.provider) {
      throw new ConvexError("Source is not available");
    }
    const sameAccount = await ctx.db
      .query("connections")
      .withIndex("by_account", (q) => q.eq("provider", args.provider).eq("accountKey", args.accountKey))
      .unique();
    if (sameAccount !== null && sameAccount.sourceId !== args.sourceId) {
      throw new ConvexError("This account is already connected to another source");
    }
    if (connection === null) {
      await ctx.db.insert("connections", { ...args, availability: "connected" });
    } else {
      await ctx.db.patch(connection._id, { ...args, availability: "connected", lastError: undefined });
    }
    return null;
  },
});

/** Store a per-subscription signing secret once; a second unsigned handshake cannot replace it. */
export const setWebhookSecret = internalMutation({
  args: { sourceId: v.string(), webhookSecret: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { sourceId, webhookSecret }) => {
    const { connection } = await loadContext(ctx, sourceId);
    if (connection === null || connection.webhookSecret !== undefined) return false;
    await ctx.db.patch(connection._id, { webhookSecret });
    return true;
  },
});

/** Record availability. `checkedAt` only on a successful read, so a failure keeps the old one. */
export const setStatus = internalMutation({
  args: {
    sourceId: v.string(),
    availability,
    lastError: v.optional(v.string()),
    checkedAt: v.optional(v.string()),
    cursor: v.optional(v.string()),
    subscriptionExpiresAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { sourceId, checkedAt, ...status }) => {
    const { connection } = await loadContext(ctx, sourceId);
    if (connection === null) return null;
    await ctx.db.patch(connection._id, {
      ...status,
      lastError: status.lastError,
      ...(checkedAt === undefined ? {} : { lastCheckedAt: checkedAt }),
    });
    return null;
  },
});

/** After a revoke: record a failed provider cleanup as a visible code. The grant stays revoked. */
export const markCleanupFailed = internalMutation({
  args: { sourceId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sourceId }) => {
    const { connection } = await loadContext(ctx, sourceId);
    if (connection !== null) await ctx.db.patch(connection._id, { lastError: "watch_stop_failed" });
    return null;
  },
});

// ---- Plain helpers for connector actions and HTTP handlers.

/** The caller's grant of this kind (and its connection). Throws the same error for absent or foreign. */
export async function requireOwnedSource(
  ctx: ActionCtx,
  sourceId: string,
  kind: string,
): Promise<{ ownerId: string; grant: SourceGrant; connection: Doc<"connections"> | null }> {
  const ownerId = await requireOwnerId(ctx);
  const { grant, connection } = await ctx.runQuery(internal.connections.context, { sourceId });
  if (grant === null || grant.ownerId !== ownerId || grant.kind !== kind) {
    throw new ConvexError("Source is not available");
  }
  // Disconnect is final: the stored credential is never used again (same wording as setGrantState).
  if (grant.state === "revoked") throw new ConvexError("This source was disconnected; connect it again");
  return { ownerId, grant, connection };
}

export type ProviderItem = {
  externalId: string;
  version: string;
  text: string;
  occurredAt: string; // ISO-8601 UTC
  sourceUrl?: string;
};

/** Ingest provider items under the stored grant. Returns the records now stored (new or duplicate), not denied ones. */
export async function ingestItems(ctx: RunCtx, grant: SourceGrant, items: ProviderItem[]): Promise<Evidence[]> {
  const receivedAt = new Date().toISOString();
  const stored: Evidence[] = [];
  for (const item of items) {
    const record = {
      ...item,
      id: `${grant.id}:${item.externalId}:${item.version}`,
      ownerId: grant.ownerId,
      sourceId: grant.id,
      receivedAt,
      projectIds: grant.projectIds,
      grantVersion: grant.version,
      freshness: "current",
      origin: "live",
    } as Evidence;
    const result = await ctx.runMutation(internal.evidence.ingest, {
      ownerId: grant.ownerId,
      sourceId: grant.id,
      record,
    });
    if (result !== "denied") stored.push(record);
  }
  return stored;
}

/** Record a successful read: connected, checked now. */
export async function markChecked(ctx: RunCtx, sourceId: string, cursor?: string): Promise<void> {
  await ctx.runMutation(internal.connections.setStatus, {
    sourceId,
    availability: "connected",
    checkedAt: new Date().toISOString(),
    ...(cursor === undefined ? {} : { cursor }),
  });
}

/** Record a provider failure as visible status and return it; rethrows anything else. */
export async function markFailed(ctx: RunCtx, sourceId: string, error: unknown): Promise<ProviderError> {
  if (!(error instanceof ProviderError)) throw error;
  await ctx.runMutation(internal.connections.setStatus, {
    sourceId,
    availability: error.availability,
    lastError: error.code,
  });
  return error;
}
