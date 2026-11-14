import { scopeAllows } from "./scope";
import type { Evidence, SourceGrant } from "./types";

/** What is already stored for one (owner, source, externalId). */
export type StoredRevision = Pick<Evidence, "version" | "occurredAt"> & { isCurrent: boolean };

export type IntakeDecision =
  | { result: "denied" }
  | { result: "duplicate" }
  | { result: "accepted"; becomesCurrent: boolean };

/**
 * Pure intake decision. `grant` is the STORED grant for the record's source (null when
 * none). Scope is checked before dedupe so a revoked source reveals nothing. A new
 * revision becomes current only when it occurred strictly after the current one.
 */
export function decideIntake(
  grant: SourceGrant | null,
  record: Evidence,
  stored: readonly StoredRevision[],
): IntakeDecision {
  if (grant === null || !scopeAllows(grant, record)) return { result: "denied" };
  if (stored.some((revision) => revision.version === record.version)) return { result: "duplicate" };
  const current = stored.find((revision) => revision.isCurrent);
  const becomesCurrent =
    current === undefined || Date.parse(record.occurredAt) > Date.parse(current.occurredAt);
  return { result: "accepted", becomesCurrent };
}
