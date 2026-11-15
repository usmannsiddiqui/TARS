import { describe, expect, test } from "vitest";
import { SourceGrantSchema, type Evidence, type SourceGrant } from "@companion/domain";
import { scopeAllows } from "../../packages/domain/src/scope";
import { makeEvidence, makeOwners, makeProjects } from "../fixtures";

const { alice, bob } = makeOwners();
const { aiGuides, avt } = makeProjects(alice.ownerId);
const { aiGuides: bobProject } = makeProjects(bob.ownerId);

function setup(grantOverrides: Partial<SourceGrant> = {}) {
  const evidence = makeEvidence(alice.ownerId, [avt.id]);
  const grant = SourceGrantSchema.parse({
    id: evidence.sourceId,
    ownerId: alice.ownerId,
    kind: "slack",
    selectors: ["illustrative-channel"],
    projectIds: [avt.id],
    read: true,
    writeTargets: [],
    cloudProcessing: true,
    version: 1,
    state: "active",
    ...grantOverrides,
  });
  return { grant, evidence };
}

const withRecord = (evidence: Evidence, overrides: Partial<Evidence>): Evidence => ({
  ...evidence,
  ...overrides,
});

describe("scopeAllows", () => {
  test("denies_revoked_and_cross_project_evidence", () => {
    const { grant, evidence } = setup();
    expect(scopeAllows(grant, evidence)).toBe(true);

    expect(scopeAllows({ ...grant, state: "revoked" }, evidence)).toBe(false);
    expect(scopeAllows(grant, withRecord(evidence, { projectIds: [aiGuides.id] }))).toBe(false);
    expect(scopeAllows(grant, withRecord(evidence, { projectIds: [avt.id, aiGuides.id] }))).toBe(
      false,
    );
  });

  test("accepts_shared_source_only_for_confirmed_projects", () => {
    const { grant, evidence } = setup({ projectIds: [avt.id, aiGuides.id] });

    expect(scopeAllows(grant, withRecord(evidence, { projectIds: [avt.id, aiGuides.id] }))).toBe(
      true,
    );
    expect(scopeAllows(grant, withRecord(evidence, { projectIds: [aiGuides.id] }))).toBe(true);
    expect(
      scopeAllows(grant, withRecord(evidence, { projectIds: [avt.id, bobProject.id] })),
    ).toBe(false);
  });

  test("denies_paused_grant", () => {
    const { grant, evidence } = setup({ state: "paused" });
    expect(scopeAllows(grant, evidence)).toBe(false);
  });

  test("denies_grant_without_read", () => {
    const { grant, evidence } = setup({ read: false });
    expect(scopeAllows(grant, evidence)).toBe(false);
  });

  test("denies_owner_mismatch", () => {
    const { grant, evidence } = setup();
    expect(scopeAllows({ ...grant, ownerId: bob.ownerId }, evidence)).toBe(false);
  });

  test("denies_other_source", () => {
    const { grant } = setup();
    const otherSource = makeEvidence(alice.ownerId, [avt.id]);
    expect(scopeAllows(grant, otherSource)).toBe(false);
  });

  test("denies_stale_grant_version", () => {
    const { grant, evidence } = setup({ version: 2 });
    expect(scopeAllows(grant, withRecord(evidence, { grantVersion: 1 }))).toBe(false);
  });

  test("denies_empty_project_ids", () => {
    const { grant, evidence } = setup();
    expect(scopeAllows(grant, withRecord(evidence, { projectIds: [] }))).toBe(false);
  });
});
