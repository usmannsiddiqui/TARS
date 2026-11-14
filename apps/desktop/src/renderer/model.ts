// View-model types: what the presentational screens take as props. Containers in live.tsx map
// Convex subscription results onto these; the test-only harness passes illustrative values.

/** An honest state that is never confused with Empty or Done. */
export type Honest =
  | { kind: "not-signed-in"; detail?: string }
  | { kind: "missing-access"; detail?: string }
  | { kind: "last-checked"; at: string }
  | { kind: "partial"; detail?: string }
  | { kind: "needs-retry"; detail?: string }
  /** An outcome nobody could confirm: never shown as done or as failed. */
  | { kind: "unknown"; detail?: string }
  | { kind: "stale"; at?: string; detail?: string }
  | { kind: "loading"; detail?: string }
  | { kind: "empty"; detail: string }
  | { kind: "done"; detail?: string };

export type PreparedStatus = "ready" | "needs-retry" | "invalidated" | "empty";

export type Evidence = { id: string; text: string; occurredAt: string; sourceUrl?: string; freshness: "current" | "stale" | "unknown" };

export type Prepared = {
  status: PreparedStatus;
  updatedAt: string;
  lastError?: string;
  work?: { title: string; body: string; evidenceIds: string[]; gaps: string[]; nextAction: string; state: "partial" | "ready" };
};

export type Commitment = {
  id: string;
  text: string;
  ownership: "user" | "other" | "unassigned";
  state: "open" | "waiting" | "user-reported-done" | "verified-done";
  dueAt?: string;
  evidenceIds: string[];
};

/** One project as Today sees it. `prepared` undefined means nothing has been prepared yet. */
export type ProjectSummary = {
  id: string;
  name: string;
  prepared?: Prepared;
  commitments: Commitment[];
};

/** A meeting or real due date from the brief service, with where it came from and how fresh that is. */
export type HardItem = {
  commitmentId: string;
  projectId: string;
  text: string;
  dueAt: string;
  kind: "meeting" | "deadline";
  sourceKind?: string;
  lastCheckedAt?: string;
  current: boolean;
};
export type Triage = { commitmentId: string; action: "prioritize" | "defer" | "renegotiate"; reason: string };

/** The pending daily brief (briefs.getPendingBrief). Evening has only `items`. */
export type Brief = {
  key: string;
  kind: "morning" | "evening";
  preparedAt: number;
  delivered: boolean;
  items: string[];
  hard: HardItem[];
  suggested: { projectId: string; text: string; commitmentId?: string }[];
  triage: Triage[];
  recommendedAction?: string;
  reason?: string;
  /** Sources the brief could not treat as current, named, with when they were last checked. */
  stale: { name: string; lastCheckedAt?: string }[];
};

/** Restart after days away (briefs.getReentry). */
export type Reentry = {
  since: string;
  changed: { evidenceId: string; text: string; occurredAt: string }[];
  changedCount: number;
  urgent: HardItem[];
  recommendedAction?: string;
  reason?: string;
};

export type Tradeoff = { commitmentId: string; text: string };
export type TradeoffChoice = "keep" | "defer" | "renegotiate";

/** Explicit work-session state, changed only by the user's Start / Break / Stop. */
export type SessionState = "idle" | "working" | "break";
export type SessionEvent = "start" | "break" | "resume" | "stop";

/** An instructed action's receipt (actions.listReceipts / executeIntent). */
export type Receipt = {
  id: string;
  state: "pending" | "running" | "succeeded" | "failed" | "unknown";
  externalId?: string;
  verifiedAt?: string;
  logState: "not-due" | "pending" | "written" | "failed";
  reason?: string;
};

export type CapturedIdea = { text: string };

export type Fact = { id: string; key: string; value: string; scope: "project" | "global"; evidenceIds: string[] };
export type Withheld = { id: string; key: string; value: string; evidenceIds: string[] };

export type CloudProvider = "slack" | "notion" | "canvas" | "gmail" | "outlook-mail" | "outlook-calendar";

export type SourceRow = {
  id: string;
  /** Cloud rows only: which provider's connect flow and controls apply. */
  provider?: CloudProvider;
  name: string;
  /** What this source reads, in one plain line. */
  coverage: string;
  group: "mac" | "cloud" | "optional";
  state: "off" | "on" | "paused" | "unavailable";
  /** Honest status beside on/off: last checked, missing access, needs retry, stale. */
  status?: Honest;
  /** Only for sources on this Mac: whether excerpts may leave the Mac. */
  cloudProcessing?: boolean;
  /** Observation rows: macOS Accessibility permission is off, so nothing can be read. */
  permissionMissing?: boolean;
  /** Why it cannot be turned on from here, when state is "unavailable". */
  unavailableReason?: string;
};

export type PetState = "idle" | "working" | "done";
