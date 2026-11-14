// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Evidence, ProjectId, SourceGrant } from "@companion/domain";
import { api, internal } from "../../convex/_generated/api";
import * as evidenceModule from "../../convex/evidence";
import schema from "../../convex/schema";
import { makeEvidence, makeOwners, makeProjects } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");

type IngestArgs = { ownerId: string; sourceId: string; record: Evidence };

/** Grant input as a client sends it: no ownerId, the server takes that from the token. */
function grantFor(
  record: Evidence,
  projectIds: ProjectId[],
  overrides: Partial<Omit<SourceGrant, "id" | "ownerId">> = {},
) {
  return {
    id: record.sourceId,
    kind: "slack" as const,
    selectors: ["illustrative-channel"],
    projectIds,
    read: true,
    writeTargets: [],
    cloudProcessing: true,
    version: 1,
    state: "active" as const,
    ...overrides,
  };
}

function setup() {
  const t = convexTest(schema, modules);
  const { alice, bob } = makeOwners();
  const { avt, aiGuides } = makeProjects(alice.ownerId);
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const asBob = t.withIdentity({ tokenIdentifier: bob.ownerId, subject: "bob" });
  const eventFor = (record: Evidence): IngestArgs => ({
    ownerId: record.ownerId,
    sourceId: record.sourceId,
    record,
  });
  const ingest = (event: IngestArgs) => t.mutation(internal.evidence.ingest, event);
  return { t, alice, bob, avt, aiGuides, asAlice, asBob, ingest, eventFor };
}

