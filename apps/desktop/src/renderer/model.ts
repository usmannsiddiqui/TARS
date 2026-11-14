// View-model types: what the presentational screens take as props. Containers in live.tsx map
// Convex subscription results onto these; the test-only harness passes illustrative values.

/** An honest state that is never confused with Empty or Done. */
export type Honest =
  | { kind: "not-signed-in"; detail?: string }
  | { kind: "missing-access"; detail?: string }
  | { kind: "last-checked"; at: string }
  | { kind: "partial"; detail?: string }
  | { kind: "needs-retry"; detail?: string }
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

export type Recommendation = { projectId: string; reason: string };

export type CapturedIdea = { text: string };

export type Fact = { id: string; key: string; value: string; scope: "project" | "global"; evidenceIds: string[] };
export type Withheld = { id: string; key: string; value: string; evidenceIds: string[] };

export type SourceRow = {
  id: string;
  name: string;
  /** What this source reads, in one plain line. */
  coverage: string;
  group: "mac" | "cloud" | "optional";
  state: "off" | "on" | "paused" | "unavailable";
  /** Honest status beside on/off: last checked, missing access, needs retry, stale. */
  status?: Honest;
  /** Only for sources on this Mac: whether excerpts may leave the Mac. */
  cloudProcessing?: boolean;
  /** Why it cannot be turned on from here, when state is "unavailable". */
  unavailableReason?: string;
};

export type PetState = "idle" | "working" | "done";
