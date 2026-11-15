// Grounded preparation policy: evidence selection and validation of model output. Pure: no I/O.
// Model output is untrusted: every ID it returns is checked against what was supplied, and
// ownership is decided here by rules, not taken from the model's say-so.
import { z } from "zod";
import { normalizeKey } from "./memory";
import type { Commitment, Evidence, EvidenceId, PreparedWork, ProjectId, SourceId } from "./types";

// ---- Structured output contracts sent to the model (strict JSON schema: every field required).
export const PreparationOutputSchema = z.strictObject({
  title: z.string(),
  body: z.string(),
  evidenceIds: z.array(z.string()),
  gaps: z.array(z.string()),
  nextAction: z.string(),
  commitments: z.array(
    z.strictObject({
      text: z.string(),
      holder: z.enum(["user", "other", "nobody"]),
      holderName: z.string().nullable(),
      explicit: z.boolean(),
      quote: z.string(),
      dueAt: z.string().nullable(),
      evidenceIds: z.array(z.string()),
    }),
  ),
  facts: z.array(z.strictObject({ key: z.string(), value: z.string(), evidenceIds: z.array(z.string()) })),
});
export type PreparationOutput = z.infer<typeof PreparationOutputSchema>;

export const SourceGroupsOutputSchema = z.strictObject({
  groups: z.array(
    z.strictObject({ projectName: z.string(), sourceIds: z.array(z.string()), reason: z.string() }),
  ),
});
export type SourceGroupProposal = { projectName: string; sourceIds: SourceId[]; reason: string };

// ---- Evidence selection: confirmed project + most recent, bounded. No embeddings.
export const EVIDENCE_LIMITS = { maxItems: 20, maxChars: 16_000 };

export function selectEvidence(
  evidence: readonly Evidence[],
  projectId: ProjectId,
  limits = EVIDENCE_LIMITS,
): { selected: Evidence[]; omitted: number } {
  const candidates = evidence
    .filter((record) => record.projectIds.includes(projectId))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const selected: Evidence[] = [];
  let chars = 0;
  for (const record of candidates) {
    if (selected.length >= limits.maxItems || chars + record.text.length > limits.maxChars) break;
    selected.push(record);
    chars += record.text.length;
  }
  return { selected, omitted: candidates.length - selected.length };
}

// ---- Validation.
// shortcut: phrase patterns catch common injection and vague-ownership wording only; the real
// guarantee is structural (this module creates no ActionIntent). Extend from observed misses.
const ADDRESSED_TO_ASSISTANT =
  /ignore (all |any )?(the )?(previous|prior|above|earlier) instructions|disregard (all |any )?(the )?(previous|prior|above|earlier)|system prompt|you are now|\b(assistant|ai|agent|bot)\s*:|\btars\s*[,:]/i;
const VAGUE_OWNERSHIP = /\b(someone|somebody|anyone|anybody|we should|we need to|it would be good)\b/i;
const MAX_NEXT_ACTION = 200;
const DAY_MS = 86_400_000;
const MAX_DUE_AHEAD_MS = 2 * 365 * DAY_MS;
const MAX_KEY = 80;
const MAX_VALUE = 500;

export type CommitmentDraft = Omit<Commitment, "id" | "ownerId" | "projectId">;
export type FactDraft = { key: string; value: string; evidenceIds: EvidenceId[] };
export type AssembledPreparation =
  | { ok: true; work: PreparedWork; commitments: CommitmentDraft[]; facts: FactDraft[] }
  | { ok: false; reason: "no_valid_evidence" | "empty_fields" | "next_action_not_one_step" };

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Turn untrusted model output into PreparedWork, commitments and facts. `supplied` is exactly
 * the evidence that was sent; `omitted` counts in-scope evidence left out by the bounds.
 */