describe("evidence intake", () => {
  test("duplicate_event_is_idempotent", async () => {
    const { alice, avt, asAlice, ingest, eventFor } = setup();
    const record = makeEvidence(alice.ownerId, [avt.id]);
    await asAlice.mutation(api.evidence.setGrant, grantFor(record, [avt.id]));
    const event = eventFor(record);

    expect(await ingest(event)).toBe("accepted");
    expect(await ingest(event)).toBe("duplicate");

    const stored = await asAlice.query(api.evidence.listCurrentEvidence, { projectId: avt.id });
    expect(stored).toEqual([record]);
  });

  test("older_version_does_not_replace_newer", async () => {
    const { t, alice, avt, asAlice, ingest, eventFor } = setup();
    const newer = makeEvidence(alice.ownerId, [avt.id], {
      version: "2",
      text: "Illustrative note: revised outline.",
      occurredAt: "2026-11-14T12:00:00.000Z",
    });
    const older: Evidence = {
      ...newer,
      id: makeEvidence(alice.ownerId, [avt.id]).id,
      version: "1",
      text: "Illustrative note: first outline.",
      occurredAt: "2026-11-14T11:00:00Z",
    };
    await asAlice.mutation(api.evidence.setGrant, grantFor(newer, [avt.id]));

    expect(await ingest(eventFor(newer))).toBe("accepted");
    expect(await ingest(eventFor(older))).toBe("accepted");

    expect(await asAlice.query(api.evidence.listCurrentEvidence, { projectId: avt.id })).toEqual([
      newer,
    ]);
    // Provenance kept: both source revisions are durable rows, only one is current.
    const rows = await t.run((ctx) => ctx.db.query("evidence").collect());
    expect(rows.map((row) => [row.version, row.isCurrent]).sort()).toEqual([
      ["1", false],
      ["2", true],
    ]);
  });

  test("newer_version_replaces_current", async () => {
    const { alice, avt, asAlice, ingest, eventFor } = setup();
    const first = makeEvidence(alice.ownerId, [avt.id], { occurredAt: "2026-11-14T11:00:00Z" });
    const second: Evidence = {
      ...first,
      id: makeEvidence(alice.ownerId, [avt.id]).id,
      version: "2",
      occurredAt: "2026-11-14T12:00:00Z",
    };
    await asAlice.mutation(api.evidence.setGrant, grantFor(first, [avt.id]));

    expect(await ingest(eventFor(first))).toBe("accepted");
    expect(await ingest(eventFor(second))).toBe("accepted");
    expect(await asAlice.query(api.evidence.listCurrentEvidence, { projectId: avt.id })).toEqual([
      second,
    ]);
  });

  test("revocation_blocks_event_queued_before_revoke", async () => {
    const { t, alice, avt, asAlice, ingest, eventFor } = setup();
    const queued = makeEvidence(alice.ownerId, [avt.id], { grantVersion: 1 });
    await asAlice.mutation(api.evidence.setGrant, grantFor(queued, [avt.id]));
    await asAlice.mutation(
      api.evidence.setGrant,
      grantFor(queued, [avt.id], { version: 2, state: "revoked" }),
    );

    expect(await ingest(eventFor(queued))).toBe("denied");
    expect(await t.run((ctx) => ctx.db.query("evidence").collect())).toEqual([]);
  });

  test("narrowing_projects_blocks_old_version_event", async () => {
    const { t, alice, avt, aiGuides, asAlice, ingest, eventFor } = setup();
    const queued = makeEvidence(alice.ownerId, [aiGuides.id], { grantVersion: 1 });
    await asAlice.mutation(api.evidence.setGrant, grantFor(queued, [avt.id, aiGuides.id]));
    await asAlice.mutation(api.evidence.setGrant, grantFor(queued, [avt.id], { version: 2 }));

    expect(await ingest(eventFor(queued))).toBe("denied");
    expect(await t.run((ctx) => ctx.db.query("evidence").collect())).toEqual([]);
  });

  test("unknown_source_is_denied", async () => {
    const { t, alice, avt, ingest, eventFor } = setup();
    const record = makeEvidence(alice.ownerId, [avt.id]);

    expect(await ingest(eventFor(record))).toBe("denied");
    expect(await t.run((ctx) => ctx.db.query("evidence").collect())).toEqual([]);
  });

  test("record_not_matching_mapped_owner_is_denied", async () => {
    const { t, alice, bob, avt, asAlice, ingest } = setup();
    const record = makeEvidence(alice.ownerId, [avt.id]);
    await asAlice.mutation(api.evidence.setGrant, grantFor(record, [avt.id]));

    expect(await ingest({ ownerId: bob.ownerId, sourceId: record.sourceId, record })).toBe(
      "denied",
    );
    expect(await t.run((ctx) => ctx.db.query("evidence").collect())).toEqual([]);
  });

  test("owner_cannot_read_other_owner_evidence", async () => {
    const { alice, avt, asAlice, asBob, ingest, eventFor } = setup();
    const record = makeEvidence(alice.ownerId, [avt.id]);
    await asAlice.mutation(api.evidence.setGrant, grantFor(record, [avt.id]));
    expect(await ingest(eventFor(record))).toBe("accepted");

    expect(await asBob.query(api.evidence.listCurrentEvidence, { projectId: avt.id })).toEqual([]);
    // Bob cannot take over Alice's source by reusing its id.
    await expect(
      asBob.mutation(api.evidence.setGrant, grantFor(record, [avt.id], { version: 5 })),
    ).rejects.toThrow(/source/i);
    await expect(
      asBob.mutation(api.evidence.setGrant, {
        ...grantFor(record, [avt.id]),
        ownerId: record.ownerId,
      } as never),
    ).rejects.toThrow(/ownerId/);
  });

  test("set_grant_requires_auth_and_newer_version", async () => {
    const { t, alice, avt, asAlice } = setup();
    const record = makeEvidence(alice.ownerId, [avt.id]);
    await expect(t.mutation(api.evidence.setGrant, grantFor(record, [avt.id]))).rejects.toThrow(
      /not authenticated/i,
    );
    await expect(
      t.query(api.evidence.listCurrentEvidence, { projectId: avt.id }),
    ).rejects.toThrow(/not authenticated/i);

    await asAlice.mutation(api.evidence.setGrant, grantFor(record, [avt.id], { version: 2 }));
    await expect(
      asAlice.mutation(api.evidence.setGrant, grantFor(record, [avt.id], { version: 2 })),
    ).rejects.toThrow(/version/i);
    await expect(
      asAlice.mutation(api.evidence.setGrant, grantFor(record, [avt.id], { kind: "nope" } as never)),
    ).rejects.toThrow();
  });

  test("ingest_is_not_client_callable", () => {
    expect(evidenceModule.ingest.isInternal).toBe(true);
    expect("isPublic" in evidenceModule.ingest).toBe(false);
    // @ts-expect-error ingest is internal, so it is absent from the client `api`.
    expect(api.evidence.ingest).toBeDefined(); // anyApi is a proxy; the type error is the proof.
  });
});
