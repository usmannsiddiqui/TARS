// View-model: what the presentational screens take as props, and the pure derivations onto them.
// Containers in live.tsx map Convex subscription results onto these; the test-only harness passes
// illustrative values.
import type { BlockProps } from "@companion/domain/thread";

/** An honest state that is never confused with Empty or Done. */
export type Honest =
  | { kind: "not-signed-in"; detail?: string }
  | { kind: "missing-access"; detail?: string }
  | { kind: "last-checked"; at: string; detail?: string }
  | { kind: "partial"; detail?: string }
  | { kind: "needs-retry"; detail?: string }
  /** An outcome nobody could confirm: never shown as done or as failed. */
  | { kind: "unknown"; detail?: string }
  | { kind: "stale"; at?: string; detail?: string }
  | { kind: "loading"; detail?: string }
  /** One of TARS's helpers is preparing work right now. */
  | { kind: "working"; detail?: string }
  | { kind: "empty"; detail: string }
  | { kind: "done"; detail?: string }
  /** Something TARS will really do at a set time (a scheduled brief deadline). */
  | { kind: "scheduled"; detail?: string }
  /** A draft only the user can see, or one anyone with its read-only link can open. */
  | { kind: "private"; detail?: string }
  | { kind: "shared"; detail?: string };

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
  /** Morning only: what it read, per kind (briefs.getPendingBrief `read`); absent on older briefs. */
  read?: { kind: string; count: number }[];
};

// What each kind of input reads as, in the order the rows are shown (meetings, mail, deadlines, chat, notes, code, commitments).
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const READ_WORDS: Record<string, (n: number) => string> = {
  "outlook-calendar": (n) => (n === 1 ? "Read today's meeting" : `Read today's ${n} meetings`),
  gmail: (n) => `Read ${plural(n, "new email")}`,
  "outlook-mail": (n) => `Read ${plural(n, "new email")}`,
  canvas: (n) => `Checked ${plural(n, "Canvas deadline")}`,
  slack: (n) => `Read ${plural(n, "new Slack message")}`,
  teams: (n) => `Read ${plural(n, "new Teams message")}`,
  notion: (n) => `Looked over ${plural(n, "Notion update")}`,
  obsidian: (n) => `Looked over ${plural(n, "changed note")}`,
  github: (n) => `Checked ${plural(n, "GitHub update")}`,
  "claude-code": (n) => `Looked over ${plural(n, "Claude Code session note")}`,
  codex: (n) => `Looked over ${plural(n, "Codex session note")}`,
  observation: (n) => `Looked over ${plural(n, "note", "notes")} from your apps`,
  commitments: (n) => `Went through ${plural(n, "open commitment")}`,
};
const READ_ORDER = Object.keys(READ_WORDS);

/** One row per kind the brief really read: its kind (for the logo) and a sentence with the real count. Zero and unknown kinds get none. */
export function readRows(read: Brief["read"]): { kind: string; text: string }[] {
  return (read ?? [])
    .filter((r) => r.count > 0 && READ_WORDS[r.kind])
    .sort((a, b) => READ_ORDER.indexOf(a.kind) - READ_ORDER.indexOf(b.kind))
    .map((r) => ({ kind: r.kind, text: READ_WORDS[r.kind]!(r.count) }));
}

export type BriefListItem = { text: string; projectId: string; kind: HardItem["kind"] | "suggested"; dueAt?: string; recommended: boolean };
const BRIEF_LIST_MAX = 5;

/** The brief as a short numbered list: the recommended start first, then meetings and real due dates, then suggestions; each once, at most five. */
export function briefList(brief: Pick<Brief, "hard" | "suggested" | "recommendedAction">): BriefListItem[] {
  const all: BriefListItem[] = [
    ...brief.hard.map((h) => ({ text: h.text, projectId: h.projectId, kind: h.kind, dueAt: h.dueAt, recommended: false })),
    ...brief.suggested.map((s) => ({ text: s.text, projectId: s.projectId, kind: "suggested" as const, recommended: false })),
  ];
  const start = all.find((i) => i.text === brief.recommendedAction);
  const ordered = start ? [{ ...start, recommended: true }, ...all.filter((i) => i.text !== start.text)] : all;
  return ordered.slice(0, BRIEF_LIST_MAX);
}

