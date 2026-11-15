// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProjectIdSchema, type ProjectId, type SourceKind } from "@companion/domain";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { makeEvidence, makeOwners } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");
const NY = "America/New_York";

// Injected clock: Date and timers are faked, so scheduled deadlines run through the real scheduler.
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-11-14T12:00:00Z")); // Saturday 07:00 in New York
  // Deadline work must never reach a provider or model.
  fetchMock = vi.fn(async () => {
    throw new Error("unexpected fetch");
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup() {
  const t = convexTest(schema, modules);
  const { alice } = makeOwners();
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const project = async (name: string): Promise<ProjectId> =>
    ProjectIdSchema.parse(await asAlice.mutation(api.projects.createProject, { name }));
  /** Grant + one ingested illustrative record from a source of `kind`. */
  const evidence = async (projectId: ProjectId, kind: SourceKind, text: string, occurredAt?: string) => {
    const record = makeEvidence(alice.ownerId, [projectId], { text, ...(occurredAt === undefined ? {} : { occurredAt }) });
    await asAlice.mutation(api.evidence.setGrant, {
      id: record.sourceId,
      kind,
      selectors: ["illustrative"],
      projectIds: [projectId],
      read: true,
      writeTargets: [],
      // Briefs read retained evidence only; without consent no automatic preparation is scheduled
      // (that path is covered in auto-draft.test.ts), so every job here is a brief deadline.
      cloudProcessing: false,
      version: 1,
      state: "active",
    });
    expect(await t.mutation(internal.evidence.ingest, { ownerId: alice.ownerId, sourceId: record.sourceId, record })).toBe(
      "accepted",
    );
    return record;
  };
  const connection = (sourceId: string, provider: SourceKind, lastCheckedAt: string) =>
    t.run((ctx) =>
      ctx.db.insert("connections", {
        ownerId: alice.ownerId,
        sourceId,
        provider,
        accountKey: `illustrative-${sourceId}`,
        credential: "sealed-illustrative",
        availability: "connected",
        lastCheckedAt,
      }),
    );
  const commitment = (projectId: ProjectId, text: string, extra: { dueAt?: string; evidenceIds?: string[]; state?: "open" | "waiting"; ownership?: "user" | "other" } = {}) =>
    t.run((ctx) =>
      ctx.db.insert("commitments", {
        ownerId: alice.ownerId,
        projectId,
        text,
        ownership: extra.ownership ?? "user",
        state: extra.state ?? "open",
        evidenceIds: extra.evidenceIds ?? [],
        ...(extra.dueAt === undefined ? {} : { dueAt: extra.dueAt }),
      }),
    );
  const commitments = () => t.run((ctx) => ctx.db.query("commitments").collect());
  const scheduled = () => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  const pending = async () =>
    (await scheduled())
      .filter((job) => job.state.kind === "pending")
      .map((job) => [job.name, new Date(job.scheduledTime).toISOString()])
      .sort();
  const settings = () => t.run((ctx) => ctx.db.query("attentionSettings").first());
  const pendingBriefs = () => t.run((ctx) => ctx.db.query("pendingBriefs").collect());
  /** Let the real scheduler run every deadline up to and including the next `kind` one. */
  const runDeadline = async (kind: "morning" | "evening") => {
    const row = (await settings())!;
    const target = kind === "morning" ? row.morningAt : row.eveningAt;
    while (Date.now() < target) {
      await vi.advanceTimersToNextTimerAsync();
      await t.finishInProgressScheduledFunctions();
    }
  };
  const configure = () => asAlice.mutation(api.briefs.setAttentionSettings, { timezone: NY });
  return { t, alice, asAlice, project, evidence, connection, commitment, commitments, scheduled, pending, settings, pendingBriefs, runDeadline, configure };
}

describe("deadlines", () => {
  test("timezone_change_cancels_old_deadline", async () => {
    const { asAlice, scheduled, pending, configure } = setup();
    await configure();
    expect(await pending()).toEqual([
      ["briefs:prepareEvening", "2026-11-15T00:30:00.000Z"], // 19:30 EST
      ["briefs:prepareMorning", "2026-11-14T14:00:00.000Z"], // 09:00 EST
    ]);

    await asAlice.mutation(api.briefs.setAttentionSettings, {
      timezone: "America/Los_Angeles",
      quietHours: { start: "22:00", end: "08:00" },
    });
    expect(await pending()).toEqual([
      ["briefs:prepareEvening", "2026-11-15T03:30:00.000Z"], // 19:30 PST
      ["briefs:prepareMorning", "2026-11-14T17:00:00.000Z"], // 09:00 PST
    ]);
    expect((await scheduled()).filter((job) => job.state.kind === "canceled")).toHaveLength(2);

    await expect(asAlice.mutation(api.briefs.setAttentionSettings, { timezone: "Not/AZone" })).rejects.toThrow(/timezone/i);
    await expect(
      asAlice.mutation(api.briefs.setAttentionSettings, { timezone: NY, quietHours: { start: "25:00", end: "08:00" } }),
    ).rejects.toThrow(/quiet/i);
    expect(await pending()).toHaveLength(2);
  });

  test("schedule_reports_the_next_scheduled_brief_times", async () => {
    const { t, asAlice, configure } = setup();
    // No settings yet: nothing is scheduled, and the query says so instead of inventing a time.
    expect(await asAlice.query(api.briefs.getSchedule, {})).toBeNull();
    await configure();
    expect(await asAlice.query(api.briefs.getSchedule, {})).toEqual({
      timezone: NY,
      morningAt: Date.parse("2026-11-14T14:00:00.000Z"),
      eveningAt: Date.parse("2026-11-15T00:30:00.000Z"),
    });
    // Another owner sees nothing of Alice's schedule.
    const asBob = t.withIdentity({ tokenIdentifier: makeOwners().bob.ownerId, subject: "bob" });
    expect(await asBob.query(api.briefs.getSchedule, {})).toBeNull();
  });

  test("no_notifications_pile_after_sleep", async () => {
    const { t, alice, asAlice, project, commitment, pending, pendingBriefs, runDeadline, configure } = setup();
    const avt = await project("AVT");
    await commitment(avt, "Draft the AVT pitch outline");
    await configure();

    // Three mornings pass while the Mac sleeps: each run replaces the pending brief and schedules one next.
    const stale = (await t.run((ctx) => ctx.db.query("attentionSettings").first()))!.morningAt;
    for (let day = 0; day < 3; day++) await runDeadline("morning");
    expect((await pendingBriefs()).map((row) => row.key).sort()).toEqual(["evening:2026-11-15", "morning:2026-11-16"]);
    expect((await pending()).filter(([name]) => String(name).includes("prepareMorning"))).toEqual([
      ["briefs:prepareMorning", "2026-11-17T14:00:00.000Z"],
    ]);
    // A late duplicate run for an old deadline changes nothing.
    const briefsBefore = await pendingBriefs();
    await t.mutation(internal.briefs.prepareMorning, { ownerId: alice.ownerId, scheduledFor: stale });
    expect(await pendingBriefs()).toEqual(briefsBefore);

    // Waking the Mac is not availability.
    vi.setSystemTime(new Date("2026-11-16T15:00:00Z"));
    expect(await asAlice.mutation(api.briefs.handleReturn, { panelOpen: false })).toEqual({
      decision: "defer",
      key: "morning:2026-11-16",
    });
    // After an explicit Stop, the single pending brief notifies once, then never again.
    await asAlice.mutation(api.briefs.recordSessionEvent, { kind: "stop" });
    const first = await asAlice.mutation(api.briefs.handleReturn, { panelOpen: false });
    expect(first).toEqual({ decision: "notify", key: "morning:2026-11-16" });
    await asAlice.mutation(api.briefs.markDelivered, { key: first.key!, channel: "notification" });
    expect((await asAlice.mutation(api.briefs.handleReturn, { panelOpen: false })).decision).not.toBe("notify");
    // What is left is the evening recap, which can only ever wait for the panel.
    expect((await asAlice.query(api.briefs.getAttentionState, {}))?.input.kind).toBe("evening");
  });
});

describe("briefs", () => {
  test("stale_canvas_is_not_claimed_current", async () => {
    const { project, evidence, connection, commitment, pendingBriefs, runDeadline, configure } = setup();
    const course = await project("Course");
    const old = await evidence(course, "canvas", "Illustrative: Essay 2 due 2026-11-15T23:59:00-05:00");
    await connection(old.sourceId, "canvas", "2026-11-11T09:00:00.000Z"); // three days before the brief
    const fresh = await evidence(course, "canvas", "Illustrative: Quiz due 2026-11-16T23:59:00-05:00");
    await connection(fresh.sourceId, "canvas", "2026-11-14T11:00:00.000Z");
    await commitment(course, "Submit Essay 2", { dueAt: "2026-11-16T04:59:00.000Z", evidenceIds: [old.id] });
    await commitment(course, "Take the quiz", { dueAt: "2026-11-17T04:59:00.000Z", evidenceIds: [fresh.id] });
    await configure();
    await runDeadline("morning");

    const { brief } = (await pendingBriefs()).find((row) => row.kind === "morning")!;
    expect(brief.staleSourceIds).toEqual([old.sourceId]);
    const essay = brief.hard.find((item) => item.text === "Submit Essay 2")!;
    expect(essay).toMatchObject({ current: false, lastCheckedAt: "2026-11-11T09:00:00.000Z" });
    expect(essay.label).toContain("last checked Wed, Nov 11");
    expect(essay.label).toContain("may have changed");
    expect(brief.hard.find((item) => item.text === "Take the quiz")).toMatchObject({ current: true });
  });

  test("new_commitment_flags_tradeoff_once", async () => {
    const { asAlice, project, commitment, runDeadline, configure } = setup();
    const avt = await project("AVT");
    await commitment(avt, "Send investor update", { dueAt: "2026-11-20T17:00:00.000Z" });
    await configure();
    await runDeadline("morning");
    const tradeoffs = async () => (await asAlice.query(api.briefs.getPendingBrief, {}))!.tradeoffs;
    expect(await tradeoffs()).toEqual([]); // the first obligation has nothing to clash with

    const added = await commitment(avt, "Record the demo video", { dueAt: "2026-11-20T21:00:00.000Z" });
    await runDeadline("morning");
    await runDeadline("morning");
    const flagged = await tradeoffs();
    expect(flagged).toHaveLength(1); // still one flag after another brief
    expect(flagged[0]!.text).toContain('"Send investor update"');

    await asAlice.mutation(api.briefs.resolveTradeoff, { commitmentId: added, choice: "keep" });
    expect(await tradeoffs()).toEqual([]);
    await runDeadline("morning");
    expect(await tradeoffs()).toEqual([]); // the choice ended it; no repeated confirmation
    await expect(asAlice.mutation(api.briefs.resolveTradeoff, { commitmentId: added, choice: "defer" })).rejects.toThrow();
  });

  test("reentry_returns_a_commitment_that_carries_its_stable_key", async () => {
    // Seen live: commitments gained `key`, getReentry's return validator did not, and Today went blank.
    const { asAlice, alice, project, t, configure } = setup();
    const avt = await project("AVT");
    await t.run((ctx) =>
      ctx.db.insert("commitments", { ownerId: alice.ownerId, projectId: avt, text: "Pitch deck", ownership: "user", state: "open", evidenceIds: [], key: `${avt}:pitch deck` }),
    );
    await configure();
    await asAlice.mutation(api.briefs.handleReturn, { panelOpen: true });
    const reentry = (await asAlice.query(api.briefs.getReentry, {}))!;
    expect(reentry.backlog.map((c) => c.text)).toEqual(["Pitch deck"]);
  });

  test("brief_does_not_reschedule_or_send", async () => {
    const { asAlice, project, evidence, commitment, commitments, scheduled, runDeadline, configure } = setup();
    const avt = await project("AVT");
    const mail = await evidence(avt, "gmail", "Illustrative: four things are due today.");
    for (const [i, text] of ["Pitch deck", "Budget", "Grant form", "Advisor email"].entries()) {
      await commitment(avt, text, { dueAt: new Date(Date.parse("2026-11-14T20:00:00Z") + i * 3_600_000).toISOString(), evidenceIds: [mail.id] });
    }
    const before = await commitments();
    await configure();
    await runDeadline("morning");
    await asAlice.mutation(api.briefs.recordSessionEvent, { kind: "stop" });
    await asAlice.mutation(api.briefs.handleReturn, { panelOpen: true });
    await asAlice.query(api.briefs.getReentry, {});
    await runDeadline("evening");

    const brief = (await asAlice.query(api.briefs.getPendingBrief, { kind: "morning" }))!.brief;
    // Recommends what to prioritize and renegotiate...
    expect(brief.triage.map((item) => item.action)).toEqual(["prioritize", "prioritize", "prioritize", "renegotiate"]);
    expect(brief.triage[3]!.reason).toMatch(/move it/);
    // ...and changes, sends or reschedules nothing.
    expect(await commitments()).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await scheduled()).every((job) => /^briefs:prepare(Morning|Evening)$/.test(job.name))).toBe(true);
  });

  test("five_day_return_preserves_backlog_and_draft", async () => {
    const { t, alice, asAlice, project, evidence, commitment, commitments, pendingBriefs, runDeadline, configure } = setup();
    const avt = await project("AVT");
    const guides = await project("AI Guides");
    await asAlice.mutation(api.projects.switchProject, { targetProjectId: avt, userInitiated: true });
    await asAlice.mutation(api.projects.setNextStep, { projectId: avt, nextStep: "Tighten the pitch opening.", userInitiated: true });
    const draft = await t.run((ctx) =>
      ctx.db.insert("artifacts", { ownerId: alice.ownerId, projectId: avt, revision: "r3", text: "Illustrative pitch draft.", userEdited: true, evidenceIds: [] }),
    );
    await configure();
    await asAlice.mutation(api.briefs.handleReturn, { panelOpen: true }); // last seen: day 0

    vi.setSystemTime(new Date("2026-11-14T13:00:00Z")); // news arrives after the user left
    const memo = await evidence(guides, "slack", "Illustrative: guide review moved up.");
    await commitment(guides, "Review guide draft", { dueAt: "2026-11-20T15:00:00.000Z", evidenceIds: [memo.id] });
    await commitment(avt, "Update the budget sheet");
    await commitment(avt, "Collect advisor notes");
    await commitment(guides, "Dana sends the agenda", { ownership: "other", state: "waiting" });
    const before = await commitments();

    for (let day = 0; day < 5; day++) {
      await runDeadline("morning");
      await runDeadline("evening");
    }
    vi.setSystemTime(new Date("2026-11-19T16:00:00Z")); // five days later
    await asAlice.mutation(api.briefs.handleReturn, { panelOpen: true });
    const reentry = (await asAlice.query(api.briefs.getReentry, {}))!;

    expect(Math.abs(Date.parse(reentry.since!) - Date.parse("2026-11-14T12:00:00Z"))).toBeLessThan(1000);
    expect(reentry.changedCount).toBe(1);
    expect(reentry.urgent.map((item) => item.text)).toEqual(["Review guide draft"]);
    expect(reentry.recommendedAction).toBe("Review guide draft"); // one manageable next action
    // Full backlog reachable and untouched; the draft is preserved as it was.
    expect(reentry.backlog.map((c) => c.text).sort()).toEqual(before.map((c) => c.text).sort());
    expect(await commitments()).toEqual(before);
    expect(reentry.drafts).toEqual([{ artifactId: draft, projectId: avt, revision: "r3", userEdited: true, preview: "Illustrative pitch draft." }]);
    expect((await pendingBriefs()).filter((row) => row.kind === "morning")).toHaveLength(1);
  });

  test("morning_brief_records_what_it_read", async () => {
    const { t, asAlice, project, evidence, commitment, runDeadline, configure } = setup();
    const avt = await project("AVT");
    await evidence(avt, "gmail", "Illustrative: venue confirms Saturday");
    await evidence(avt, "gmail", "Illustrative: co-presenter sends slides");
    await evidence(avt, "outlook-mail", "Illustrative: invoice question");
    await evidence(avt, "outlook-calendar", "Illustrative: rehearsal call", "2026-11-14T16:00:00.000Z"); // today, 11:00 in New York
    await evidence(avt, "outlook-calendar", "Illustrative: stand-up", "2026-11-15T15:00:00.000Z"); // tomorrow
    await evidence(avt, "canvas", "Illustrative: Essay 2 due", "2026-11-17T04:59:00.000Z"); // in range
    await evidence(avt, "canvas", "Illustrative: final project due", "2026-12-10T04:59:00.000Z"); // weeks away
    await commitment(avt, "Draft the AVT pitch outline");
    await commitment(avt, "Confirm the equipment list");
    await commitment(avt, "Book the room", { ownership: "other", state: "waiting" });
    await configure();
    await runDeadline("morning");

    const first = await asAlice.query(api.briefs.getPendingBrief, { kind: "morning" });
    expect(first?.read).toEqual([
      { kind: "canvas", count: 1 },
      { kind: "commitments", count: 2 },
      { kind: "gmail", count: 2 },
      { kind: "outlook-calendar", count: 1 },
      { kind: "outlook-mail", count: 1 },
    ]);
    // Another owner reads none of it.
    const asBob = t.withIdentity({ tokenIdentifier: makeOwners().bob.ownerId, subject: "bob" });
    expect(await asBob.query(api.briefs.getPendingBrief, { kind: "morning" })).toBeNull();

    // The next morning: no mail arrived since the last brief, so no mail is claimed as read; tomorrow's meeting is today's.
    await runDeadline("morning");
    const second = await asAlice.query(api.briefs.getPendingBrief, { kind: "morning" });
    expect(second?.read).toEqual([
      { kind: "canvas", count: 1 },
      { kind: "commitments", count: 2 },
      { kind: "outlook-calendar", count: 1 },
    ]);
  });

  test("brief_with_nothing_connected_records_no_reads", async () => {
    const { asAlice, runDeadline, configure } = setup();
    await configure();
    await runDeadline("morning");
    expect((await asAlice.query(api.briefs.getPendingBrief, { kind: "morning" }))?.read).toEqual([]);
  });
});
