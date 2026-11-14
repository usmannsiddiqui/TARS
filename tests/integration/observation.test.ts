// Main-process boundary for the native observer, driven by a fake helper child with scripted stdout.
// Synthetic text only. No sleeps: a trailing valid line (or stream end) proves earlier lines were handled.
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectIdSchema, SourceIdSchema, type ObservationEvent, type SourceGrant } from "@companion/domain";
import * as observation from "../../apps/desktop/src/main/observation";
import { deleteRetainedObservations, pauseObservation, startObservation, type ObservationStatus } from "../../apps/desktop/src/main/observation";
import { makeOwners } from "../fixtures";

const NOTES = "com.apple.Notes";
const SAFARI = "com.apple.Safari";
const DOCS = "https://docs.example.com";

function grant(overrides: Partial<SourceGrant> = {}): SourceGrant {
  return {
    id: SourceIdSchema.parse("source-observation"),
    ownerId: makeOwners().alice.ownerId,
    kind: "observation",
    selectors: [NOTES, `${SAFARI}|${DOCS}`],
    projectIds: [ProjectIdSchema.parse("project-avt")],
    read: true,
    writeTargets: [],
    cloudProcessing: false,
    version: 4,
    state: "active",
    ...overrides,
  };
}

function fakeHelper() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sent: unknown[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: {
      write: (chunk: string) => {
        for (const line of chunk.split("\n").filter(Boolean)) sent.push(JSON.parse(line));
        return true;
      },
      end: () => undefined,
      on: () => undefined,
    },
    killed: 0,
    kill() {
      this.killed++;
      return true;
    },
  });
  return {
    child,
    sent,
    line: (value: unknown) => stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`),
    /** Every line written so far has been handled once this resolves. */
    drain: async () => {
      stdout.end();
      await once(stdout, "end");
    },
  };
}

const event = (overrides: Partial<ObservationEvent> & Record<string, unknown> = {}) => ({
  type: "event",
  bundleId: NOTES,
  windowId: "512-77",
  text: "Synthetic note text",
  capturedAt: "2026-11-14T10:00:00.000Z",
  grantVersion: 4,
  truncated: false,
  ...overrides,
});

async function start(grants: SourceGrant[] = [grant()]) {
  const fake = fakeHelper();
  const emitted: ObservationEvent[] = [];
  let onEmit = () => {};
  const nextEmit = () => new Promise<void>((resolve) => (onEmit = resolve));
  const statuses: ObservationStatus[] = [];
  const diagnostics: string[] = [];
  let spawns = 0;
  const dispose = await startObservation(grants, (e) => {
    emitted.push(e);
    onEmit();
  }, {
    spawn: () => {
      spawns++;
      return fake.child;
    },
    onStatus: (s) => statuses.push(s),
    diagnostic: (m) => diagnostics.push(m),
  });
  return { fake, emitted, nextEmit, statuses, diagnostics, dispose, spawns: () => spawns };
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});
async function started(grants?: SourceGrant[]) {
  const s = await start(grants);
  disposers.push(s.dispose);
  return s;
}

describe("observation boundary", () => {
  it("sends only the allowlisted scope to the helper", async () => {
    const { fake } = await started();
    expect(fake.sent[0]).toEqual({
      type: "scope",
      grantVersion: 4,
      bundles: [{ bundleId: NOTES }, { bundleId: SAFARI, origins: [DOCS] }],
    });
  });

  it("invalid_selector_grants_nothing", async () => {
    await expect(start([grant({ selectors: ["com.apple.Notes; rm -rf ~"] })])).rejects.toThrow();
    await expect(start([grant({ selectors: [`${SAFARI}|https://docs.example.com/path`] })])).rejects.toThrow();
    await expect(start([grant(), grant({ id: SourceIdSchema.parse("source-2") })])).rejects.toThrow();
  });

  it("revocation_drops_in_flight_observation", async () => {
    const first = await start();
    first.fake.line(event({ text: "before revoke" }));
    first.fake.line(event({ grantVersion: 3, text: "old grant version" }));
    first.dispose(); // revoke while the helper is still finishing an extraction
    first.fake.line(event({ text: "in flight at revoke" }));
    await first.fake.drain();
    expect(first.fake.sent.at(-1)).toEqual({ type: "stop" });
    expect(first.fake.child.killed).toBe(1);
    expect(first.emitted.map((e) => e.text)).toEqual(["before revoke"]);

    // Re-granted at a new version: a late result from the old version is still dropped.
    const second = await started([grant({ version: 5 })]);
    second.fake.line(event({ grantVersion: 4, text: "late old result" }));
    second.fake.line(event({ grantVersion: 5, text: "current" }));
    await second.fake.drain();
    expect(second.emitted.map((e) => e.text)).toEqual(["current"]);

    // A revoked grant starts nothing.
    const revoked = await start([grant({ state: "revoked", version: 6 })]);
    expect(revoked.spawns()).toBe(0);
  });

  it("password_field_is_excluded", async () => {
    const { fake, emitted, diagnostics } = await started();
    fake.line(event({ text: "hunter2", secure: true }));
    fake.line(event({ text: "hunter2", role: "AXSecureTextField" }));
    fake.line(event({ text: "hunter2", subrole: "AXSecureTextField" }));
    fake.line(event({ text: "visible" }));
    await fake.drain();
    expect(emitted.map((e) => e.text)).toEqual(["visible"]);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.join("\n")).not.toContain("hunter2");
  });

  it("app_change_does_not_set_drift_or_focus", async () => {
    expect(Object.keys(observation).filter((k) => /focus|drift/i.test(k))).toEqual([]);
    const { fake, emitted } = await started();
    fake.line(event({ bundleId: "com.tinyspeck.slackmacgap", text: "unselected app" }));
    fake.line(event({ bundleId: SAFARI, text: "unknown origin" }));
    fake.line(event({ bundleId: SAFARI, siteOrigin: "https://evil.example.com", text: "unlisted origin" }));
    fake.line(event({ bundleId: NOTES, siteOrigin: DOCS, text: "origin on a plain app" }));
    fake.line(event({ bundleId: "org.mozilla.firefox", text: "browser without origin" }));
    fake.line(event({ bundleId: SAFARI, siteOrigin: DOCS, text: "allowed page" }));
    await fake.drain();
    expect(emitted.map((e) => e.text)).toEqual(["allowed page"]);
    expect(Object.keys(emitted[0]!).sort()).toEqual(
      ["bundleId", "capturedAt", "grantVersion", "siteOrigin", "text", "truncated", "windowId"],
    );
  });

  it("pause_is_not_delete", async () => {
    const retained: { sourceId: string; event: ObservationEvent }[] = [];
    let onRetained = () => {};
    const fake = fakeHelper();
    const store = (e: ObservationEvent) => {
      retained.push({ sourceId: "source-observation", event: e });
      onRetained();
    };
    const dispose = await startObservation([grant()], store, {
      spawn: () => fake.child,
    });
    disposers.push(dispose);
    const kept = new Promise<void>((resolve) => (onRetained = resolve));
    fake.line(event({ text: "kept" }));
    await kept;
    expect(retained.map((r) => r.event.text)).toEqual(["kept"]);

    await pauseObservation();
    expect(fake.sent.at(-1)).toEqual({ type: "pause" });
    fake.line(event({ text: "after pause" }));
    await fake.drain();
    expect(retained.map((r) => r.event.text)).toEqual(["kept"]);

    const deleted: string[] = [];
    await deleteRetainedObservations(grant().id, async (sourceId) => {
      deleted.push(sourceId);
      retained.splice(0, retained.length, ...retained.filter((r) => r.sourceId !== sourceId));
    });
    expect(deleted).toEqual(["source-observation"]);
    expect(retained).toEqual([]);
  });

  it("malformed helper line is ignored with a diagnostic", async () => {
    const { fake, emitted, diagnostics } = await started();
    fake.line("not json Synthetic secret");
    fake.line({ type: "event", text: "Synthetic secret" });
    fake.line({ type: "exec", command: "ls" });
    fake.line(event({ text: "x".repeat(12_001) }));
    fake.line(event({ text: "still running" }));
    await fake.drain();
    expect(emitted.map((e) => e.text)).toEqual(["still running"]);
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics.join("\n")).not.toContain("Synthetic secret");
  });

  it("helper exit surfaces status without restarting", async () => {
    const { fake, statuses, emitted, nextEmit, spawns } = await started();
    const sentinel = nextEmit();
    fake.line({ type: "status", status: "permission-missing" });
    fake.line({ type: "status", status: "unsupported-app", bundleId: "org.mozilla.firefox" });
    fake.line(event({ text: "sentinel" }));
    await sentinel; // lines are handled in order, so both statuses came first
    expect(emitted.map((e) => e.text)).toEqual(["sentinel"]);
    fake.child.emit("exit", 1, null);
    fake.line(event({ text: "after exit" }));
    await fake.drain();
    expect(statuses).toEqual([
      { state: "permission-missing" },
      { state: "unsupported-app", bundleId: "org.mozilla.firefox" },
      { state: "helper-exited", code: 1 },
    ]);
    expect(emitted.map((e) => e.text)).toEqual(["sentinel"]);
    expect(spawns()).toBe(1);
  });
});
