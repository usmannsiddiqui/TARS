// Illustrative test fixtures only: invented owners, projects and evidence.
// Never real people, credentials or source content.
import {
  EvidenceSchema,
  OwnerIdSchema,
  ProjectIdSchema,
  SourceIdSchema,
  EvidenceIdSchema,
  type Evidence,
  type OwnerId,
  type ProjectId,
  type SourceId,
} from "@companion/domain";

let counter = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${++counter}`;

export type FixtureOwner = { ownerId: OwnerId; name: "Alice" | "Bob" };

export function makeOwners(): { alice: FixtureOwner; bob: FixtureOwner } {
  return {
    alice: { ownerId: OwnerIdSchema.parse(unique("owner-alice")), name: "Alice" },
    bob: { ownerId: OwnerIdSchema.parse(unique("owner-bob")), name: "Bob" },
  };
}

export type FixtureProject = { id: ProjectId; ownerId: OwnerId; name: "AI Guides" | "AVT" };

export function makeProjects(ownerId: OwnerId): { aiGuides: FixtureProject; avt: FixtureProject } {
  return {
    aiGuides: { id: ProjectIdSchema.parse(unique("project-ai-guides")), ownerId, name: "AI Guides" },
    avt: { id: ProjectIdSchema.parse(unique("project-avt")), ownerId, name: "AVT" },
  };
}

export function makeEvidence(
  ownerId: OwnerId,
  projectIds: ProjectId[],
  overrides: Partial<Omit<Evidence, "ownerId" | "origin">> = {},
): Evidence {
  const now = new Date().toISOString();
  return EvidenceSchema.parse({
    id: EvidenceIdSchema.parse(unique("evidence")),
    ownerId,
    sourceId: SourceIdSchema.parse(unique("source")) satisfies SourceId,
    externalId: unique("external"),
    version: "1",
    text: "Illustrative note: draft the AVT pitch outline.",
    occurredAt: now,
    receivedAt: now,
    projectIds,
    grantVersion: 1,
    freshness: "current",
    ...overrides,
    origin: "illustrative",
  });
}
