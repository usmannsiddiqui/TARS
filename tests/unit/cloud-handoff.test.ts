import { describe, expect, it } from "vitest";
import type { Evidence, IntakeResult, OwnerId, SourceGrant, SourceId } from "@companion/domain";
import { createHandoff, type CloudGrant, type CloudSync } from "../../apps/desktop/src/main/cloud-handoff";
import type { LocalGrantRecord } from "../../apps/desktop/src/main/local-store";
import { makeEvidence, makeOwners, makeProjects } from "../fixtures";

function setup(opts: { cloudProcessing?: boolean; mirroredVersion?: number | null; state?: SourceGrant["state"] } = {}) {
  const { alice } = makeOwners();
  const project = makeProjects(alice.ownerId).avt.id;
  const first = makeEvidence(alice.ownerId, [project], { externalId: "a.md", version: "1" });
  const second = makeEvidence(alice.ownerId, [project], { sourceId: first.sourceId, externalId: "b.md", version: "1" });
  const grant: SourceGrant = {
    id: first.sourceId,
    ownerId: alice.ownerId,
    kind: "obsidian",
    selectors: ["/Users/illustrative/private-vault"],
    projectIds: [project],
    read: true,
    writeTargets: [],
    cloudProcessing: opts.cloudProcessing ?? true,
    version: 1,
    state: opts.state ?? "active",
  };
  const records: LocalGrantRecord[] = [{ grant, mirroredVersion: opts.mirroredVersion ?? null }];
  let outbox: Evidence[] = [first, second];
  let owner: OwnerId | null = alice.ownerId;
  const statuses = new Map<SourceId, CloudSync>();
  const grantsSent: CloudGrant[] = [];
  const submitted: Evidence[] = [];
  let submitImpl: (record: Evidence) => Promise<IntakeResult> = async () => "accepted";
  let setGrantImpl: () => Promise<void> = async () => {};

  const handoff = createHandoff({
    currentOwner: () => owner,
    cloud: {
      async setGrant(input) {
        grantsSent.push(input);
        await setGrantImpl();
      },
      async submit(record) {
        submitted.push(record);
        return submitImpl(record);
      },
    },
    sources: {
      cloudGrants: (ownerId) => records.filter((r) => r.grant.ownerId === ownerId),
      async markMirrored(_ownerId, sourceId, version) {
        for (const r of records) if (r.grant.id === sourceId) r.mirroredVersion = version;
      },
      setCloudSync: (sourceId, status) => statuses.set(sourceId, status),
    },
    outbox: {
      loadOutbox: async (ownerId) => outbox.filter((e) => e.ownerId === ownerId),
      async markSynced(evidence) {
        outbox = outbox.filter((e) => e !== evidence);
      },
    },
  });
  return {
    alice,
    grant,
    first,
    second,
    records,
    handoff,
    statuses,
    grantsSent,
    submitted,
    outbox: () => outbox,
    signOut: () => (owner = null),
    onSubmit: (impl: typeof submitImpl) => (submitImpl = impl),
    onSetGrant: (impl: typeof setGrantImpl) => (setGrantImpl = impl),
  };
}

