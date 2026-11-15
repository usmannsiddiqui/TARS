// The three-pane shell's pure view-model: Today as a thread, the left list's previews and the routines.
// Illustrative values only.
import { describe, expect, it } from "vitest";
import { viewBlock } from "../../packages/domain/src/thread";
import { routineRows, rowPreview, rowTime, todayPreview, todayThread, type Brief, type ProjectSummary, type TodayInput } from "../../apps/desktop/src/renderer/model";

const NOW = new Date(2026, 10, 14, 10, 0).getTime(); // Saturday 14 November 2026, 10:00 local
const at = (d: number, h: number, m = 0) => new Date(2026, 10, 14 + d, h, m).getTime();
const iso = (d: number, h: number) => new Date(at(d, h)).toISOString();

const projects: ProjectSummary[] = [
  {
    id: "guides",
    name: "AI Guides",
    commitments: [
      { id: "c1", text: "Send the slide order", ownership: "user", state: "open", dueAt: iso(6, 17), evidenceIds: [] },
      { id: "c2", text: "Book the room", ownership: "other", state: "waiting", evidenceIds: [] },
    ],
    prepared: { status: "ready", updatedAt: iso(0, 8), work: { title: "Run-through", body: "", evidenceIds: [], gaps: [], nextAction: "Time it", state: "ready" } },
  },
  { id: "avt", name: "AVT", commitments: [{ id: "a1", text: "Confirm the list", ownership: "user", state: "open", dueAt: iso(6, 9), evidenceIds: [] }] },
  { id: "personal", name: "Personal", commitments: [] },
  { id: "course", name: "Coursework", commitments: [], prepared: { status: "needs-retry", updatedAt: iso(-1, 9) } },
];

const morning: Brief = {
  key: "morning:2026-11-14",
  kind: "morning",
  preparedAt: at(0, 9),
  delivered: false,
  items: [],
  hard: [{ commitmentId: "c1", projectId: "guides", text: "Send the slide order", dueAt: iso(6, 17), kind: "deadline", current: true }],
  suggested: [{ projectId: "guides", text: "Time the demo against 25 minutes." }],
  triage: [],
  recommendedAction: "Time the demo against 25 minutes.",
  reason: "Nothing due sooner is backed by your sources.",
  stale: [{ name: "Canvas", lastCheckedAt: iso(-4, 16) }],
  read: [
    { kind: "outlook-mail", count: 4 },
    { kind: "commitments", count: 6 },
  ],
};

const input = (over: Partial<TodayInput> = {}): TodayInput => ({ now: NOW, brief: morning, helpers: [], ideas: [], projects, ...over });
const blocks = (thread: ReturnType<typeof todayThread>) => thread.flatMap((m) => m.blocks.map((b, i) => viewBlock(b, i)));