/** The brief's schedule in words, from the next scheduled run (briefs.getSchedule): it runs every day at that local time. */
export function briefSchedule(morningAt: number, timezone: string, now: number): { routine: string; at: string; next: string } {
  const at = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(morningAt);
  const day = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(ms); // YYYY-MM-DD
  const when =
    day(morningAt) === day(now)
      ? "today"
      : day(morningAt) === day(now + 864e5)
        ? "tomorrow"
        : new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(morningAt);
  return { routine: `Every day · ${at}`, at, next: `${when}, ${at}` };
}

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
/** A gentle nudge for one of your due commitments ("started for you" the first time), as briefs.listNudgeOffers returns it. */
export type NudgeOffer = { nudgeId: string; projectId: string; key: string; title: string; body: string; startedForYou: boolean; delivered: boolean };
export type NudgeChoice = "finish" | "not-now";
export type TradeoffChoice = "keep" | "defer" | "renegotiate";

/** Explicit work-session state, changed only by the user's Start / Break / Stop. */
export type SessionState = "idle" | "working" | "break";
export type SessionEvent = "start" | "break" | "resume" | "stop";

/** An instructed action's receipt (actions.listReceipts / executeIntent). */
export type Receipt = {
  id: string;
  kind: "send-mail" | "update-note" | "post-message" | "send-document";
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

export type CloudProvider = "slack" | "notion" | "canvas" | "gmail" | "outlook-mail" | "outlook-calendar" | "teams" | "github";

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
  /** Cloud rows that can send (Composio Gmail and Slack): the separate permission to send, as it stands. */
  sending?: "allowed" | "not-allowed";
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
  broker?: "composio";
  availability: string;
  lastCheckedAt?: string;
  checkedVia?: "pushed" | "opened";
  lastError?: string;
  state: string;
  selectors: string[];
  projectIds: string[];
  sending?: "allowed" | "not-allowed";
};

const CHECKED_VIA = { pushed: "pushed by Composio", opened: "checked when you opened TARS" } as const;

/** A cloud provider's row: the live (active or paused) grant if any, else off; a revoked one says so. */
export function cloudRow(def: { provider: CloudProvider; name: string; coverage: string }, connections: ConnectionRow[], nameOf: (projectId: string) => string | undefined): SourceRow {
  const mine = connections.filter((c) => c.provider === def.provider);
  const c = mine.find((x) => x.state === "active" || x.state === "paused");
  const off: SourceRow = { id: def.provider, provider: def.provider, name: def.name, coverage: def.coverage, group: "cloud", state: "off" };
  if (!c) return mine.length > 0 ? { ...off, unavailableReason: "Disconnected. New reads stopped." } : off;
  const status: Honest =
    c.availability === "connected"
      ? c.lastCheckedAt
        ? { kind: "last-checked", at: c.lastCheckedAt, ...(c.checkedVia ? { detail: CHECKED_VIA[c.checkedVia] } : {}) }
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
    ...(c.sending ? { sending: c.sending } : {}),
  };
}

const HOST_KIND: [host: string, kind: string][] = [
  ["slack.com", "slack"],
  ["mail.google.com", "gmail"],
  ["notion.so", "notion"],
  ["notion.site", "notion"],
  ["instructure.com", "canvas"],
  ["outlook.office.com", "outlook"],
  ["outlook.office365.com", "outlook"],
  ["outlook.live.com", "outlook"],
  ["github.com", "github"],
];

/**
 * The source kind an item's https link points at, from its host (exact or a subdomain), so a chip can show
 * where it came from. Unknown hosts (a Canvas on its own domain, say) are not guessed.
 */
export function kindFromUrl(url: string | undefined): string | undefined {
  const u = url !== undefined && URL.canParse(url) ? new URL(url) : undefined;
  if (u?.protocol !== "https:") return undefined;
  const kind = HOST_KIND.find(([host]) => u.hostname === host || u.hostname.endsWith(`.${host}`))?.[1];
  return kind === "outlook" ? (u.pathname.startsWith("/calendar") ? "outlook-calendar" : "outlook-mail") : kind;
}

/** One of TARS's helpers: a preparation that is waiting, running or failed (listActiveRuns). */
export type HelperRun = {
  projectId: string;
  projectName: string;
  state: "pending" | "running" | "failed";
  stage?: "reading" | "drafting" | "saving";
  sources: { kind: string; count: number }[];
};

const STAGE_WORDS = {
  reading: "Reading this project's sources",
  saving: "Checking it against your sources, then saving",
} as const;

