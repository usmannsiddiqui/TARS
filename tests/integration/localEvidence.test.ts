// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { OwnerIdSchema, type Evidence, type SourceKind } from "@companion/domain";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { makeEvidence, makeOwners, makeProjects } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");

/** A local source's grant as the desktop mirrors it: no selectors, because local paths are private. */
function localGrant(record: Evidence, overrides: { kind?: SourceKind; cloudProcessing?: boolean; version?: number } = {}) {
  return {
    id: record.sourceId,
    kind: "obsidian" as SourceKind,
    selectors: [],
    projectIds: record.projectIds,
    read: true,
    writeTargets: [],
    cloudProcessing: true,
    version: record.grantVersion,
    state: "active" as const,
    ...overrides,
  };
}

function setup() {
  const t = convexTest(schema, modules);
  const { alice, bob } = makeOwners();
  const { avt } = makeProjects(alice.ownerId);
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const asBob = t.withIdentity({ tokenIdentifier: bob.ownerId, subject: "bob" });
  const stored = () => t.run((ctx) => ctx.db.query("evidence").collect());
  return { t, alice, bob, avt, asAlice, asBob, stored };
}

describe("local evidence hand-off (localEvidence.submit)", () => {
  test("accepted_then_duplicate", async () => {
    const { alice, avt, asAlice } = setup();
    const record = makeEvidence(alice.ownerId, [avt.id]);
    await asAlice.mutation(api.evidence.setGrant, localGrant(record));

    expect(await asAlice.mutation(api.localEvidence.submit, { record })).toBe("accepted");
    expect(await asAlice.mutation(api.localEvidence.submit, { record })).toBe("duplicate");
    expect(await asAlice.query(api.evidence.listCurrentEvidence, { projectId: avt.id })).toEqual([record]);
  });

  test("other_owners_source_is_denied", async () => {
    const { alice, bob, avt, asAlice, asBob, stored } = setup();
    const aliceRecord = makeEvidence(alice.ownerId, [avt.id]);
    await asAlice.mutation(api.evidence.setGrant, localGrant(aliceRecord));

    // Bob submits Alice's record as-is, and as his own against her source id.
    expect(await asBob.mutation(api.localEvidence.submit, { record: aliceRecord })).toBe("denied");
    expect(
      await asBob.mutation(api.localEvidence.submit, { record: { ...aliceRecord, ownerId: bob.ownerId } }),
    ).toBe("denied");
    expect(await stored()).toEqual([]);
  });

  test("cloud_kind_is_denied_through_the_local_path", async () => {
    const { alice, avt, asAlice, stored } = setup();
    const record = makeEvidence(alice.ownerId, [avt.id]);
    await asAlice.mutation(api.evidence.setGrant, localGrant(record, { kind: "slack" }));

    expect(await asAlice.mutation(api.localEvidence.submit, { record })).toBe("denied");
    expect(await stored()).toEqual([]);
  });

  test("cloud_processing_off_is_denied", async () => {
    const { alice, avt, asAlice, stored } = setup();
    const record = makeEvidence(alice.ownerId, [avt.id]);
    await asAlice.mutation(api.evidence.setGrant, localGrant(record, { cloudProcessing: false }));

    expect(await asAlice.mutation(api.localEvidence.submit, { record })).toBe("denied");
    expect(await stored()).toEqual([]);
  });

  test("unauthenticated_is_rejected", async () => {
    const { t, alice, avt, asAlice, stored } = setup();
    const record = makeEvidence(alice.ownerId, [avt.id]);
    await asAlice.mutation(api.evidence.setGrant, localGrant(record));

    await expect(t.mutation(api.localEvidence.submit, { record })).rejects.toThrow(/not authenticated/i);
    expect(await stored()).toEqual([]);
  });

  test("stale_grant_version_is_denied", async () => {
    const { alice, avt, asAlice, stored } = setup();
    const record = makeEvidence(alice.ownerId, [avt.id], { grantVersion: 1 });
    await asAlice.mutation(api.evidence.setGrant, localGrant(record));
    // Consent turned off and on again: a new version; the record queued under version 1 no longer counts.
    await asAlice.mutation(api.evidence.setGrant, localGrant(record, { version: 2 }));

    expect(await asAlice.mutation(api.localEvidence.submit, { record })).toBe("denied");
    expect(await stored()).toEqual([]);
  });

  test("desktop_owner_id_matches_convex_token_identifier", async () => {
    // The desktop names its owner `${iss}|${sub}` (auth.ts); Convex derives tokenIdentifier the same way.
    const t = convexTest(schema, modules);
    const issuer = "https://tenant.example.auth0.com/";
    const asUser = t.withIdentity({ issuer, subject: "auth0|alice" });
    const ownerId = OwnerIdSchema.parse(`${issuer}|auth0|alice`);
    const record = makeEvidence(ownerId, [makeProjects(ownerId).avt.id]);
    await asUser.mutation(api.evidence.setGrant, localGrant(record));

    expect(await asUser.mutation(api.localEvidence.submit, { record })).toBe("accepted");
  });
});