describe("todayThread (Today as one thread, from what is already stored)", () => {
  it("the morning brief: what it read as results, the list with the recommended start first, one note per stale source", () => {
    const thread = todayThread(input());
    expect(thread[0]).toMatchObject({ id: "morning:2026-11-14", role: "tars", createdAt: morning.preparedAt });
    const [results, start, stale] = blocks(thread);
    expect(results).toMatchObject({
      type: "results",
      complete: true,
      props: { items: [{ verb: "Read", text: "4 new emails", kind: "outlook-mail" }, { verb: "Went through", text: "6 open commitments", kind: "commitments" }] },
    });
    expect(start).toMatchObject({ type: "start", complete: true, props: { projectId: "guides", reason: morning.reason } });
    if (start?.type !== "start") throw new Error("no start block");
    expect(start.props.items?.[0]).toMatchObject({ text: "Time the demo against 25 minutes.", recommended: true, projectName: "AI Guides" });
    expect(stale).toMatchObject({ type: "say", props: { text: expect.stringMatching(/^Canvas may be out of date, last checked /) } });
  });

  it("says when the brief is loading or not prepared yet, with the real schedule only", () => {
    expect(blocks(todayThread(input({ brief: undefined })))).toMatchObject([{ type: "say", props: { text: "Reading today's brief…" } }]);
    expect(blocks(todayThread(input({ brief: null, schedule: { at: "9:00 AM" } })))).toMatchObject([{ type: "say", props: { text: "No brief yet. The first one comes at 9:00 AM." } }]);
    expect(blocks(todayThread(input({ brief: null })))).toMatchObject([{ type: "say", props: { text: "No brief yet." } }]);
  });

  it("the evening recap: its items, then that nothing else is needed", () => {
    const evening: Brief = { ...morning, key: "evening:x", kind: "evening", items: ["Done (verified): Send the slide order"], hard: [], suggested: [], stale: [] };
    expect(blocks(todayThread(input({ brief: evening })))).toMatchObject([
      { type: "results", props: { items: [{ text: "Done (verified): Send the slide order" }] } },
      { type: "say", props: { text: "Nothing else is needed tonight." } },
    ]);
  });

  it("after days away: re-entry replaces the brief, saying nothing was moved, deleted or sent", () => {
    const reentry = {
      since: iso(-4, 18),
      changed: [{ evidenceId: "e1", text: "Slides 9–18 exist", occurredAt: iso(-2, 16) }],
      changedCount: 3,
      urgent: [{ commitmentId: "m1", projectId: "avt", text: "Venue walk-through", dueAt: iso(0, 15), kind: "meeting" as const, current: true }],
      recommendedAction: "Venue walk-through",
      reason: "Due today at 3:00 PM.",
    };
    const [say, changed, start] = blocks(todayThread(input({ reentry })));
    expect(say).toMatchObject({ type: "say", props: { text: expect.stringMatching(/^Welcome back\. Since .+, nothing was moved, deleted or sent\.$/) } });
    expect(changed).toMatchObject({ type: "results", props: { items: [{ text: "Slides 9–18 exist" }, { text: "and 2 more in your sources" }] } });
    expect(start).toMatchObject({ type: "start", props: { projectId: "avt", items: [{ text: "Venue walk-through", recommended: true }] } });
  });

  it("helpers as work with their real stage; a failed one asks Try again or Dismiss", () => {
    const thread = todayThread(input({ helpers: [{ projectId: "avt", projectName: "AVT", state: "running", stage: "drafting", sources: [{ kind: "gmail", count: 3 }] }, { projectId: "course", projectName: "Coursework", state: "failed", sources: [] }] }));
    const run = thread.find((m) => m.id === "run:avt");
    expect(run && blocks([run])).toMatchObject([
      { type: "work", props: { steps: [{ status: "done" }, { status: "running", label: "Drafting AVT from 3 items", sources: [{ kind: "gmail", count: 3 }] }, { status: "waiting" }] } },
    ]);
    const failed = thread.find((m) => m.id === "run:course");
    expect(failed && blocks([failed])).toMatchObject([{ type: "ask", props: { id: "run:course", title: "Could not prepare Coursework", choices: [{ id: "retry" }, { id: "dismiss" }] } }]);
  });

  it("a nudge and a tradeoff are asks; the tradeoff says nothing is moved", () => {
    const thread = todayThread(
      input({
        nudge: { nudgeId: "n1", projectId: "guides", key: "k", title: "Slide order is due Friday", body: "I started a draft.", startedForYou: true, delivered: false },
        tradeoff: { commitmentId: "c9", text: "Two things compete." },
      }),
    );
    const asks = blocks(thread).filter((b) => b.type === "ask");
    expect(asks).toMatchObject([
      { props: { id: "nudge:n1", title: "Slide order is due Friday", choices: [{ id: "finish", label: "Finish it" }, { id: "not-now", label: "Not now" }], primaryId: "finish" } },
      { props: { id: "tradeoff:c9", choices: [{ label: "Keep both" }, { label: "Defer the new one" }, { label: "Renegotiate a deadline" }], note: "Your choice is recorded once. Nothing is moved, rescheduled or sent." } },
    ]);
  });

  it("captured ideas are his bubbles; the brain dump just saved is followed by its sorted block, once", () => {
    const thread = todayThread(
      input({ ideas: [{ text: "Ask about a quiet room" }, { text: "Finish the lab report" }], dump: { text: "Finish the lab report", at: at(0, 9, 55), view: { kind: "sorting", projects: 4 } } }),
    );
    const tail = thread.slice(-3);
    expect(tail).toMatchObject([
      { role: "user", text: "Ask about a quiet room" },
      { role: "user", text: "Finish the lab report", createdAt: at(0, 9, 55) },
      { role: "tars", blocks: [{ type: "sorted", props: { view: { kind: "sorting", projects: 4 } } }] },
    ]);
    expect(thread.filter((m) => m.text === "Finish the lab report")).toHaveLength(1);
  });

  it("no projects yet: one line asking for the first", () => {
    expect(blocks(todayThread(input({ projects: [], brief: null })))).toMatchObject([{ type: "say", props: { text: "Name the first thing you are working on. You can add the others later." } }]);
  });
});

