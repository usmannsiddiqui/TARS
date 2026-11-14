// Pure view derivations in the renderer: run-through segments, the observation permission status and
// cloud connection rows. Illustrative values only.
import { describe, expect, it } from "vitest";
import { cloudRow, permissionMissing, segmentsOf, setSegment } from "../../apps/desktop/src/renderer/model";

describe("segmentsOf", () => {
  const text = "Intro paragraph without a time.\n1. Welcome and why tools differ (2 min)\n2) Live demo: AI Studio (10 min)\n\nChoosing a tool (8 minutes)\nQuestions";

  it("turns timed lines into segments, keeps their line, and ignores untimed prose", () => {
    expect(segmentsOf(text)).toEqual([
      { line: 1, title: "Welcome and why tools differ", minutes: 2 },
      { line: 2, title: "Live demo: AI Studio", minutes: 10 },
      { line: 4, title: "Choosing a tool", minutes: 8 },
    ]);
  });

  it("returns no segments for prose", () => {
    expect(segmentsOf("A 25-minute segment for about 20 staff.")).toEqual([]);
  });
});

describe("setSegment", () => {
  const text = "Intro.\n1. Welcome (2 min)\n2) Live demo (10 min)\nQuestions";

  it("rewrites only that line, keeping its list marker", () => {
    expect(setSegment(text, 2, { title: "Live demo on a real task", minutes: 7 })).toBe("Intro.\n1. Welcome (2 min)\n2) Live demo on a real task (7 min)\nQuestions");
  });

  it("leaves the text alone when the line is not a segment", () => {
    expect(setSegment(text, 0, { title: "x", minutes: 1 })).toBe(text);
  });
});

describe("permissionMissing", () => {
  it("reads the observation status reason, which is what the main process sends", () => {
    // The preload's ObservationStatusEvent shape: { sourceId } & SourceStatus.
    const missing = { sourceId: "s1", freshness: "stale", reason: "permission-missing", files: 0, issues: [] };
    const failed = { sourceId: "s1", freshness: "stale", reason: "helper-failed", files: 0, issues: [] };
    const reading = { sourceId: "s1", freshness: "current", files: 2, issues: [] };
    expect(permissionMissing(missing)).toBe(true);
    expect(permissionMissing(failed)).toBe(false);
    expect(permissionMissing(reading)).toBe(false);
  });
});

describe("cloudRow", () => {
  const slack = { provider: "slack" as const, name: "Slack", coverage: "Selected channels." };
  const names: Record<string, string> = { "project-guides": "AI Guides" };
  const nameOf = (id: string) => names[id];
  const base = { sourceId: "slack-1", provider: "slack", availability: "connected", lastCheckedAt: "2026-11-14T09:00:00.000Z", selectors: ["C0123", "C0456"], projectIds: ["project-guides"] };

  it("is off with no connection", () => {
    expect(cloudRow(slack, [], nameOf)).toMatchObject({ id: "slack", provider: "slack", state: "off" });
    expect(cloudRow(slack, [], nameOf).unavailableReason).toBeUndefined();
  });

  it("shows the stored state and the selection of an active grant", () => {
    expect(cloudRow(slack, [{ ...base, state: "active" }], nameOf)).toMatchObject({
      id: "slack-1",
      state: "on",
      status: { kind: "last-checked", at: "2026-11-14T09:00:00.000Z" },
      selection: { selectors: ["C0123", "C0456"], projects: ["AI Guides"] },
    });
  });

  it("keeps a paused grant paused across reloads", () => {
    expect(cloudRow(slack, [{ ...base, state: "paused" }], nameOf)).toMatchObject({ id: "slack-1", state: "paused" });
  });

  it("treats a revoked grant as disconnected and prefers a live one", () => {
    const revoked = { ...base, state: "revoked" };
    expect(cloudRow(slack, [revoked], nameOf)).toMatchObject({ id: "slack", state: "off", unavailableReason: "Disconnected. New reads stopped." });
    expect(cloudRow(slack, [revoked, { ...base, sourceId: "slack-2", state: "active" }], nameOf)).toMatchObject({ id: "slack-2", state: "on" });
  });

  it("names a project it cannot find without inventing one", () => {
    expect(cloudRow(slack, [{ ...base, state: "active", projectIds: ["gone"] }], nameOf).selection?.projects).toEqual(["a project no longer listed"]);
  });

  it("maps availability problems to honest states", () => {
    expect(cloudRow(slack, [{ ...base, state: "active", availability: "missing-access", lastError: "no scope" }], nameOf).status).toEqual({ kind: "missing-access", detail: "no scope" });
    const { lastCheckedAt: _unchecked, ...neverChecked } = base;
    void _unchecked;
    expect(cloudRow(slack, [{ ...neverChecked, state: "active" }], nameOf).status).toEqual({ kind: "partial", detail: "Connected; not checked yet" });
  });
});