/** A helper card's words, only from the stage the run is really in: no percentage, no timer. */
export function helperWords(run: HelperRun): { state: Honest; doing: string } {
  if (run.state === "failed") return { state: { kind: "needs-retry" }, doing: "The last preparation failed; the earlier version is kept." };
  if (run.state === "pending" || run.stage === undefined) return { state: { kind: "working" }, doing: "Starting" };
  if (run.stage !== "drafting") return { state: { kind: "working" }, doing: STAGE_WORDS[run.stage] };
  const items = run.sources.reduce((n, s) => n + s.count, 0);
  return { state: { kind: "working" }, doing: `Drafting from ${items} ${items === 1 ? "item" : "items"}` };
}

/** A project's preparation as one honest state, for the rail, Today and the project index. */
export function preparedNote(p: ProjectSummary): Honest {
  if (p.prepared === undefined) return { kind: "empty", detail: "Nothing prepared yet" };
  if (p.prepared.status === "needs-retry") return { kind: "needs-retry", detail: "Last preparation failed" };
  if (p.prepared.status === "invalidated") return { kind: "partial", detail: "Something it used was forgotten" };
  if (p.prepared.status === "empty" || !p.prepared.work) return { kind: "empty", detail: "No source items yet" };
  return p.prepared.work.state === "partial" ? { kind: "partial", detail: p.prepared.work.title } : { kind: "done", detail: p.prepared.work.title };
}

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const formatTime = (ms: number) => new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(ms);
const dayName = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });

/** Groups items by the Mac's local calendar day, keeping the order given; today, tomorrow and yesterday by name. */
export function byDay<T>(items: readonly T[], at: (item: T) => number, now: number): { key: string; label: string; items: T[] }[] {
  const near: Record<string, string> = { [dayKey(now)]: "Today", [dayKey(now + 864e5)]: "Tomorrow", [dayKey(now - 864e5)]: "Yesterday" };
  const days: { key: string; label: string; items: T[] }[] = [];
  for (const item of items) {
    const key = dayKey(at(item));
    let day = days.find((d) => d.key === key);
    if (!day) days.push((day = { key, label: near[key] ?? dayName.format(at(item)), items: [] }));
    day.items.push(item);
  }
  return days;
}

/** `source`: the display name of the source a source check is about, for its chip. */
export type CalendarEntry = { at: number; title: string; detail?: string; state: Honest; source?: string };
export type CalendarInput = {
  now: number;
  /** briefs.getSchedule: the next scheduled deadlines, null until the timezone is set. */
  schedule: { morningAt: number; eveningAt: number } | null;
  /** The pending morning brief and evening recap, as prepared. */
  briefs: { kind: "morning" | "evening"; preparedAt: number; delivered: boolean }[];
  projects: ProjectSummary[];
  /** Cloud connections by display name, with their health. */
  sources: { name: string; availability: string; lastCheckedAt?: string; lastError?: string }[];
};

/**
 * TARS's own calendar: what it will do (only real scheduled deadlines), what it did (from stored
 * timestamps) and what needs a look. Nothing is estimated; a value that is not stored is not shown.
 */
