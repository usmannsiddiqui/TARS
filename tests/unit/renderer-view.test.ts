// Pure view derivations in the renderer: run-through segments, the observation permission status and
// cloud connection rows. Illustrative values only.
import { describe, expect, it } from "vitest";
import { byDay, cloudRow, kindFromUrl, permissionMissing, segmentsOf, setSegment, tarsCalendar, type ProjectSummary } from "../../apps/desktop/src/renderer/model";

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

  it("says honestly whether sending is allowed, only where sending exists", () => {
    const gmail = { provider: "gmail" as const, name: "Gmail", coverage: "Selected labels." };
    const row = (sending?: "allowed" | "not-allowed") => cloudRow(gmail, [{ ...base, provider: "gmail", state: "active", broker: "composio", ...(sending ? { sending } : {}) }], nameOf);
    expect(row("allowed").sending).toBe("allowed");
    expect(row("not-allowed").sending).toBe("not-allowed");
    expect(row().sending).toBeUndefined();
    expect(cloudRow(gmail, [], nameOf).sending).toBeUndefined(); // not connected: nothing to allow yet
  });

  it("says how a Composio source was last checked", () => {
    const via = (checkedVia: "pushed" | "opened") => cloudRow(slack, [{ ...base, state: "active", broker: "composio", checkedVia }], nameOf).status;
    expect(via("pushed")).toEqual({ kind: "last-checked", at: base.lastCheckedAt, detail: "pushed by Composio" });
    expect(via("opened")).toEqual({ kind: "last-checked", at: base.lastCheckedAt, detail: "checked when you opened TARS" });
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

// Local times, so day boundaries are the Mac's own whatever zone the test runs in.
const at = (day: number, hour: number) => new Date(2026, 10, 14 + day, hour).getTime();
const NOW = at(0, 12);

describe("byDay", () => {
  it("groups by local calendar day in the given order and names today and tomorrow", () => {
    const items = [{ t: at(0, 15) }, { t: at(0, 9) }, { t: at(1, 10) }, { t: at(5, 17) }];
    const days = byDay(items, (i) => i.t, NOW);
    expect(days.map((d) => d.key)).toEqual(["2026-11-14", "2026-11-15", "2026-11-19"]);
    expect(days.map((d) => d.items.length)).toEqual([2, 1, 1]);
    expect(days[0]!.label).toBe("Today");
    expect(days[1]!.label).toBe("Tomorrow");
    expect(days[2]!.label).not.toMatch(/Today|Tomorrow|Yesterday/);
  });

  it("names yesterday and returns nothing for nothing", () => {
    expect(byDay([{ t: at(-1, 20) }], (i) => i.t, NOW)[0]!.label).toBe("Yesterday");
    expect(byDay([], (i: { t: number }) => i.t, NOW)).toEqual([]);
  });
});

describe("tarsCalendar", () => {
  const iso = (day: number, hour: number) => new Date(at(day, hour)).toISOString();
  const projects: ProjectSummary[] = [
    { id: "p1", name: "AI Guides", commitments: [], prepared: { status: "ready", updatedAt: iso(0, 8), work: { title: "Run-through", body: "", evidenceIds: ["e1", "e2", "e3"], gaps: [], nextAction: "Time the demo.", state: "ready" } } },
    { id: "p2", name: "Coursework", commitments: [], prepared: { status: "needs-retry", updatedAt: iso(-1, 9), lastError: "model_failed" } },
    { id: "p3", name: "Personal", commitments: [] },
  ];
  const input = {
    now: NOW,
    schedule: { morningAt: at(1, 9), eveningAt: at(0, 19) },
    briefs: [{ kind: "morning" as const, preparedAt: at(0, 9), delivered: false }],
    projects,
    sources: [
      { name: "Notion", availability: "connected", lastCheckedAt: iso(0, 7) },
      { name: "Canvas", availability: "stale", lastCheckedAt: iso(-4, 12) },
      { name: "Gmail", availability: "missing-access", lastError: "no scope" },
    ],
  };

  it("plans only what is really scheduled, soonest first", () => {
    const { upcoming } = tarsCalendar(input);
    expect(upcoming.map((e) => [e.title, e.at])).toEqual([
      ["Evening recap", at(0, 19)],
      ["Morning brief", at(1, 9)],
    ]);
    expect(upcoming.every((e) => e.state.kind === "scheduled")).toBe(true);
  });

  it("logs what TARS did from real timestamps, newest first, and invents nothing", () => {
    const { done } = tarsCalendar(input);
    expect(done.map((e) => [e.title, e.at])).toEqual([
      ["Prepared the morning brief", at(0, 9)],
      ["Prepared AI Guides", at(0, 8)],
      ["Checked Notion", at(0, 7)],
    ]);
    expect(done[0]!.detail).toBe("Not shown to you yet");
    expect(done[1]!.detail).toBe("Run-through · from 3 source items");
    // Nothing prepared yet is not an event.
    expect(done.some((e) => e.title.includes("Personal"))).toBe(false);
  });

  it("puts failures and out-of-date sources under needs a look", () => {
    const { attention } = tarsCalendar(input);
    expect(attention.map((e) => [e.title, e.state.kind])).toEqual([
      ["Could not prepare Coursework", "needs-retry"],
      ["Canvas may be out of date", "stale"],
      ["Gmail needs access", "missing-access"],
    ]);
  });

  it("has no plan without a schedule and no past without events", () => {
    const empty = tarsCalendar({ now: NOW, schedule: null, briefs: [], projects: [], sources: [] });
    expect(empty).toEqual({ upcoming: [], done: [], attention: [] });
  });

  it("names the source of each source check, and only of those", () => {
    const { done, attention } = tarsCalendar(input);
    expect(done.map((e) => e.source)).toEqual([undefined, undefined, "Notion"]);
    expect(attention.map((e) => e.source)).toEqual([undefined, "Canvas", "Gmail"]);
  });
});

describe("kindFromUrl", () => {
  it("recognises the providers' own hosts", () => {
    expect(kindFromUrl("https://acme.slack.com/archives/C0123/p1")).toBe("slack");
    expect(kindFromUrl("https://mail.google.com/mail/u/0/#inbox/1")).toBe("gmail");
    expect(kindFromUrl("https://www.notion.so/Plan-8f2c")).toBe("notion");
    expect(kindFromUrl("https://umass.instructure.com/courses/1182/assignments/4")).toBe("canvas");
    expect(kindFromUrl("https://outlook.office.com/mail")).toBe("outlook-mail");
    expect(kindFromUrl("https://outlook.office.com/calendar/item/1")).toBe("outlook-calendar");
    expect(kindFromUrl("https://github.com/octo-labs/app/pull/7")).toBe("github");
  });

  it("does not guess from look-alike hosts, other schemes or bad input", () => {
    expect(kindFromUrl("https://notion.so.example.com/x")).toBeUndefined();
    expect(kindFromUrl("https://example.com/slack.com")).toBeUndefined();
    expect(kindFromUrl("http://mail.google.com/")).toBeUndefined();
    expect(kindFromUrl("not a url")).toBeUndefined();
    expect(kindFromUrl(undefined)).toBeUndefined();
  });
});
