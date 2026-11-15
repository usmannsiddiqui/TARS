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
    const dueAt = item.dueAt !== null && z.iso.datetime().safeParse(item.dueAt).success ? item.dueAt : undefined;
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