describe("cloud hand-off", () => {
  it("mirrors a consented grant without its local path, then sends its evidence in order", async () => {
    const s = setup();
    await s.handoff.trigger();

    expect(s.grantsSent).toEqual([
      {
        id: s.grant.id,
        kind: "obsidian",
        selectors: [],
        projectIds: s.grant.projectIds,
        read: true,
        writeTargets: [],
        cloudProcessing: true,
        version: 1,
        state: "active",
      },
    ]);
    expect(JSON.stringify(s.grantsSent)).not.toContain("private-vault");
    expect(s.records[0]?.mirroredVersion).toBe(1);
    expect(s.submitted).toEqual([s.first, s.second]);
    expect(s.outbox()).toEqual([]);
    expect(s.statuses.get(s.grant.id)).toEqual({ state: "synced" });

    // Already mirrored: the next event only sends new evidence.
    await s.handoff.trigger();
    expect(s.grantsSent).toHaveLength(1);
  });

  it("marks a duplicate as synced", async () => {
    const s = setup({ mirroredVersion: 1 });
    s.onSubmit(async () => "duplicate");
    await s.handoff.trigger();
    expect(s.outbox()).toEqual([]);
    expect(s.statuses.get(s.grant.id)).toEqual({ state: "synced" });
  });

  it("keeps a denied record and shows it, without blocking the rest", async () => {
    const s = setup({ mirroredVersion: 1 });
    s.onSubmit(async (record) => (record === s.first ? "denied" : "accepted"));
    await s.handoff.trigger();
    expect(s.outbox()).toEqual([s.first]);
    expect(s.statuses.get(s.grant.id)).toEqual({ state: "denied", count: 1 });
  });

  it("network_failure_needs_retry_without_looping", async () => {
    const s = setup({ mirroredVersion: 1 });
    s.onSubmit(async () => {
      throw new Error("fetch failed");
    });
    await s.handoff.trigger();
    expect(s.submitted).toEqual([s.first]); // stops at the first failure; no retry timer, no loop
    expect(s.outbox()).toEqual([s.first, s.second]);
    expect(s.statuses.get(s.grant.id)).toEqual({ state: "needs-retry", reason: "fetch failed" });

    // The next event (e.g. back online) tries again.
    s.onSubmit(async () => "accepted");
    await s.handoff.trigger();
    expect(s.outbox()).toEqual([]);
    expect(s.statuses.get(s.grant.id)).toEqual({ state: "synced" });
  });

  it("a failed grant mirror needs retry and sends no evidence", async () => {
    const s = setup();
    s.onSetGrant(async () => {
      throw new Error("cloud unreachable");
    });
    await s.handoff.trigger();
    expect(s.submitted).toEqual([]);
    expect(s.records[0]?.mirroredVersion).toBeNull();
    expect(s.statuses.get(s.grant.id)).toEqual({ state: "needs-retry", reason: "cloud unreachable" });
  });

  it("sign_out_mid_drain_stops_sending", async () => {
    const s = setup({ mirroredVersion: 1 });
    s.onSubmit(async () => {
      s.signOut();
      return "accepted";
    });
    await s.handoff.trigger();
    expect(s.submitted).toEqual([s.first]);
    expect(s.outbox()).toEqual([s.second]);
    await s.handoff.trigger(); // signed out: nothing at all
    expect(s.submitted).toEqual([s.first]);
  });

  it("nothing leaves the Mac for a source without cloud consent", async () => {
    const s = setup({ cloudProcessing: false });
    await s.handoff.trigger();
    expect(s.grantsSent).toEqual([]);
    expect(s.submitted).toEqual([]);
    expect(s.statuses.size).toBe(0);
  });

  it("tells the cloud about a revoke of a source it knew, and sends no evidence for it", async () => {
    const s = setup({ mirroredVersion: 1 });
    s.records[0] = { grant: { ...s.grant, state: "revoked", version: 2 }, mirroredVersion: 1 };
    await s.handoff.trigger();
    expect(s.grantsSent).toMatchObject([{ id: s.grant.id, state: "revoked", version: 2, selectors: [] }]);
    expect(s.records[0]?.mirroredVersion).toBe(2);
    expect(s.submitted).toEqual([]);
  });

  it("coalesces events that arrive during a drain into one more pass", async () => {
    const s = setup({ mirroredVersion: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    s.onSubmit(async () => {
      await gate;
      return "accepted";
    });
    const running = s.handoff.trigger();
    void s.handoff.trigger();
    void s.handoff.trigger();
    release();
    await running;
    await s.handoff.trigger();
    expect(s.submitted).toEqual([s.first, s.second]);
  });
});
