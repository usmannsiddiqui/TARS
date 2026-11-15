// The held talk key: the native helper's lines are validated; only down/up and a status word get through.
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { HOLD_KEY, startHoldKey, type HoldKeyStatus } from "../../apps/desktop/src/main/hold-key";

function fakeHelper() {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    stdin: { write: () => true, end: () => undefined, on: () => undefined },
    kill: () => true,
  });
  return { child, raw: (line: string) => stdout.write(`${line}\n`), line: (v: unknown) => stdout.write(`${JSON.stringify(v)}\n`), flush: () => new Promise((r) => setImmediate(r)) };
}

function setup() {
  const helper = fakeHelper();
  const holds: boolean[] = [];
  const statuses: HoldKeyStatus["state"][] = [];
  const key = startHoldKey({ spawn: () => helper.child, onHold: (down) => holds.push(down), onStatus: (s) => statuses.push(s.state), diagnostic: () => {} });
  return { helper, holds, statuses, key };
}

describe("startHoldKey", () => {
  it("names_the_key_and_reports_starting_then_the_helpers_status", async () => {
    const { helper, statuses, key } = setup();
    expect(key.status()).toEqual({ key: HOLD_KEY, state: "starting" });
    helper.line({ type: "status", status: "permission-missing" });
    helper.line({ type: "status", status: "ready" });
    await helper.flush();
    expect(statuses).toEqual(["permission-missing", "ready"]);
    expect(key.status()).toEqual({ key: "Right Option (⌥)", state: "ready" });
  });

  it("passes_down_and_up_once_each_and_drops_repeats", async () => {
    const { helper, holds } = setup();
    helper.line({ type: "hold", down: true });
    helper.line({ type: "hold", down: true });
    helper.line({ type: "hold", down: false });
    helper.line({ type: "hold", down: false });
    await helper.flush();
    expect(holds).toEqual([true, false]);
  });

  it("rejects_anything_else_the_helper_prints", async () => {
    const { helper, holds, statuses } = setup();
    helper.raw("not json");
    helper.line({ type: "hold", down: "yes" });
    helper.line({ type: "hold", down: true, keyCode: 12 });
    helper.line({ type: "key", chars: "a" });
    helper.line({ type: "status", status: "granted" });
    helper.raw(JSON.stringify({ type: "hold", down: true }).padEnd(2000, " "));
    await helper.flush();
    expect(holds).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it("a_helper_that_exits_mid_hold_releases_the_key_and_says_unavailable", async () => {
    const { helper, holds, statuses, key } = setup();
    helper.line({ type: "hold", down: true });
    await helper.flush();
    helper.child.emit("exit", 1);
    expect(holds).toEqual([true, false]);
    expect(statuses).toEqual(["unavailable"]);
    expect(key.status().state).toBe("unavailable");
  });

  it("a_helper_that_cannot_start_says_unavailable", async () => {
    const { helper, statuses } = setup();
    helper.child.emit("error", new Error("ENOENT"));
    expect(statuses).toEqual(["unavailable"]);
  });

  it("stop_ends_the_helper_and_reports_nothing_after", async () => {
    const { helper, holds, statuses, key } = setup();
    key.stop();
    helper.line({ type: "hold", down: true });
    await helper.flush();
    helper.child.emit("exit", 0);
    expect(holds).toEqual([]);
    expect(statuses).toEqual([]);
    await once(helper.child.stdout.end(), "finish");
  });
});