export function tarsCalendar({ now, schedule, briefs, projects, sources }: CalendarInput): { upcoming: CalendarEntry[]; done: CalendarEntry[]; attention: CalendarEntry[] } {
  const upcoming: CalendarEntry[] = schedule
    ? [
        { at: schedule.morningAt, title: "Morning brief", detail: "Meetings, real deadlines and one recommended start", state: { kind: "scheduled" } },
        { at: schedule.eveningAt, title: "Evening recap", detail: "What was finished or parked today", state: { kind: "scheduled" } },
      ]
    : [];
  const done: CalendarEntry[] = briefs.map((b) => ({
    at: b.preparedAt,
    title: b.kind === "morning" ? "Prepared the morning brief" : "Prepared the evening recap",
    detail: b.delivered ? "Shown to you" : "Not shown to you yet",
    state: { kind: "done" },
  }));
  const attention: CalendarEntry[] = [];
  for (const p of projects) {
    const at = p.prepared ? Date.parse(p.prepared.updatedAt) : NaN;
    if (!p.prepared || Number.isNaN(at)) continue;
    const { status, work, lastError } = p.prepared;
    if (status === "needs-retry") attention.push({ at, title: `Could not prepare ${p.name}`, state: { kind: "needs-retry", detail: `${formatTime(at)}${lastError ? ` (${lastError})` : ""}. Earlier work is kept.` } });
    else if (status === "empty") done.push({ at, title: `Looked for work in ${p.name}`, detail: "No source items yet", state: { kind: "empty", detail: "" } });
    else if (work) {
      const from = `from ${work.evidenceIds.length} source item${work.evidenceIds.length === 1 ? "" : "s"}`;
      done.push({ at, title: `Prepared ${p.name}`, detail: `${work.title} · ${from}`, state: { kind: status === "invalidated" || work.state === "partial" ? "partial" : "done" } });
    }
  }
  for (const s of sources) {
    const at = s.lastCheckedAt ? Date.parse(s.lastCheckedAt) : NaN;
    if (s.availability === "connected") {
      if (!Number.isNaN(at)) done.push({ at, title: `Checked ${s.name}`, state: { kind: "done" }, source: s.name });
    } else {
      // The state carries its own detail, so the screen shows it as one glyph-and-word note.
      const detail = s.lastError ? { detail: s.lastError } : {};
      const state: Honest =
        s.availability === "stale"
          ? Number.isNaN(at)
            ? { kind: "stale", detail: "Never checked" }
            : { kind: "stale", at: new Date(at).toISOString() }
          : s.availability === "missing-access"
            ? { kind: "missing-access", ...detail }
            : { kind: "needs-retry", ...detail };
      const title = s.availability === "stale" ? `${s.name} may be out of date` : s.availability === "missing-access" ? `${s.name} needs access` : `${s.name} needs a retry`;
      attention.push({ at: Number.isNaN(at) ? now : at, title, state, source: s.name });
    }
  }
  return {
    upcoming: upcoming.filter((e) => e.at > now).sort((a, b) => a.at - b.at),
    done: done.filter((e) => e.at <= now).sort((a, b) => b.at - a.at),
    attention,
  };
}

// ---- The three-pane shell: Today as one thread, the left list's previews and the right pane's routines.

/** One message in a thread: TARS's blocks (the catalog in packages/domain/src/thread.ts) or the user's words. `createdAt` only when stored. */
export type ThreadMessage = { id: string; role: "tars" | "user"; text?: string; blocks: unknown[]; createdAt?: number };
type DumpView = BlockProps<"sorted">["view"];
type StartItem = BlockProps<"start">["items"][number];

export type TodayInput = {
  now: number;
  /** undefined while loading, null when none is prepared yet. */
  brief: Brief | null | undefined;
  briefError?: string;
  /** The morning brief's local time (briefSchedule), only once the schedule exists. */
  schedule?: { at: string };
  reentry?: Reentry;
  helpers: HelperRun[];
  nudge?: NudgeOffer;
  tradeoff?: Tradeoff;
  /** Captures still on this Mac (no stored time). */
  ideas: CapturedIdea[];
  /** The brain dump saved in this window, when he saved it, and its sort. */
  dump?: { text: string; at: number; view?: DumpView };
  projects: ProjectSummary[];
};

const say = (id: string, text: string) => ({ id, type: "say", props: { text } });
const tars = (id: string, blocks: unknown[], createdAt?: number): ThreadMessage => ({ id, role: "tars", blocks, ...(createdAt === undefined ? {} : { createdAt }) });
const VERB = /^(Looked over|Went through|\S+) (.+)$/;

function startBlock(id: string, items: BriefListItem[], projects: ProjectSummary[], reason: string | undefined) {
  const named: StartItem[] = items.map(({ dueAt, ...item }) => {
    const projectName = projects.find((p) => p.id === item.projectId)?.name;
    return { ...item, ...(dueAt ? { dueAt } : {}), ...(projectName ? { projectName } : {}) };
  });
  const recommended = named.find((i) => i.recommended);
  return { id, type: "start", props: { items: named, ...(reason ? { reason } : {}), ...(recommended ? { projectId: recommended.projectId } : {}) } };
}

const STAGES = ["reading", "drafting", "saving"] as const;

function helperMessage(run: HelperRun): ThreadMessage {
  const id = `run:${run.projectId}`;
  const name = run.projectName;
  if (run.state === "failed") {
    return tars(id, [
      {
        id: "ask",
        type: "ask",
        props: { id, title: `Could not prepare ${name}`, text: "The last preparation failed; the earlier version is kept.", choices: [{ id: "retry", label: "Try again" }, { id: "dismiss", label: "Dismiss" }] },
      },
    ]);
  }
  const items = run.sources.reduce((n, s) => n + s.count, 0);
  const current = run.state === "pending" || run.stage === undefined ? -1 : STAGES.indexOf(run.stage);
  const words: Record<(typeof STAGES)[number], [string, string]> = {
    reading: [`Reading sources for ${name}`, `Read sources for ${name}`],
    drafting: [`Drafting ${name}${current >= 1 ? ` from ${items} ${items === 1 ? "item" : "items"}` : ""}`, `Drafted ${name}`],
    saving: [`Checking and saving ${name}`, `Checked and saved ${name}`],
  };
  const steps = STAGES.map((stage, i) => ({
    id: stage,
    label: words[stage][0],
    doneLabel: words[stage][1],
    status: i < current ? "done" : i === current ? "running" : "waiting",
    ...(stage === "drafting" && run.sources.length > 0 && current >= 1 ? { sources: run.sources } : {}),
  }));
  return tars(id, [{ id: "work", type: "work", props: { steps } }]);
}

