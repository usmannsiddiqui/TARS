import type { Evidence, SourceGrant } from "./types";

/**
 * Whether a source grant authorizes this evidence record. Pure; deny by default.
 * The record must come from this grant's source, for this owner, under the grant's
 * current version, and name only projects the grant confirms.
 */
export function scopeAllows(grant: SourceGrant, evidence: Evidence): boolean {
  if (evidence.ownerId !== grant.ownerId) return false;
  if (evidence.sourceId !== grant.id) return false;
  if (grant.state !== "active" || !grant.read) return false;
  if (evidence.grantVersion !== grant.version) return false;
  if (evidence.projectIds.length === 0) return false;
  return evidence.projectIds.every((projectId) => grant.projectIds.includes(projectId));
}
