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

/** PreparedWork (domain type) as stored. */
export const preparedWorkFields = {
  projectId: v.string(),
  title: v.string(),
  body: v.string(),
  evidenceIds: v.array(v.string()),
  gaps: v.array(v.string()),
  nextAction: v.string(),
  state: v.union(v.literal("partial"), v.literal("ready")),
};

export const commitmentFields = {
  text: v.string(),
  ownership: v.union(v.literal("user"), v.literal("other"), v.literal("unassigned")),
  state: v.union(v.literal("open"), v.literal("waiting"), v.literal("user-reported-done"), v.literal("verified-done")),
  dueAt: v.optional(v.string()),
  evidenceIds: v.array(v.string()),
};

export const preparationStatus = v.union(
  v.literal("ready"),
  v.literal("needs-retry"), // last attempt failed; previous `work` kept
  v.literal("invalidated"), // a fact it depended on was forgotten; `work` removed
  v.literal("empty"), // no in-scope evidence yet
);

export const artifactFields = {
  ownerId: v.string(),
  projectId: v.string(),
  revision: v.string(),
  text: v.string(),
  userEdited: v.boolean(),
  evidenceIds: v.array(v.string()),
};

/** FocusState (domain type). */
export const focusFields = {
  projectId: v.optional(v.string()),
  taskId: v.optional(v.string()),
  artifactId: v.optional(v.string()),
  nextStep: v.optional(v.string()),
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

  // MemoryFact. scope "global" only via an explicit user instruction; projectId absent when global.
  memoryFacts: defineTable({
    ownerId: v.string(),
    projectId: v.optional(v.string()),
    key: v.string(), // normalized
    value: v.string(),
    evidenceIds: v.array(v.string()),
    scope: v.union(v.literal("project"), v.literal("global")),
    revision: v.number(),
  }).index("by_owner", ["ownerId"]),

  // Forget tombstones: key + evidence IDs only, never the forgotten value.
  suppressions: defineTable({
    ownerId: v.string(),
    projectId: v.optional(v.string()),
    key: v.string(),
    evidenceIds: v.array(v.string()),
    active: v.boolean(),
  }).index("by_owner", ["ownerId"]),

  // New facts that resemble something forgotten: held for the user, not active memory.
  memoryReview: defineTable({
    ownerId: v.string(),
    projectId: v.string(),
    key: v.string(),
    value: v.string(),
    evidenceIds: v.array(v.string()),
  }).index("by_owner_project", ["ownerId", "projectId"]),

  // Commitment; the row _id is the TaskId.
  commitments: defineTable({ ownerId: v.string(), projectId: v.string(), ...commitmentFields }).index(
    "by_owner_project",
    ["ownerId", "projectId"],
  ),

  // Latest PreparedWork per (owner, project). factKeys: memory keys it depended on.
  preparedWork: defineTable({
    ownerId: v.string(),
    projectId: v.string(),
    work: v.optional(v.object(preparedWorkFields)),
    factKeys: v.array(v.string()),
    status: preparationStatus,
    lastError: v.optional(v.string()), // short code only, never source or model text
    updatedAt: v.string(),
  }).index("by_owner_project", ["ownerId", "projectId"]),

  // Artifact (domain type); one per (owner, project). Changes only by compare-and-set on `revision`.
  artifacts: defineTable(artifactFields).index("by_owner_project", ["ownerId", "projectId"]),

  // Immutable prior versions, written once when an artifact moves past them; never patched.
  artifactVersions: defineTable({ artifactId: v.id("artifacts"), ...artifactFields }).index("by_artifact_revision", [
    "artifactId",
    "revision",
  ]),

  // Proposed text kept apart from the artifact: a late/conflicting revision or a source update.
  artifactSuggestions: defineTable({
    ownerId: v.string(),
    artifactId: v.id("artifacts"),
    kind: v.union(v.literal("revision"), v.literal("source")),
    text: v.string(),
    changeSummary: v.string(),
    baseRevision: v.string(), // artifact revision the proposal was written against
    evidenceIds: v.array(v.string()),
  }).index("by_artifact", ["artifactId"]),

  // The chosen FocusState, one row per owner. Written only by user-initiated functions in projects.ts.
  focus: defineTable({ ownerId: v.string(), ...focusFields }).index("by_owner", ["ownerId"]),

  // ProjectSnapshot per (owner, project): what to restore when the user returns to it.
  projectSnapshots: defineTable({
    ownerId: v.string(),
    projectId: v.string(),
    focus: v.object(focusFields),
    artifactRevision: v.optional(v.string()),
    savedAt: v.string(),
  }).index("by_owner_project", ["ownerId", "projectId"]),
});
