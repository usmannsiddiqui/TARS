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
});
