// The words on a helper card come only from the run row's real stage; illustrative values only.
import { describe, expect, it } from "vitest";
import { helperWords, type HelperRun } from "../../apps/desktop/src/renderer/model";

const run = (over: Partial<HelperRun>): HelperRun => ({ projectId: "p1", projectName: "AI Guides", state: "running", sources: [], ...over });

describe("helperWords", () => {
  it("says each real stage in plain words, with the Working state word", () => {
    expect(helperWords(run({ state: "pending" }))).toEqual({ state: { kind: "working" }, doing: "Starting" });
    expect(helperWords(run({ stage: "reading" }))).toEqual({ state: { kind: "working" }, doing: "Reading this project's sources" });
    expect(helperWords(run({ stage: "drafting", sources: [{ kind: "gmail", count: 4 }, { kind: "slack", count: 2 }] }))).toEqual({
      state: { kind: "working" },
      doing: "Drafting from 6 items",
    });
    expect(helperWords(run({ stage: "drafting", sources: [{ kind: "notion", count: 1 }] })).doing).toBe("Drafting from 1 item");
    expect(helperWords(run({ stage: "saving", sources: [{ kind: "gmail", count: 1 }] })).doing).toBe("Checking it against your sources, then saving");
  });

  it("a failed run uses the existing failure wording and reads as Needs retry", () => {
    expect(helperWords(run({ state: "failed" }))).toEqual({
      state: { kind: "needs-retry" },
      doing: "The last preparation failed; the earlier version is kept.",
    });
  });

  it("never shows a number it does not have: no percentage, no timer", () => {
    for (const r of [run({ state: "pending" }), run({ stage: "reading" }), run({ stage: "saving" }), run({ state: "failed" })]) {
      expect(helperWords(r).doing).not.toMatch(/\d/);
    }
  });
});
