// Contact policy, local deadlines and brief assembly. Pure: no I/O, no clock, no model.
// Whether to interrupt is decided only here, from data; a language model never decides to notify.
import type {
  AttentionDecision,
  AttentionInput,
  Brief,
  BriefInput,
  Commitment,
  PreparedWork,
  ProjectId,
  SourceId,
  SourceKind,
} from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---- Contact policy (invariants 7, 8).

/** notify | panel-only | defer | suppress. Evening is never a notification. */
export function decideAttention(input: AttentionInput): AttentionDecision {
  if (!input.hasPreparedWork) return "suppress";
  if (input.kind === "evening") return input.panelOpen ? "panel-only" : "defer";
  if (input.alreadyDelivered) return "suppress";
  if (input.panelOpen) return "panel-only";
  if (input.working || input.meeting || input.quiet || input.availability !== "available") return "defer";
  return "notify";
}

/** "return" = the Mac woke/unlocked or the app regained the user: never proof of availability. */
export type SessionEventKind = "start" | "stop" | "break" | "resume" | "meeting-start" | "meeting-end" | "return";
export type SessionEvent = { kind: SessionEventKind; at: number };

/** Working/meeting from explicit events only; availability is known only after an explicit event today. */
export function sessionState(
  events: readonly SessionEvent[],
  nowMs: number,
  timezone: string,
): Pick<AttentionInput, "working" | "meeting" | "availability"> {
  let working = false;
  let meeting = false;
  let lastExplicit: number | undefined;
  for (const event of [...events].filter((e) => e.at <= nowMs).sort((a, b) => a.at - b.at)) {
    if (event.kind === "return") continue;
    if (event.kind === "start" || event.kind === "resume") working = true;
    if (event.kind === "stop" || event.kind === "break") working = false;
    if (event.kind === "meeting-start") meeting = true;
    if (event.kind === "meeting-end") meeting = false;
    lastExplicit = event.at;
  }
  const known = lastExplicit !== undefined && localDate(lastExplicit, timezone) === localDate(nowMs, timezone);
  return { working, meeting, availability: known ? "available" : "unknown" };
}

export type QuietHours = { start: string; end: string }; // local "HH:MM"; may wrap past midnight

