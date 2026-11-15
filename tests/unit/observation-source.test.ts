// The observation helper as a local source: accepted events become outbox evidence, status becomes freshness.
// Fake helper child with scripted stdout; synthetic text only.
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { EvidenceSchema, ProjectIdSchema, SourceIdSchema, type Evidence, type SourceGrant } from "@companion/domain";
import { watchObservation } from "../../apps/desktop/src/main/observation";
import { makeOwners } from "../fixtures";

const grant: SourceGrant = {
  id: SourceIdSchema.parse("source-observation"),
  ownerId: makeOwners().alice.ownerId,
  kind: "observation",
  selectors: ["com.apple.Notes"],
  projectIds: [ProjectIdSchema.parse("project-avt")],
  read: true,
  writeTargets: [],
  cloudProcessing: false,
  version: 2,
  state: "active",
};

function fakeHelper() {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    stdin: { write: () => true, end: () => undefined, on: () => undefined },
    kill: () => true,
  });
  return { child, line: (v: unknown) => stdout.write(`${JSON.stringify(v)}\n`), drain: async () => (stdout.end(), await once(stdout, "end")) };
}

const event = (text: string) => ({
  type: "event",
  bundleId: "com.apple.Notes",
  windowId: "w1",
  text,
  capturedAt: "2026-11-14T12:00:00.000Z",
  grantVersion: 2,
  truncated: false,
});

describe("observation as a local source", () => {
  it("accepted helper events become schema-valid evidence for this grant version; status maps to freshness", async () => {
    const helper = fakeHelper();
    const emitted: Evidence[] = [];
    const statuses: string[] = [];
    const handle = await watchObservation(grant, (e) => emitted.push(e), {
      spawn: () => helper.child,
      diagnostic: () => {},
      onStatus: (s) => statuses.push(s.reason ?? s.freshness),
    });
    expect(handle.status()).toMatchObject({ freshness: "stale", reason: "starting" });
    helper.line({ type: "status", status: "permission-missing" });
    helper.line(event("Synthetic note text"));
    helper.line(event("Synthetic note text")); // unchanged text: one record
    helper.line({ type: "status", status: "ready" });
    await helper.drain();

    expect(statuses).toEqual(["permission-missing", "current"]);
    expect(handle.status()).toMatchObject({ freshness: "current", files: 1 });
    expect(emitted).toHaveLength(1);
    const [evidence] = emitted;
    expect(EvidenceSchema.parse(evidence)).toMatchObject({
      ownerId: grant.ownerId,
      sourceId: grant.id,
      externalId: "com.apple.Notes#w1",
      text: "Synthetic note text",
      occurredAt: "2026-11-14T12:00:00.000Z",
      grantVersion: 2,
      projectIds: grant.projectIds,
      origin: "live",
    });
    handle();
  });
});
