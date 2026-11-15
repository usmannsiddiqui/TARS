// Shared data contracts (build contract, "Shared data types"). Pure: no I/O.
// Types that cross a boundary in T1/T2 have Zod schemas; the rest are plain TS.
import { z } from "zod";
import { isMailAddress } from "./actions";

// ---- Branded IDs: opaque strings that cannot be mixed up at compile time.
const id = <B extends string>(brand: B) => z.string().min(1).brand(brand);

export const OwnerIdSchema = id("OwnerId");
export const ProjectIdSchema = id("ProjectId");
export const SourceIdSchema = id("SourceId");
export const EvidenceIdSchema = id("EvidenceId");
export type OwnerId = z.infer<typeof OwnerIdSchema>;
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type SourceId = z.infer<typeof SourceIdSchema>;
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;
export type ArtifactId = string & z.$brand<"ArtifactId">;
export type TaskId = string & z.$brand<"TaskId">;
export type ActionId = string & z.$brand<"ActionId">;
export type RevisionId = string & z.$brand<"RevisionId">;

const isoUtc = z.iso.datetime();

// ---- Boundary schemas (T1/T2).
export const SourceKindSchema = z.enum([
  "slack",
  "gmail",
  "notion",
  "obsidian",
  "canvas",
  "outlook-mail",
  "outlook-calendar",
  "teams",
  "github",
  "claude-code",
  "codex",
  "observation",
  "user",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const CaptureInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(10_000),
  origin: z.enum(["typed", "dictated"]),
  projectHint: ProjectIdSchema.optional(),
});
export type CaptureInput = z.infer<typeof CaptureInputSchema>;

/** Durable local save, not a guarantee of cloud sync. */
export const CaptureReceiptSchema = z.strictObject({
  id: z.string().min(1),
  saved: z.boolean(),
  summary: z.string(),
  projectId: ProjectIdSchema.optional(),
});
export type CaptureReceipt = z.infer<typeof CaptureReceiptSchema>;

export const SourceGrantSchema = z.strictObject({
  id: SourceIdSchema,
  ownerId: OwnerIdSchema,
  kind: SourceKindSchema,
  selectors: z.array(z.string()),
  projectIds: z.array(ProjectIdSchema),
  read: z.boolean(),
  writeTargets: z.array(z.string()),
  cloudProcessing: z.boolean(),
  version: z.number().int().nonnegative(),
  state: z.enum(["active", "paused", "revoked"]),
});
export type SourceGrant = z.infer<typeof SourceGrantSchema>;

export const EvidenceSchema = z.strictObject({
  id: EvidenceIdSchema,
  ownerId: OwnerIdSchema,
  sourceId: SourceIdSchema,
  externalId: z.string().min(1),
  version: z.string().min(1),
  text: z.string(),
  sourceUrl: z.url().exactOptional(),
  occurredAt: isoUtc,
  receivedAt: isoUtc,
  projectIds: z.array(ProjectIdSchema),
  grantVersion: z.number().int().nonnegative(),
  freshness: z.enum(["current", "stale", "unknown"]),
  origin: z.enum(["live", "imported", "illustrative"]),
  // Mail only, from the provider's own header fields at intake (never parsed out of the text).
  from: z
    .strictObject({ name: z.string().max(200).exactOptional(), address: z.string().refine(isMailAddress) })
    .exactOptional(),
  subject: z.string().max(1000).exactOptional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const IntakeEventSchema = z.strictObject({
  grant: SourceGrantSchema,
  record: EvidenceSchema,
});
export type IntakeEvent = z.infer<typeof IntakeEventSchema>;

export const IntakeResultSchema = z.enum(["accepted", "duplicate", "denied"]);
export type IntakeResult = z.infer<typeof IntakeResultSchema>;

// ---- Plain contract types (no boundary in T1/T2 yet).
export type Commitment = {
  id: TaskId;
  ownerId: OwnerId;
  projectId: ProjectId;
  text: string;
  ownership: "user" | "other" | "unassigned";
  dueAt?: string;
  evidenceIds: EvidenceId[];
  state: "open" | "waiting" | "user-reported-done" | "verified-done";
  /** Stable identity once stored (commitmentKey). */
  key?: string;
};

/** Never implicitly a Commitment. */
export type Idea = { id: string; ownerId: OwnerId; text: string; projectId?: ProjectId; capturedAt: string };

/** scope "global" requires an explicit user instruction. */
export type MemoryFact = {
  id: string;
  ownerId: OwnerId;
  projectId?: ProjectId;
  key: string;
  value: string;
  evidenceIds: EvidenceId[];
  scope: "project" | "global";
  revision: number;
};

export type Suppression = {
  ownerId: OwnerId;
  projectId?: ProjectId;
  key: string;
  evidenceIds: EvidenceId[];
  active: boolean;
};

export type PreparedWork = {
  projectId: ProjectId;
  taskId?: TaskId;
  title: string;
  body: string;
  evidenceIds: EvidenceId[];
  gaps: string[];
  nextAction: string;
  state: "partial" | "ready";
};

export type Artifact = {
  id: ArtifactId;
  ownerId: OwnerId;
  projectId: ProjectId;
  revision: RevisionId;
  text: string;
  userEdited: boolean;
  evidenceIds: EvidenceId[];
  /** How it is delivered; absent means "document". A new revision keeps it. */
  form?: "document" | "reply";
};

export type RevisionRequest = { artifactId: ArtifactId; baseRevision: RevisionId; instruction: string };
export type RevisionResult = {
  status: "applied" | "conflict";
  artifact: Artifact;
  undoRevision?: RevisionId;
  changeSummary: string;
};

export type FocusState = { projectId?: ProjectId; taskId?: TaskId; artifactId?: ArtifactId; nextStep?: string };
export type ProjectSnapshot = { focus: FocusState; artifactRevision?: RevisionId; savedAt: string };

/** Observation is never a FocusState mutation. */
export type ObservationEvent = {
  bundleId: string;
  windowId: string;
  siteOrigin?: string;
  text: string;
  capturedAt: string;
  grantVersion: number;
  truncated: boolean;
};

export type AttentionInput = {
  kind: "morning" | "task-return" | "evening";
  now: string;
  timezone: string;
  working: boolean;
  meeting: boolean;
  quiet: boolean;
  availability: "available" | "unknown";
  panelOpen: boolean;
  alreadyDelivered: boolean;
  hasPreparedWork: boolean;
};
export type AttentionDecision = "notify" | "panel-only" | "defer" | "suppress";

export type ActionIntent = {
  id: ActionId;
  ownerId: OwnerId;
  projectId: ProjectId;
  taskId?: TaskId;
  kind: "update-note" | "send-mail" | "post-message" | "send-document";
  destination: string;
  artifactId: ArtifactId;
  revision: RevisionId;
  instructionId: string;
  contentHash: string;
};
export type ActionReceipt = {
  id: ActionId;
  state: "pending" | "running" | "succeeded" | "failed" | "unknown";
  externalId?: string;
  verifiedAt?: string;
  logState: "not-due" | "pending" | "written" | "failed";
};

export type BriefInput = {
  ownerId: OwnerId;
  projects: ProjectId[];
  commitments: Commitment[];
  lastFocus: FocusState;
  evidence: Evidence[];
  now: string;
  timezone: string;
};
export type Brief = {
  kind: "morning" | "evening" | "reentry";
  items: string[];
  recommendedAction?: string;
  reason?: string;
  staleSourceIds: SourceId[];
};