export function assemblePreparation(
  output: PreparationOutput,
  projectId: ProjectId,
  supplied: readonly Evidence[],
  omitted: number,
): AssembledPreparation {
  const byId = new Map<string, Evidence>(supplied.map((record) => [record.id, record]));
  const valid = (ids: readonly string[]) => [...new Set(ids)].filter((id) => byId.has(id)) as EvidenceId[];
  const tainted = new Set(supplied.filter((record) => ADDRESSED_TO_ASSISTANT.test(record.text)).map((r) => r.id as string));

  const evidenceIds = valid(output.evidenceIds);
  if (evidenceIds.length === 0) return { ok: false, reason: "no_valid_evidence" };
  const title = output.title.trim();
  const body = output.body.trim();
  const nextAction = output.nextAction.trim();
  if (title === "" || body === "") return { ok: false, reason: "empty_fields" };
  if (nextAction === "" || nextAction.length > MAX_NEXT_ACTION || nextAction.includes("\n")) {
    return { ok: false, reason: "next_action_not_one_step" };
  }

  const gaps = output.gaps.map((gap) => gap.trim()).filter((gap) => gap !== "");
  // A deliverable marks what the evidence does not cover in place; each such line is a gap too.
  for (const [, need] of body.matchAll(/\[Needs from you:\s*([^\]\n]+?)\s*\]/g)) {
    if (!gaps.some((gap) => squash(gap) === squash(need!))) gaps.push(need!);
  }
  if (omitted > 0) gaps.push(omitted === 1 ? "1 older source was not read." : `${omitted} older sources were not read.`);
  if (evidenceIds.some((id) => byId.get(id)?.freshness !== "current")) gaps.push("Some cited sources may be out of date.");
  if (tainted.size > 0) gaps.push("A source contained instructions addressed to the assistant; they were ignored.");

  const commitments: CommitmentDraft[] = [];
  for (const item of output.commitments) {
    const text = item.text.trim();
    const ids = valid(item.evidenceIds);
    if (text === "" || ids.length === 0) continue; // no grounded evidence: not persisted
    const quote = squash(item.quote);
    const quoted = quote !== "" && ids.some((id) => squash(byId.get(id)!.text).includes(quote));
    const clear = item.explicit && quoted && !VAGUE_OWNERSHIP.test(quote) && !ids.some((id) => tainted.has(id));
    const ownership =
      clear && item.holder === "user"
        ? "user"
        : clear && item.holder === "other" && (item.holderName ?? "").trim() !== ""
          ? "other"
          : "unassigned";
    const dueAt = dueInstant(item.dueAt, ids.map((id) => Date.parse(byId.get(id)!.occurredAt)));
    commitments.push({
      text,
      ownership,
      state: ownership === "other" ? "waiting" : "open",
      evidenceIds: ids,
      ...(dueAt === undefined ? {} : { dueAt }),
    });
  }

  const facts: FactDraft[] = [];
  for (const item of output.facts) {
    const key = normalizeKey(item.key);
    const value = item.value.trim();
    const ids = valid(item.evidenceIds);
    if (key === "" || key.length > MAX_KEY || value === "" || value.length > MAX_VALUE) continue;
    if (ids.length === 0 || ids.some((id) => tainted.has(id))) continue;
    facts.push({ key, value, evidenceIds: ids });
  }

  return {
    ok: true,
    work: { projectId, title, body, evidenceIds, gaps, nextAction, state: gaps.length > 0 ? "partial" : "ready" },
    commitments,
    facts,
  };
}

/**
 * A model-given due time as a UTC "Z" instant, or undefined when it is not an ISO datetime (Z or
 * offset) or is absurd: more than two years after, or more than a day before, the evidence it cites.
 */
export function dueInstant(dueAt: string | null, writtenAt: readonly number[]): string | undefined {
  if (dueAt === null || !z.iso.datetime({ offset: true }).safeParse(dueAt).success) return undefined;
  const due = Date.parse(dueAt);
  if (due < Math.min(...writtenAt) - DAY_MS || due > Math.max(...writtenAt) + MAX_DUE_AHEAD_MS) return undefined;
  return new Date(due).toISOString();
}

export type PreparationClock =
  | { utc: string; timezone: string; localDate: string; localWeekday: string; localTime: string }
  | { utc: string; timezone: null; note: string };

/** The trusted "now" the model resolves relative deadlines with. No zone: it must not guess one. */
export function preparationClock(nowMs: number, timezone: string | null): PreparationClock {
  const utc = new Date(nowMs).toISOString();
  if (timezone === null) return { utc, timezone, note: "The user's time zone is not known: set every dueAt to null." };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(nowMs);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return {
    utc,
    timezone,
    localDate: `${get("year")}-${get("month")}-${get("day")}`,
    localWeekday: get("weekday"),
    localTime: `${get("hour")}:${get("minute")}`,
  };
}

type Matchable = { text: string; evidenceIds: readonly string[] };
const words = (text: string) => new Set(squash(text).split(/[^a-z0-9]+/).filter((w) => w.length > 0));

/**
 * Which stored commitment each new one continues (index into `stored`, or null when it is new).
 * Identity is the evidence it cites, not its wording: a pair must share a cited evidence ID. When
 * one message holds several, pairs with more words in common win, then earlier positions; each
 * stored commitment continues at most one new one.
 */
export function matchCommitments(stored: readonly Matchable[], incoming: readonly Matchable[]): (number | null)[] {
  const pairs: { i: number; j: number; score: number }[] = [];
  incoming.forEach((next, i) => {
    const a = words(next.text);
    stored.forEach((old, j) => {
      if (!next.evidenceIds.some((id) => old.evidenceIds.includes(id))) return;
      const b = words(old.text);
      const shared = [...a].filter((w) => b.has(w)).length;
      pairs.push({ i, j, score: shared / (a.size + b.size - shared || 1) });
    });
  });
  pairs.sort((x, y) => y.score - x.score || x.i - y.i || x.j - y.j);
  const match: (number | null)[] = incoming.map(() => null);
  const taken = new Set<number>();
  for (const { i, j } of pairs) {
    if (match[i] !== null || taken.has(j)) continue;
    match[i] = j;
    taken.add(j);
  }
  return match;
}

/** Keep only proposals naming sources that were actually supplied. Proposals change nothing. */
export function validateSourceGroups(
  output: z.infer<typeof SourceGroupsOutputSchema>,
  suppliedSourceIds: ReadonlySet<string>,
): SourceGroupProposal[] {
  return output.groups.flatMap((group) => {
    const sourceIds = [...new Set(group.sourceIds)].filter((id) => suppliedSourceIds.has(id)) as SourceId[];
    const projectName = group.projectName.trim();
    return sourceIds.length === 0 || projectName === "" ? [] : [{ projectName, sourceIds, reason: group.reason.trim() }];
  });
}
