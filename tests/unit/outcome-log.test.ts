// The Mac side of pendingLocalLogs, with fakes for the append and the Convex report.
import { describe, expect, it } from "vitest";
import type { OwnerId, ProjectId, SourceGrant, SourceId } from "@companion/domain";
import type { LocalLogRequest, LocalLogResult } from "../../apps/desktop/src/main/local-log";
import { createLogSync, logTargetId } from "../../apps/desktop/src/main/outcome-log";

const NOTE = "/Users/illustrative/vault/Outcomes.md";
const grant = (overrides: Partial<SourceGrant> = {}): SourceGrant => ({
  id: "source-obsidian" as SourceId,
  ownerId: "owner-alice" as OwnerId,
  kind: "obsidian",
  selectors: ["/Users/illustrative/vault"],
  projectIds: ["project-avt" as ProjectId],
  read: true,
  writeTargets: [NOTE],
  cloudProcessing: true,
  version: 2,
  state: "active",
  ...overrides,
});
const item = (actionId = "a1") => ({ actionId, target: logTargetId(NOTE), marker: `tars-log-${actionId}`, entry: `Sent. [tars-log-${actionId}]` });

function setup(grants: SourceGrant[], outcome: LocalLogResult = { result: "written" }) {
  const appends: { grant: SourceGrant; request: LocalLogRequest }[] = [];
  const reports: [string, string][] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => (release = done));
  let holdAppend = false;
  const sync = createLogSync({
    grants: () => grants,
    async append(g, request) {
      appends.push({ grant: g, request });
      if (holdAppend) await gate;
      return outcome;
    },
    report: async (actionId, result) => void reports.push([actionId, result]),
  });
  return { sync, appends, reports, hold: () => void (holdAppend = true), release: () => release() };
}

describe("outcome log on this Mac", () => {
  it("the log target is an opaque id, never the note path", () => {
    expect(logTargetId(NOTE)).toMatch(/^[0-9a-f]{32}$/);
    expect(logTargetId(NOTE)).not.toContain("Outcomes");
    expect(logTargetId(NOTE)).toBe(logTargetId(NOTE));
  });

  it("appends through the grant whose write target matches, then reports the result", async () => {
    const other = grant({ id: "source-other" as SourceId, writeTargets: ["/Users/illustrative/vault/Other.md"] });
    const s = setup([other, grant()]);
    await s.sync.handle([item()]);
    expect(s.appends).toEqual([{ grant: grant(), request: { notePath: NOTE, marker: "tars-log-a1", entry: "Sent. [tars-log-a1]" } }]);
    expect(s.reports).toEqual([["a1", "written"]]);
  });

  it("a failed append is reported as failed, so the user sees it and can retry the log alone", async () => {
    const s = setup([grant()], { result: "failed", reason: "changed-during-write" });
    await s.sync.handle([item()]);
    expect(s.reports).toEqual([["a1", "failed"]]);
  });

  it("no active local grant for the target: nothing is written and it is reported failed", async () => {
    for (const grants of [[], [grant({ state: "paused" })], [grant({ kind: "claude-code" })]]) {
      const s = setup(grants);
      await s.sync.handle([item()]);
      expect(s.appends).toEqual([]);
      expect(s.reports).toEqual([["a1", "failed"]]);
    }
  });

  it("a subscription update while an append is in flight does not append the same action twice", async () => {
    const s = setup([grant()]);
    s.hold();
    const first = s.sync.handle([item()]);
    await s.sync.handle([item()]);
    s.release();
    await first;
    expect(s.appends).toHaveLength(1);
    expect(s.reports).toEqual([["a1", "written"]]);
  });
});
