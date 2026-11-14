import { describe, expect, it } from "vitest";
import type { Commitment, ProjectSummary } from "../../apps/desktop/src/renderer/model";
import { recommendStart } from "../../apps/desktop/src/renderer/recommend";

// Illustrative projects only.
const NOW = "2026-11-14T15:00:00.000Z";
const ready = { status: "ready" as const, updatedAt: NOW, work: { title: "Run-through", body: "b", evidenceIds: [], gaps: [], nextAction: "Open slide 9", state: "ready" as const } };
const mine = (text: string, dueAt?: string): Commitment => ({
  id: text,
  text,
  ownership: "user",
  state: "open",
  evidenceIds: [],
  ...(dueAt ? { dueAt } : {}),
});
const project = (id: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({ id, name: id.toUpperCase(), commitments: [], ...extra });

describe("recommendStart", () => {
  it("keeps the user's chosen focus when nothing is more urgent", () => {
    const projects = [project("avt", { prepared: ready }), project("guides", { prepared: ready })];
    expect(recommendStart(projects, "guides", NOW)).toEqual({
      projectId: "guides",
      reason: "You chose GUIDES last, and prepared work is ready.",
    });
  });

  it("a hard deadline within two days beats the chosen focus, and says so", () => {
    const projects = [project("guides", { prepared: ready }), project("course", { commitments: [mine("Essay draft", "2026-11-15T17:00:00.000Z")] })];
    const rec = recommendStart(projects, "guides", NOW);
    expect(rec?.projectId).toBe("course");
    expect(rec?.reason).toMatch(/^Essay draft is due /);
  });

  it("ignores deadlines that are far off, done, or someone else's", () => {
    const later = mine("Later", "2026-12-20T17:00:00.000Z");
    const theirs: Commitment = { ...mine("Theirs", "2026-11-15T10:00:00.000Z"), ownership: "other" };
    const done: Commitment = { ...mine("Done", "2026-11-15T10:00:00.000Z"), state: "verified-done" };
    const projects = [project("a", { commitments: [later, theirs, done] }), project("b", { prepared: ready })];
    expect(recommendStart(projects, undefined, NOW)).toEqual({ projectId: "b", reason: "Prepared work is ready from your sources." });
  });

  it("falls back to open work of yours, then to nothing at all", () => {
    expect(recommendStart([project("a"), project("b", { commitments: [mine("x"), mine("y")] })], undefined, NOW)).toEqual({
      projectId: "b",
      reason: "You have 2 open items here.",
    });
    expect(recommendStart([project("a"), project("b")], undefined, NOW)).toBeNull();
  });
});