export function isQuietTime(nowMs: number, timezone: string, quiet: QuietHours | undefined): boolean {
  if (quiet === undefined) return false;
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const p = wallParts(nowMs, timezone);
  const now = p.hour * 60 + p.minute;
  const [start, end] = [minutes(quiet.start), minutes(quiet.end)];
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

// ---- Gentle nudges for the user's own commitments with a due time.

export const NUDGE_GAP_MS = 2 * HOUR;
const DUE_SOON_MS = HOUR;

/** The one scheduled reminder per commitment: an hour before it is due. */
export const dueSoonAt = (dueAtMs: number) => dueAtMs - DUE_SOON_MS;

export type NudgeInput = {
  /** "return": the Mac woke/unlocked; "due-soon": the one job at dueSoonAt. */
  trigger: "return" | "due-soon";
  nowMs: number;
  commitment: Pick<Commitment, "ownership" | "state" | "dueAt">;
  /** When the last nudge was offered or the user said "Not now". */
  lastNudgedAt?: number;
  quiet: boolean;
  meeting: boolean;
  working: boolean;
};

/**
 * Only the user's open commitments with a future due time, never in quiet hours, a meeting or
 * active work. A return needs NUDGE_GAP_MS since the last nudge; the due-soon job does not.
 */
export function decideNudge(input: NudgeInput): boolean {
  const { commitment } = input;
  if (commitment.ownership !== "user" || commitment.state !== "open" || commitment.dueAt === undefined) return false;
  if (input.nowMs >= Date.parse(commitment.dueAt)) return false;
  if (input.quiet || input.meeting || input.working) return false;
  if (input.trigger === "due-soon") return true;
  return input.lastNudgedAt === undefined || input.nowMs - input.lastNudgedAt >= NUDGE_GAP_MS;
}

/** Plain and kind: no guilt, no counts, no streaks. */
export function nudgeCopy({ text, startedForYou }: { text: string; startedForYou: boolean }): { title: string; body: string } {
  return startedForYou
    ? { title: "Started for you", body: `${text}. I started this for you, want to finish it together?` }
    : { title: "When you're ready", body: `${text}. Your draft is here whenever you want it.` };
}

/** Key for a task-return invitation: `updatedAt` is that of the last preparation the user started. */
export function invitationKey(work: { projectId: ProjectId; updatedAt: string }): string {
  return `task:${work.projectId}@${work.updatedAt}`;
}

// ---- Local time with Intl only.

function wallParts(ms: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Throws RangeError for anything that is not an IANA timezone Intl knows. */
export function assertTimezone(timezone: string): void {
  new Intl.DateTimeFormat("en-US", { timeZone: timezone });
}

/** Local calendar date "YYYY-MM-DD" of an instant. */
export function localDate(ms: number, timezone: string): string {
  const p = wallParts(ms, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function offsetMs(ms: number, timezone: string): number {
  const p = wallParts(ms, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// shortcut: a wall time inside a DST gap lands one hour off; 09:00 and 19:30 are never in a real gap.
function wallToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(guess, timezone);
  return guess - offsetMs(first, timezone);
}

/** The first instant strictly after `afterMs` whose local wall time is hour:minute. */
export function nextLocalTime(afterMs: number, timezone: string, hour: number, minute: number): number {
  const p = wallParts(afterMs, timezone);
  for (let add = 0; add < 3; add++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + add));
    const candidate = wallToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, timezone);
    if (candidate > afterMs) return candidate;
  }
  throw new Error("no local deadline within three days");
}

export const MORNING = { hour: 9, minute: 0 };
export const EVENING = { hour: 19, minute: 30 };

const formatLocal = (iso: string, timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(Date.parse(iso));

// ---- Brief assembly.

export type BriefSource = {
  id: SourceId;
  kind: SourceKind;
  lastCheckedAt?: string;
  availability?: "connected" | "stale" | "missing-access" | "needs-retry";
};
export type BriefContext = BriefInput & { sources: BriefSource[]; preparedWork: PreparedWork[] };

/** A meeting or real due date, always with where it came from and how fresh that is. */
export type HardItem = {
  commitmentId: string;
  projectId: ProjectId;
  text: string;
  dueAt: string;
  kind: "meeting" | "deadline";
  sourceId?: SourceId;
  sourceKind?: SourceKind;
  lastCheckedAt?: string;
  current: boolean;
  label: string;
};
export type Suggestion = { projectId: ProjectId; text: string; commitmentId?: string };
/** A recommendation only: nothing is moved, sent or rescheduled. */
export type Triage = { commitmentId: string; action: "prioritize" | "defer" | "renegotiate"; reason: string };
export type DailyBrief = Omit<Brief, "kind"> & {
  kind: "morning" | "evening";
  hard: HardItem[];
  suggested: Suggestion[];
  triage: Triage[];
};

// shortcut: Canvas is refresh-only (build contract), so its age decides freshness; push sources rely
// on availability and evidence freshness. Tune the day threshold from use.
const CANVAS_STALE_AFTER = DAY;
const MAX_DUE_IN_A_DAY = 3;

function staleSources(context: BriefContext): Set<SourceId> {
  const now = Date.parse(context.now);
  const stale = new Set<SourceId>();
  for (const source of context.sources) {
    const checked = source.lastCheckedAt === undefined ? undefined : Date.parse(source.lastCheckedAt);
    if (
      (source.availability !== undefined && source.availability !== "connected") ||
      (source.kind === "canvas" && (checked === undefined || now - checked > CANVAS_STALE_AFTER))
    ) {
      stale.add(source.id);
    }
  }
  for (const record of context.evidence) if (record.freshness !== "current") stale.add(record.sourceId);
  return stale;
}

const userOpen = (commitments: readonly Commitment[]) => commitments.filter((c) => c.ownership === "user" && c.state === "open");

function hardItems(context: BriefContext, stale: Set<SourceId>): HardItem[] {
  const evidence = new Map(context.evidence.map((record) => [record.id as string, record]));
  const sources = new Map(context.sources.map((source) => [source.id as string, source]));
  return userOpen(context.commitments)
    .filter((c): c is Commitment & { dueAt: string } => c.dueAt !== undefined)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    .map((c) => {
      const record = c.evidenceIds.map((id) => evidence.get(id)).find((r) => r !== undefined);
      const source = record === undefined ? undefined : sources.get(record.sourceId);
      const current = source !== undefined && !stale.has(source.id);
      const due = `${c.text} — due ${formatLocal(c.dueAt, context.timezone)}`;
      const label =
        source === undefined
          ? `${due} (no linked source)`
          : current
            ? `${due} (${source.kind})`
            : `${due} (${source.kind}, last checked ${source.lastCheckedAt === undefined ? "never" : formatLocal(source.lastCheckedAt, context.timezone)}; may have changed)`;
      return {
        commitmentId: c.id,
        projectId: c.projectId,
        text: c.text,
        dueAt: c.dueAt,
        kind: source?.kind === "outlook-calendar" ? "meeting" : "deadline",
        ...(source === undefined ? {} : { sourceId: source.id, sourceKind: source.kind }),
        ...(source?.lastCheckedAt === undefined ? {} : { lastCheckedAt: source.lastCheckedAt }),
        current,
        label,
      };
    });
}

/** Chosen focus first, then other projects; each: focus step / prepared next action, then undated tasks. */
function suggestions(context: BriefContext): Suggestion[] {
  const focus = context.lastFocus.projectId;
  const order = [...(focus === undefined ? [] : [focus]), ...context.projects.filter((p) => p !== focus)];
  const undated = userOpen(context.commitments).filter((c) => c.dueAt === undefined);
  return order.flatMap((projectId) => {
    const step =
      projectId === focus && context.lastFocus.nextStep !== undefined
        ? context.lastFocus.nextStep
        : context.preparedWork.find((w) => w.projectId === projectId)?.nextAction;
    return [
      ...(step === undefined ? [] : [{ projectId, text: step }]),
      ...undated.filter((c) => c.projectId === projectId).map((c) => ({ projectId, text: c.text, commitmentId: c.id })),
    ];
  });
}

/** One starting point. The chosen focus wins unless an evidence-backed due date within a day outranks it. */
function recommend(context: BriefContext, hard: HardItem[], suggested: Suggestion[]): Pick<Brief, "recommendedAction" | "reason"> {
  const now = Date.parse(context.now);
  const urgent = hard.find((item) => item.sourceId !== undefined && Date.parse(item.dueAt) - now <= DAY);
  if (urgent !== undefined) {
    const freshness = urgent.current ? "" : " Its source may be out of date; check before relying on it.";
    return { recommendedAction: urgent.text, reason: `Due ${formatLocal(urgent.dueAt, context.timezone)}.${freshness}` };
  }
  const first = suggested[0];
  if (first !== undefined && first.projectId === context.lastFocus.projectId) {
    return { recommendedAction: first.text, reason: "You chose this last time; nothing due sooner is backed by your sources." };
  }
  const earliest = hard[0];
  if (earliest !== undefined) {
    return { recommendedAction: earliest.text, reason: `Earliest due: ${formatLocal(earliest.dueAt, context.timezone)}.` };
  }
  return first === undefined ? {} : { recommendedAction: first.text, reason: "Next prepared step." };
}

/** When more is due within a day than fits: what to prioritize, defer or renegotiate. Changes nothing. */
function triage(context: BriefContext, hard: HardItem[], suggested: Suggestion[]): Triage[] {
  const now = Date.parse(context.now);
  const dueSoon = hard.filter((item) => Date.parse(item.dueAt) - now <= DAY);
  if (dueSoon.length <= MAX_DUE_IN_A_DAY) return [];
  return [
    ...dueSoon.map((item, i): Triage =>
      i < MAX_DUE_IN_A_DAY
        ? { commitmentId: item.commitmentId, action: "prioritize", reason: "Due soonest." }
        : { commitmentId: item.commitmentId, action: "renegotiate", reason: `Due within a day after ${MAX_DUE_IN_A_DAY} earlier deadlines; consider asking to move it.` },
    ),
    ...suggested.flatMap((s): Triage[] =>
      s.commitmentId === undefined ? [] : [{ commitmentId: s.commitmentId, action: "defer", reason: "No due date; can wait until today's deadlines are done." }],
    ),
  ];
}

export function assembleBrief(context: BriefContext, kind: "morning" | "evening"): DailyBrief {
  const stale = staleSources(context);
  const staleSourceIds = [...stale].sort();
  if (kind === "evening") {
    const done = context.commitments.flatMap((c) =>
      c.state === "verified-done" ? [`Done (verified): ${c.text}`] : c.state === "user-reported-done" ? [`Done (you reported): ${c.text}`] : [],
    );
    const parked = userOpen(context.commitments).map((c) => `Parked: ${c.text}`);
    return { kind, items: [...done, ...parked], staleSourceIds, hard: [], suggested: [], triage: [] };
  }
  const hard = hardItems(context, stale);
  const suggested = suggestions(context);
  return {
    kind,
    items: [...hard.map((item) => item.label), ...suggested.map((s) => s.text)],
    ...recommend(context, hard, suggested),
    staleSourceIds,
    hard,
    suggested,
    triage: triage(context, hard, suggested),
  };
}

// ---- Re-entry after time away.

export type Reentry = {
  since: string | null;
  changed: { evidenceId: string; sourceId: SourceId; text: string; occurredAt: string }[];
  changedCount: number;
  urgent: HardItem[];
  recommendedAction?: string;
  reason?: string;
  backlog: Commitment[]; // every commitment, unchanged
  staleSourceIds: SourceId[];
};

const MAX_CHANGED_SHOWN = 10;
const URGENT_WITHIN = 2 * DAY;

export function summarizeReentry(context: BriefContext, since: string | null): Reentry {
  const brief = assembleBrief(context, "morning");
  const now = Date.parse(context.now);
  const changed = context.evidence
    .filter((record) => since === null || record.receivedAt > since)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return {
    since,
    changed: changed.slice(0, MAX_CHANGED_SHOWN).map((r) => ({ evidenceId: r.id, sourceId: r.sourceId, text: r.text.slice(0, 140), occurredAt: r.occurredAt })),
    changedCount: changed.length,
    urgent: brief.hard.filter((item) => Date.parse(item.dueAt) - now <= URGENT_WITHIN),
    ...(brief.recommendedAction === undefined ? {} : { recommendedAction: brief.recommendedAction }),
    ...(brief.reason === undefined ? {} : { reason: brief.reason }),
    backlog: context.commitments,
    staleSourceIds: brief.staleSourceIds,
  };
}

// ---- New-commitment tradeoffs.

export const commitmentKey = (c: Pick<Commitment, "projectId" | "text">) => `${c.projectId}:${c.text.toLowerCase().replace(/\s+/g, " ").trim()}`;

/** A concrete clash: the new task is due within a day of existing user tasks. Null when none. */
export function detectTradeoff(candidate: Commitment, existing: readonly Commitment[]): string | null {
  if (candidate.ownership !== "user" || candidate.state !== "open" || candidate.dueAt === undefined) return null;
  const due = Date.parse(candidate.dueAt);
  const clashes = userOpen(existing).filter(
    (c) => c.id !== candidate.id && c.dueAt !== undefined && Math.abs(Date.parse(c.dueAt) - due) <= DAY,
  );
  if (clashes.length === 0) return null;
  return `"${candidate.text}" is due within a day of ${clashes.map((c) => `"${c.text}"`).join(", ")}. Choose what goes first; nothing will be moved or sent.`;
}
