// Project memory policy: suppression (forgetting) and scoping. Pure: no I/O.
import type { MemoryFact, ProjectId, Suppression } from "./types";

/** Canonical form of a memory key: lowercase words joined by "_". */
export function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const STOPWORDS = new Set(["a", "an", "the", "of", "for", "to", "and", "in", "on", "user", "prefers", "preferred", "preference"]);

/** Content words of a key, crudely singularized ("slides" -> "slide"). */
function keyWords(key: string): Set<string> {
  return new Set(
    normalizeKey(key)
      .split("_")
      .filter((word) => word !== "" && !STOPWORDS.has(word))
      .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word)),
  );
}

// shortcut: word overlap only catches paraphrases that reuse key words; a model-chosen key
// with entirely new words slips past. Upgrade to a reviewed semantic match if that shows up.
const SIMILAR = 0.5;
function similarKeys(a: string, b: string): boolean {
  const left = keyWords(a);
  const right = keyWords(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union > 0 && shared / union >= SIMILAR;
}

/** A candidate fact: what is about to be retrieved or stored. No projectId means global. */
export type FactCandidate = { projectId?: ProjectId | undefined; key: string; evidenceIds: readonly string[] };
export type SuppressionVerdict = "allowed" | "blocked" | "withheld";

/** A global suppression covers every project; a global fact is covered by any suppression. */
function covers(suppression: Suppression, projectId: ProjectId | undefined): boolean {
  return (
    suppression.active &&
    (suppression.projectId === undefined || projectId === undefined || suppression.projectId === projectId)
  );
}

/**
 * Whether a newly extracted or user-stated fact may be stored. Same key, or a similar key
 * from the forgotten evidence, is blocked. A similar key from new evidence, or any key from
 * the forgotten evidence, is withheld for the user to review: never silently relearned.
 */
export function suppressionVerdict(candidate: FactCandidate, suppressions: readonly Suppression[]): SuppressionVerdict {
  let verdict: SuppressionVerdict = "allowed";
  for (const suppression of suppressions) {
    if (!covers(suppression, candidate.projectId)) continue;
    const sameKey = normalizeKey(suppression.key) === normalizeKey(candidate.key);
    const similar = similarKeys(suppression.key, candidate.key);
    const sameEvidence = candidate.evidenceIds.some((id) => suppression.evidenceIds.includes(id as never));
    if (sameKey || (similar && sameEvidence)) return "blocked";
    if (similar || sameEvidence) verdict = "withheld";
  }
  return verdict;
}

/** Retrieval filter for already-stored facts: hide same or similar keys to anything forgotten. */
export function isSuppressed(fact: MemoryFact, suppressions: readonly Suppression[]): boolean {
  const projectId = fact.scope === "global" ? undefined : fact.projectId;
  return suppressions.some(
    (suppression) =>
      covers(suppression, projectId) &&
      (normalizeKey(suppression.key) === normalizeKey(fact.key) || similarKeys(suppression.key, fact.key)),
  );
}

/** Facts usable in `projectId`: its own project facts plus global ones, minus suppressed. */
export function visibleFacts(
  facts: readonly MemoryFact[],
  projectId: ProjectId,
  suppressions: readonly Suppression[],
): MemoryFact[] {
  return facts.filter(
    (fact) => (fact.scope === "global" || fact.projectId === projectId) && !isSuppressed(fact, suppressions),
  );
}