/**
 * Today as one thread, built from subscriptions that already exist: re-entry or the brief, each helper run,
 * the open nudge and tradeoff, then his captures and the latest sort. Nothing new is stored or invented.
 */
export function todayThread(t: TodayInput): ThreadMessage[] {
  if (t.projects.length === 0) return [tars("first", [say("first", "Name the first thing you are working on. You can add the others later.")])];
  const out: ThreadMessage[] = [];
  if (t.briefError) out.push(tars("brief-error", [say("error", `Could not read today's brief: ${t.briefError}`)]));
  if (t.reentry) {
    const r = t.reentry;
    const changed = r.changed.map((c) => ({ id: c.evidenceId, text: c.text }));
    if (r.changedCount > r.changed.length) changed.push({ id: "more", text: `and ${r.changedCount - r.changed.length} more in your sources` });
    const urgent = r.urgent.map((h): BriefListItem => ({ text: h.text, projectId: h.projectId, kind: h.kind, dueAt: h.dueAt, recommended: h.text === r.recommendedAction }));
    out.push(
      tars(
        "reentry",
        [
          say("welcome", `Welcome back. Since ${formatTime(Date.parse(r.since))}, nothing was moved, deleted or sent.`),
          ...(changed.length ? [{ id: "changed", type: "results", props: { items: changed } }] : [say("changed", "Nothing new arrived from your sources.")]),
          ...(urgent.length ? [startBlock("urgent", [...urgent.filter((i) => i.recommended), ...urgent.filter((i) => !i.recommended)], t.projects, r.reason)] : []),
        ],
        t.now,
      ),
    );
  } else if (t.brief === undefined) {
    out.push(tars("brief", [say("loading", "Reading today's brief…")]));
  } else if (t.brief === null) {
    out.push(tars("brief", [say("none", t.schedule ? `No brief yet. The first one comes at ${t.schedule.at}.` : "No brief yet.")]));
  } else if (t.brief.kind === "evening") {
    const b = t.brief;
    const recap = b.items.length ? { id: "recap", type: "results", props: { items: b.items.map((text, i) => ({ id: String(i), text })) } } : say("empty", "Nothing finished or parked today. That is fine.");
    out.push(tars(b.key, [recap, say("tonight", "Nothing else is needed tonight.")], b.preparedAt));
  } else {
    const b = t.brief;
    const read = readRows(b.read).map((r) => {
      const [, verb, text] = VERB.exec(r.text) ?? [];
      return { id: r.kind, kind: r.kind, ...(verb && text ? { verb, text } : { text: r.text }) };
    });
    const items = briefList(b);
    out.push(
      tars(
        b.key,
        [
          ...(read.length ? [{ id: "read", type: "results", props: { items: read } }] : []),
          items.length ? startBlock("start", items, t.projects, b.reason) : say("nothing", "Nothing is due and nothing is suggested yet."),
          ...b.stale.map((s) => say(`stale:${s.name}`, `${s.name} may be out of date, ${s.lastCheckedAt ? `last checked ${formatTime(Date.parse(s.lastCheckedAt))}` : "never checked"}.`)),
        ],
        b.preparedAt,
      ),
    );
  }
  out.push(...t.helpers.map(helperMessage));
  if (t.nudge) {
    const id = `nudge:${t.nudge.nudgeId}`;
    out.push(tars(id, [{ id: "ask", type: "ask", props: { id, title: t.nudge.title, text: t.nudge.body, choices: [{ id: "finish", label: "Finish it" }, { id: "not-now", label: "Not now" }], primaryId: "finish" } }]));
  }
  if (t.tradeoff) {
    const id = `tradeoff:${t.tradeoff.commitmentId}`;
    const choices = [{ id: "keep", label: "Keep both" }, { id: "defer", label: "Defer the new one" }, { id: "renegotiate", label: "Renegotiate a deadline" }];
    out.push(tars(id, [{ id: "ask", type: "ask", props: { id, title: "A new commitment competes", text: t.tradeoff.text, choices, note: "Your choice is recorded once. Nothing is moved, rescheduled or sent." } }]));
  }
  t.ideas.forEach((idea, i) => {
    if (idea.text !== t.dump?.text) out.push({ id: `idea:${i}`, role: "user", text: idea.text, blocks: [] });
  });
  if (t.dump) {
    out.push({ id: "dump", role: "user", text: t.dump.text, blocks: [], createdAt: t.dump.at });
    if (t.dump.view) out.push(tars("sorted", [{ id: "sorted", type: "sorted", props: { view: t.dump.view } }]));
  }
  return out;
}

const clockFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const weekdayFmt = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const shortDayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const shortDueFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
const monthDayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** A row's time: the clock today, "Yesterday", the weekday within the week, else "Nov 3". */
export function rowTime(ms: number, now: number): string {
  const days = Math.round((Date.parse(dayKey(now)) - Date.parse(dayKey(ms))) / 864e5);
  return days <= 0 ? clockFmt.format(ms) : days === 1 ? "Yesterday" : days < 7 ? weekdayFmt.format(ms) : monthDayFmt.format(ms);
}

export type RowPreview = { text: string; time?: number; warn?: boolean };

/** A project row's second line: first match wins, from stored data only. */
export function rowPreview(p: ProjectSummary, ctx: { helpers: HelperRun[]; nudgeProjectId?: string }): RowPreview {
  const updated = p.prepared ? Date.parse(p.prepared.updatedAt) : NaN;
  const time = Number.isNaN(updated) ? {} : { time: updated };
  const run = ctx.helpers.find((h) => h.projectId === p.id);
  if (run && run.state !== "failed") return { text: run.state === "pending" ? "Waiting in line…" : "Working…", ...time };
  if (run?.state === "failed" || p.prepared?.status === "needs-retry") return { text: "Needs retry", warn: true, ...time };
  if (ctx.nudgeProjectId === p.id) return { text: "Needs an answer", ...time };
  const open = p.commitments.filter((c) => c.state === "open" || c.state === "waiting");
  const next = (list: Commitment[]) => list.flatMap((c) => (c.dueAt ? [Date.parse(c.dueAt)] : [])).sort((a, b) => a - b)[0];
  if (p.prepared?.status === "ready" && p.prepared.work) {
    const due = next(open.filter((c) => c.ownership === "user"));
    return { text: due === undefined ? "Draft ready" : `Draft ready · due ${shortDueFmt.format(due)}`, ...time };
  }
  if (open.length > 0) {
    const due = next(open);
    return { text: `${open.length} open${due === undefined ? "" : `, next due ${shortDayFmt.format(due)}`}`, ...time };
  }
  return { text: "Nothing prepared yet", ...time };
}

/** The Today row's second line, from the brief's real state. */
export function todayPreview(brief: Brief | null | undefined, schedule: { at: string } | undefined, projects: ProjectSummary[]): RowPreview {
  if (brief === undefined) return { text: "Reading today's brief…" };
  if (brief === null) return { text: schedule ? `No brief yet. First one at ${schedule.at}` : "No brief yet" };
  if (brief.kind === "evening") return { text: `Recap ready. ${brief.items.length} ${brief.items.length === 1 ? "thing" : "things"} today`, time: brief.preparedAt };
  const items = briefList(brief);
  const start = projects.find((p) => p.id === items.find((i) => i.recommended)?.projectId)?.name;
  return { text: `Brief ready. ${items.length} ${items.length === 1 ? "item" : "items"}${start ? `, start with ${start}` : ""}`, time: brief.preparedAt };
}

export type RoutineRow = { id: "morning" | "evening"; name: string; summary: string };

/** The right pane's routines, schedule first (briefs.getSchedule): undefined while loading, null before the timezone is set. */
export function routineRows(schedule: { timezone: string; morningAt: number; eveningAt: number } | null | undefined): RoutineRow[] {
  const when = (ms: number) =>
    schedule ? `Every day, ${new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone, hour: "numeric", minute: "2-digit" }).format(ms)}` : schedule === null ? "No schedule yet" : "Reading the schedule…";
  return [
    { id: "morning", name: "Morning brief", summary: when(schedule?.morningAt ?? 0) },
    { id: "evening", name: "Evening recap", summary: when(schedule?.eveningAt ?? 0) },
  ];
}
