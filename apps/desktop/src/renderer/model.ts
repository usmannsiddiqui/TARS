// View-model: what the presentational screens take as props, and the pure derivations onto them.
// Containers in live.tsx map Convex subscription results onto these; the test-only harness passes
// illustrative values.

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
  kind: "send-mail" | "update-note";
  /** The address or Notion page id the user named. */
  destination: string;
  /** The run-through revision the instruction was bound to. */
  revision: string;
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
  /** Cloud rows: exactly what the stored grant reads (provider ids) and for which projects. */
  selection?: { selectors: string[]; projects: string[] };
};

export type PetState = "idle" | "working" | "done";

// ---- Pure derivations the screens and containers share (tested in tests/unit/renderer-view.test.ts).

/** One timed line of a run-through: "2. Live demo (10 min)". `line` is its index in the text. */
export type Segment = { line: number; title: string; minutes: number };
const TIMED = /^(\s*(?:\d+[.)]\s+|[-*•]\s+)?)(.*?)\s*\((\d{1,3})\s*(?:min|mins|minutes?)\)\s*$/i;

export function segmentsOf(text: string): Segment[] {
  return text.split("\n").flatMap((raw, line) => {
    const m = TIMED.exec(raw);
    return m ? [{ line, title: m[2]!.trim(), minutes: Number(m[3]) }] : [];
  });
}

/** Rewrites one segment's line, keeping its list marker; any other line is left as it was. */
export function setSegment(text: string, line: number, next: { title: string; minutes: number }): string {
  const lines = text.split("\n");
  const m = TIMED.exec(lines[line] ?? "");
  if (!m) return text;
  lines[line] = `${m[1]}${next.title} (${next.minutes} min)`;
  return lines.join("\n");
}

/** The main process reports a missing macOS Accessibility permission as the status reason. */
export const permissionMissing = (status: { freshness: string; reason?: string }) => status.reason === "permission-missing";

/** One row of connections.listConnections: the connection's health plus its grant's stored state. */
export type ConnectionRow = {
  sourceId: string;
  provider: string;
  availability: string;
  lastCheckedAt?: string;
  lastError?: string;
  state: string;
  selectors: string[];
  projectIds: string[];
};

/** A cloud provider's row: the live (active or paused) grant if any, else off; a revoked one says so. */
export function cloudRow(def: { provider: CloudProvider; name: string; coverage: string }, connections: ConnectionRow[], nameOf: (projectId: string) => string | undefined): SourceRow {
  const mine = connections.filter((c) => c.provider === def.provider);
  const c = mine.find((x) => x.state === "active" || x.state === "paused");
  const off: SourceRow = { id: def.provider, provider: def.provider, name: def.name, coverage: def.coverage, group: "cloud", state: "off" };
  if (!c) return mine.length > 0 ? { ...off, unavailableReason: "Disconnected. New reads stopped." } : off;
  const status: Honest =
    c.availability === "connected"
      ? c.lastCheckedAt
        ? { kind: "last-checked", at: c.lastCheckedAt }
        : { kind: "partial", detail: "Connected; not checked yet" }
      : c.availability === "stale"
        ? { kind: "stale", ...(c.lastCheckedAt ? { at: c.lastCheckedAt } : {}) }
        : c.availability === "missing-access"
          ? { kind: "missing-access", ...(c.lastError ? { detail: c.lastError } : {}) }
          : { kind: "needs-retry", ...(c.lastError ? { detail: c.lastError } : {}) };
  return {
    ...off,
    id: c.sourceId,
    state: c.state === "paused" ? "paused" : "on",
    status,
    selection: { selectors: c.selectors, projects: c.projectIds.map((id) => nameOf(id) ?? "a project no longer listed") },
  };
}