describe("rowPreview (each left-list row's second line, first match wins, stored data only)", () => {
  const ctx = { helpers: [] };
  it("a running or waiting helper comes first", () => {
    expect(rowPreview(projects[0]!, { ...ctx, helpers: [{ projectId: "guides", projectName: "AI Guides", state: "running", stage: "reading", sources: [] }] })).toMatchObject({ text: "Working…" });
    expect(rowPreview(projects[0]!, { ...ctx, helpers: [{ projectId: "guides", projectName: "AI Guides", state: "pending", sources: [] }] })).toMatchObject({ text: "Waiting in line…" });
  });
  it("then a needed retry, then an open nudge", () => {
    expect(rowPreview(projects[3]!, ctx)).toEqual({ text: "Needs retry", warn: true, time: Date.parse(iso(-1, 9)) });
    expect(rowPreview(projects[0]!, { ...ctx, nudgeProjectId: "guides" })).toMatchObject({ text: "Needs an answer" });
  });
  it("a draft ready, with the next due time of his own open items", () => {
    expect(rowPreview(projects[0]!, ctx)).toEqual({ text: `Draft ready · due Fri 5:00 PM`, time: Date.parse(iso(0, 8)) });
  });
  it("open items with the next due day, else nothing prepared", () => {
    expect(rowPreview(projects[1]!, ctx)).toEqual({ text: "1 open, next due Fri" });
    expect(rowPreview(projects[2]!, ctx)).toEqual({ text: "Nothing prepared yet" });
  });
});

describe("todayPreview", () => {
  it("follows the brief's real state", () => {
    expect(todayPreview(undefined, undefined, projects)).toEqual({ text: "Reading today's brief…" });
    expect(todayPreview(morning, undefined, projects)).toEqual({ text: "Brief ready. 2 items, start with AI Guides", time: morning.preparedAt });
    expect(todayPreview({ ...morning, kind: "evening", items: ["a", "b", "c"] }, undefined, projects)).toMatchObject({ text: "Recap ready. 3 things today" });
    expect(todayPreview(null, { at: "9:00 AM" }, projects)).toEqual({ text: "No brief yet. First one at 9:00 AM" });
    expect(todayPreview(null, undefined, projects)).toEqual({ text: "No brief yet" });
  });
});

describe("rowTime", () => {
  it("clock today, Yesterday, weekday this week, else the date", () => {
    expect(rowTime(at(0, 9, 5), NOW)).toBe("9:05 AM");
    expect(rowTime(at(-1, 18), NOW)).toBe("Yesterday");
    expect(rowTime(at(-3, 18), NOW)).toBe("Wednesday");
    expect(rowTime(at(-11, 18), NOW)).toBe("Nov 3");
  });
});

describe("routineRows (the right pane's routines, schedule first)", () => {
  it("both routines with their real local times", () => {
    expect(routineRows({ timezone: "America/New_York", morningAt: Date.parse("2026-11-15T14:00:00Z"), eveningAt: Date.parse("2026-11-15T00:30:00Z") })).toEqual([
      { id: "morning", name: "Morning brief", summary: "Every day, 9:00 AM" },
      { id: "evening", name: "Evening recap", summary: "Every day, 7:30 PM" },
    ]);
  });
  it("without a schedule, says so; while loading, says it is reading", () => {
    expect(routineRows(null).map((r) => r.summary)).toEqual(["No schedule yet", "No schedule yet"]);
    expect(routineRows(undefined).map((r) => r.summary)).toEqual(["Reading the schedule…", "Reading the schedule…"]);
  });
});
