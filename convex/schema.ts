import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Shapes mirror SourceGrant / Evidence in packages/domain/src/types.ts. Convex checks the
// shape; the domain Zod schemas check the finer rules (enums, ISO dates, URLs).

/** SourceGrant fields as a client sends them: ownerId is never accepted from a client. */
export const grantInputFields = {
  id: v.string(),
  kind: v.string(),
  selectors: v.array(v.string()),
  projectIds: v.array(v.string()),
  read: v.boolean(),
  writeTargets: v.array(v.string()),
  cloudProcessing: v.boolean(),
  version: v.number(),
  state: v.string(),
};

export const evidenceFields = {
  id: v.string(),
  ownerId: v.string(),
  sourceId: v.string(),
  externalId: v.string(),
  version: v.string(),
  text: v.string(),
  sourceUrl: v.optional(v.string()),
  occurredAt: v.string(),
  receivedAt: v.string(),
  projectIds: v.array(v.string()),
  grantVersion: v.number(),
  freshness: v.string(),
  origin: v.string(),
};

/** Shown to the user as Connected / Stale / Missing access / Needs retry; never "empty". */
export const availability = v.union(
  v.literal("connected"),
  v.literal("stale"),
  v.literal("missing-access"),
  v.literal("needs-retry"),
);

export default defineSchema({
  projects: defineTable({
    // The verified identity's tokenIdentifier; set only by server code, never by a client argument.
    ownerId: v.string(),
    name: v.string(),
  }).index("by_owner", ["ownerId"]),

  // One row per source; `id` is the SourceId. ownerId comes only from the verified caller.
  grants: defineTable({ ...grantInputFields, ownerId: v.string() }).index("by_source", ["id"]),

  // One durable row per source revision (ownerId, sourceId, externalId, version).
  // isCurrent marks the revision with the latest occurredAt for its (sourceId, externalId).
  evidence: defineTable({ ...evidenceFields, isCurrent: v.boolean() })
    .index("by_item", ["ownerId", "sourceId", "externalId"])
    .index("by_owner_current", ["ownerId", "isCurrent"]),

  // One provider connection per grant (sourceId). Secrets are sealed with encryptSecret and
  // read only by internal functions; no query returns them.
  connections: defineTable({
    ownerId: v.string(),
    sourceId: v.string(),
    provider: v.string(), // the grant's SourceKind
    // Maps an incoming delivery to this connection (Slack team id, Canvas origin, ...).
    accountKey: v.string(),
    credential: v.string(), // sealed JSON object of named secrets
    webhookSecret: v.optional(v.string()), // sealed per-subscription signing secret
    cursor: v.optional(v.string()),
    subscriptionExpiresAt: v.optional(v.number()),
    availability,
    lastCheckedAt: v.optional(v.string()),
    lastError: v.optional(v.string()), // short code only, never source content
  })
    .index("by_source", ["sourceId"])
    .index("by_account", ["provider", "accountKey"])
    .index("by_owner", ["ownerId"]),

  // Single-use OAuth `state` values bound to the owner who started the flow.
  oauthStates: defineTable({
    state: v.string(),
    ownerId: v.string(),
    provider: v.string(),
    expiresAt: v.number(),
  }).index("by_state", ["state"]),
});
