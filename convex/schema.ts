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
  // Mail only: the sender and subject from the provider's header fields, set at intake.
  from: v.optional(v.object({ name: v.optional(v.string()), address: v.string() })),
  subject: v.optional(v.string()),
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

/** SortKind (packages/domain/src/sort.ts). */
export const captureKind = v.union(v.literal("todo"), v.literal("waiting"), v.literal("parked"), v.literal("idea"));

export const preparationStatus = v.union(
  v.literal("ready"),
  v.literal("needs-retry"), // last attempt failed; previous `work` kept
  v.literal("invalidated"), // a fact it depended on was forgotten; `work` removed
  v.literal("empty"), // no in-scope evidence yet
);

/** Where a running preparation really is: loading evidence, waiting on the model, validating and storing. */
export const runStage = v.union(v.literal("reading"), v.literal("drafting"), v.literal("saving"));

export const artifactFields = {
  ownerId: v.string(),
  projectId: v.string(),
  revision: v.string(),
  text: v.string(),
  userEdited: v.boolean(),
  evidenceIds: v.array(v.string()),
};

export const actionStage = v.object({
  name: v.union(v.literal("document"), v.literal("link"), v.literal("send"), v.literal("verify")),
  state: v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("failed"), v.literal("unknown")),
  startedAt: v.optional(v.number()),
  endedAt: v.optional(v.number()),
  detail: v.optional(v.string()), // the honest wording for failed/unknown, never provider content
});

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
    .index("by_owner_current", ["ownerId", "isCurrent"])
    .index("by_owner_id", ["ownerId", "id"]),

  // One provider connection per grant (sourceId). Secrets are sealed with encryptSecret and
  // read only by internal functions; no query returns them.
  connections: defineTable({
    ownerId: v.string(),
    sourceId: v.string(),
    provider: v.string(), // the grant's SourceKind
    // Maps an incoming delivery to this connection (Slack team id, Canvas origin, ...).
    accountKey: v.string(),
    credential: v.string(), // sealed JSON object of named secrets
    // "composio": Composio holds the provider tokens and accountKey is its connected account id.
    broker: v.optional(v.literal("composio")),
    webhookSecret: v.optional(v.string()), // sealed per-subscription signing secret
    cursor: v.optional(v.string()),
    subscriptionExpiresAt: v.optional(v.number()),
    availability,
    lastCheckedAt: v.optional(v.string()),
    lastError: v.optional(v.string()), // short code only, never source content
    // How the last successful check happened: Composio pushed an event, or TARS asked on an app event.
    checkedVia: v.optional(v.union(v.literal("pushed"), v.literal("opened"))),
    // Composio Gmail: which trigger config Composio accepted. Absent: made before the one-minute interval.
    triggerUpgrade: v.optional(v.union(v.literal("polling_interval_1"), v.literal("default_interval"))),
    mailCheckStartedAt: v.optional(v.number()), // the last on-event mail check, for its 20-second debounce
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
  // doneAt: when the user marked it done ("I did it"), for the closing recap.
  // origin "capture": filed from the user's own brain dump (captureItems); preparation never replaces it.
  commitments: defineTable({
    ownerId: v.string(),
    projectId: v.string(),
    ...commitmentFields,
    doneAt: v.optional(v.number()),
    origin: v.optional(v.literal("capture")),
  }).index("by_owner_project", ["ownerId", "projectId"]),

  // One line of a sorted brain dump. captureId: the capture's id on the Mac (the full text stays there).
  // Only todo/waiting lines with a project have a commitment (commitmentId); parked and idea lines never do.
  captureItems: defineTable({
    ownerId: v.string(),
    captureId: v.string(),
    projectId: v.optional(v.string()),
    kind: captureKind,
    text: v.string(),
    dueAt: v.optional(v.string()),
    createdAt: v.number(),
    commitmentId: v.optional(v.id("commitments")),
  }).index("by_owner_capture", ["ownerId", "captureId"]),

  // Who the user is, from the verified sign-in when they connected a source. Lets an automatic
  // preparation (no caller token) tell the model whose commitments are whose.
  ownerProfiles: defineTable({
    ownerId: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
  }).index("by_owner", ["ownerId"]),

  // At most one preparation per (owner, project), user-started or automatic: pending (scheduled),
  // running, or failed (kept for its card until retried or dismissed). A finished run is deleted.
  // followUp: evidence landed during the run, so exactly one more run follows it.
  preparationRuns: defineTable({
    ownerId: v.string(),
    projectId: v.string(),
    state: v.union(v.literal("pending"), v.literal("running"), v.literal("failed")),
    followUp: v.boolean(),
    // Visible helper progress: the stage the run is really in, and once known, the source kinds
    // (and item counts) of the evidence it sent to the model.
    stage: v.optional(runStage),
    sources: v.optional(v.array(v.object({ kind: v.string(), count: v.number() }))),
  }).index("by_owner_project", ["ownerId", "projectId"]),

  // Gentle nudges for one of the user's commitments with a due time (key = commitmentKey, stable
  // across re-preparation). dueJob: the one due-1h reminder. offer: what is showing now, if anything.
  nudges: defineTable({
    ownerId: v.string(),
    projectId: v.string(),
    key: v.string(),
    dueAt: v.string(),
    dueJob: v.optional(v.id("_scheduled_functions")),
    lastNudgedAt: v.optional(v.number()),
    offer: v.optional(v.object({ key: v.string(), startedForYou: v.boolean() })),
    parkedAt: v.optional(v.number()), // when the user last answered "Not now", for the closing recap
  })
    .index("by_owner_key", ["ownerId", "key"]),

  // Latest PreparedWork per (owner, project). factKeys: memory keys it depended on.
  preparedWork: defineTable({
    ownerId: v.string(),
    projectId: v.string(),
    work: v.optional(v.object(preparedWorkFields)),
    factKeys: v.array(v.string()),
    status: preparationStatus,
    lastError: v.optional(v.string()), // short code only, never source or model text
    updatedAt: v.string(),
    // updatedAt of the last preparation the user started; keys the "Ready when you are" invitation,
    // so automatic runs never raise a new one or undo a dismissal.
    invitedAt: v.optional(v.string()),
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

  // At most one live read-only link per artifact, and the row is the receipt of the user's share.
  // title/text are a snapshot of the shared revision: only shares.updateShare changes them.
  // Deleting the row kills the link for good; a re-share makes a new token.
  artifactShares: defineTable({
    ownerId: v.string(),
    artifactId: v.id("artifacts"),
    tokenHash: v.string(), // SHA-256 hex of the 32-byte random token in the link
    sealedToken: v.string(), // encryptSecret(token), so only the owner can copy the link again
    revision: v.string(),
    title: v.string(),
    text: v.string(),
    sharedAt: v.number(), // when the user shared or last moved the page to `revision`
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_artifact", ["artifactId"]),

  // One Word document per artifact revision, made only by delivery.approveAndSend (the user's call).
  // The link token is made in that action; only its hash is stored, plus a sealed copy for the owner.
  // storageId is absent until the file is stored; deleting the row (and file) kills the link for good.
  artifactDocuments: defineTable({
    ownerId: v.string(),
    artifactId: v.id("artifacts"),
    revision: v.string(),
    contentHash: v.string(), // SHA-256 hex of the revision's text the document was made from
    filename: v.string(),
    storageId: v.optional(v.id("_storage")),
    tokenHash: v.string(),
    sealedToken: v.string(),
    createdAt: v.number(),
  })
    .index("by_artifact_revision", ["artifactId", "revision"])
    .index("by_token_hash", ["tokenHash"]),

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

  // T11 contact settings, one row per owner, with the one pending 09:00 and 19:30 deadline each.
  attentionSettings: defineTable({
    ownerId: v.string(),
    timezone: v.string(), // IANA
    quietHours: v.optional(v.object({ start: v.string(), end: v.string() })), // local "HH:MM"
    morningAt: v.number(),
    morningJob: v.id("_scheduled_functions"),
    eveningAt: v.number(),
    eveningJob: v.id("_scheduled_functions"),
  }).index("by_owner", ["ownerId"]),

  // Explicit session/meeting events and returns (wake/unlock/app focus), append-only.
  sessionEvents: defineTable({
    ownerId: v.string(),
    kind: v.union(
      v.literal("start"),
      v.literal("stop"),
      v.literal("break"),
      v.literal("resume"),
      v.literal("meeting-start"),
      v.literal("meeting-end"),
      v.literal("return"),
    ),
    at: v.number(),
  }).index("by_owner_at", ["ownerId", "at"]),

  // At most one pending brief per (owner, kind); a newer one replaces the older.
  pendingBriefs: defineTable({
    ownerId: v.string(),
    kind: v.union(v.literal("morning"), v.literal("evening")),
    key: v.string(), // "morning:YYYY-MM-DD" (local date)
    preparedAt: v.number(),
    brief: v.object({
      kind: v.union(v.literal("morning"), v.literal("evening")),
      items: v.array(v.string()),
      recommendedAction: v.optional(v.string()),
      reason: v.optional(v.string()),
      staleSourceIds: v.array(v.string()),
      hard: v.array(
        v.object({
          commitmentId: v.string(),
          projectId: v.string(),
          text: v.string(),
          dueAt: v.string(),
          kind: v.union(v.literal("meeting"), v.literal("deadline")),
          sourceId: v.optional(v.string()),
          sourceKind: v.optional(v.string()),
          lastCheckedAt: v.optional(v.string()),
          current: v.boolean(),
          label: v.string(),
        }),
      ),
      suggested: v.array(v.object({ projectId: v.string(), text: v.string(), commitmentId: v.optional(v.string()) })),
      triage: v.array(
        v.object({
          commitmentId: v.string(),
          action: v.union(v.literal("prioritize"), v.literal("defer"), v.literal("renegotiate")),
          reason: v.string(),
        }),
      ),
    }),
    // Morning only: what the brief read, per kind ("commitments" or a source kind). Absent on older rows.
    read: v.optional(v.array(v.object({ kind: v.string(), count: v.number() }))),
  }).index("by_owner_kind", ["ownerId", "kind"]),

  // One receipt per delivered brief/invitation key; a receipt means "never deliver this again".
  deliveryReceipts: defineTable({
    ownerId: v.string(),
    key: v.string(),
    channel: v.union(v.literal("notification"), v.literal("panel")),
    at: v.number(),
  }).index("by_owner_key", ["ownerId", "key"]),

  dismissedInvitations: defineTable({ ownerId: v.string(), key: v.string(), at: v.number() }).index("by_owner_key", [
    "ownerId",
    "key",
  ]),

  // One row per evaluated commitment (key = project + normalized text, stable across re-preparation).
  // "none": no clash; "open": shown once until the user chooses; "resolved": never shown again.
  tradeoffFlags: defineTable({
    ownerId: v.string(),
    key: v.string(),
    text: v.optional(v.string()),
    state: v.union(v.literal("none"), v.literal("open"), v.literal("resolved")),
    choice: v.optional(v.union(v.literal("keep"), v.literal("defer"), v.literal("renegotiate"))),
  })
    .index("by_owner_key", ["ownerId", "key"])
    .index("by_owner_state", ["ownerId", "state"]),

  // ActionIntent + ActionReceipt (T10). One row per user instruction, written BEFORE the provider
  // call (the reservation), so the same instruction can never execute twice.
  actions: defineTable({
    ownerId: v.string(),
    projectId: v.string(),
    taskId: v.optional(v.string()),
    kind: v.union(v.literal("update-note"), v.literal("send-mail"), v.literal("post-message"), v.literal("send-document")),
    destination: v.string(),
    artifactId: v.string(),
    // send-document: the bound subject and the Word document whose link the body carries.
    subject: v.optional(v.string()),
    documentId: v.optional(v.id("artifactDocuments")),
    // send-document: the real stages as they happen, for the chat to show.
    stages: v.optional(v.array(actionStage)),
    revision: v.string(),
    contentHash: v.string(),
    instructionId: v.string(),
    sourceId: v.string(), // the source the effect goes through
    provider: v.string(), // gmail | outlook-mail | notion | composio-gmail | composio-slack
    body: v.string(), // the approved text at `revision`
    state: v.union(v.literal("pending"), v.literal("running"), v.literal("succeeded"), v.literal("failed"), v.literal("unknown")),
    externalId: v.optional(v.string()), // provider message/block id, kept for lookup
    verifiedAt: v.optional(v.string()),
    reason: v.optional(v.string()), // short explanation of failed/unknown, never provider content
    logState: v.union(v.literal("not-due"), v.literal("pending"), v.literal("written"), v.literal("failed")),
  })
    .index("by_instruction", ["ownerId", "instructionId"])
    .index("by_owner_project", ["ownerId", "projectId"])
    .index("by_owner_log", ["ownerId", "logState"])
    .index("by_source_state", ["sourceId", "state"]),

  // The user's chosen outcome log per project: a write target of one of their grants.
  logDestinations: defineTable({
    ownerId: v.string(),
    projectId: v.string(),
    kind: v.union(v.literal("notion"), v.literal("obsidian")),
    sourceId: v.string(),
    target: v.string(),
  }).index("by_owner_project", ["ownerId", "projectId"]),

  // Separate consent to send (gmail.send / Mail.Send): the read connection never carries it.
  sendPermissions: defineTable({
    ownerId: v.string(),
    sourceId: v.string(),
    provider: v.string(),
    credential: v.string(), // sealed {refreshToken}
  }).index("by_source", ["sourceId"]),

  // Explicit, owner-bound recording sessions for dictation; the row's _id is the recoveryId.
  // Holds no audio or transcript. Consumed on success, deleted by a one-shot job at expiry.
  dictationSessions: defineTable({ ownerId: v.string(), expiresAt: v.number() }),
});
