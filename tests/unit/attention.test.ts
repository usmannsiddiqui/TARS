import { describe, expect, test } from "vitest";
import type { AttentionInput, Commitment, EvidenceId, OwnerId, ProjectId, SourceId, TaskId } from "@companion/domain";
import {
  assembleBrief,
  decideAttention,
  invitationKey,
  localDate,
  nextLocalTime,
  sessionState,
  type BriefContext,
} from "../../packages/domain/src/attention";

const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);

// Saturday 2026-11-14 09:00 in New York (EST, UTC-5).
const input: AttentionInput = {
  kind: "morning",
  now: "2026-11-14T14:00:00.000Z",
  timezone: NY,
  working: false,
  meeting: false,
  quiet: false,
  availability: "available",
  panelOpen: false,
  alreadyDelivered: false,
  hasPreparedWork: true,
};

describe("contact policy", () => {
  test("morning_at_nine_defers_when_busy", () => {
    expect(decideAttention(input)).toBe("notify");
    expect(decideAttention({ ...input, working: true })).toBe("defer");
    expect(decideAttention({ ...input, meeting: true })).toBe("defer");
    expect(decideAttention({ ...input, quiet: true })).toBe("defer");
    expect(decideAttention({ ...input, availability: "unknown" })).toBe("defer");
    // Once only, and only with something useful to show.
    expect(decideAttention({ ...input, alreadyDelivered: true })).not.toBe("notify");
    expect(decideAttention({ ...input, hasPreparedWork: false })).not.toBe("notify");
    // An open panel shows it without an OS alert.
    expect(decideAttention({ ...input, panelOpen: true })).toBe("panel-only");
  });

  test("evening_never_notifies", () => {
    expect(decideAttention({ ...input, kind: "evening", panelOpen: true })).toBe("panel-only");
    expect(decideAttention({ ...input, kind: "evening", panelOpen: false })).not.toBe("notify");
    const flags = [true, false];
    let combinations = 0;
    for (const working of flags)
      for (const meeting of flags)
        for (const quiet of flags)
          for (const panelOpen of flags)
            for (const alreadyDelivered of flags)
              for (const hasPreparedWork of flags)
                for (const availability of ["available", "unknown"] as const) {
                  const decision = decideAttention({
                    ...input,
                    kind: "evening",
                    working,
                    meeting,
                    quiet,
                    panelOpen,
                    alreadyDelivered,
                    hasPreparedWork,
                    availability,
                  });
                  expect(decision).not.toBe("notify");
                  combinations++;
                }
    expect(combinations).toBe(128);
  });

  test("wake_does_not_prove_availability", () => {
    const now = at("2026-11-14T14:00:00Z");
    // Waking or unlocking the Mac is recorded as a "return", which says nothing about availability.
    const woke = sessionState([{ kind: "return", at: now - 60_000 }], now, NY);
    expect(woke).toEqual({ working: false, meeting: false, availability: "unknown" });
    expect(decideAttention({ ...input, kind: "task-return", ...woke })).toBe("defer");
    expect(decideAttention({ ...input, kind: "morning", ...woke })).toBe("defer");

    // An explicit Stop earlier today is a known state; yesterday's Stop is not.
    const stopped = sessionState([{ kind: "stop", at: now - 30 * 60_000 }], now, NY);
    expect(stopped.availability).toBe("available");
    expect(sessionState([{ kind: "stop", at: now - 24 * 3_600_000 }], now, NY).availability).toBe("unknown");
    // Working state comes only from explicit Start/Stop/Break and meeting events.
    expect(sessionState([{ kind: "start", at: now - 60_000 }], now, NY).working).toBe(true);
    expect(sessionState([{ kind: "meeting-start", at: now - 60_000 }], now, NY).meeting).toBe(true);
    expect(
      sessionState(
        [
          { kind: "meeting-start", at: now - 120_000 },
          { kind: "meeting-end", at: now - 60_000 },
        ],
        now,
        NY,
      ),
    ).toEqual({ working: false, meeting: false, availability: "available" });
  });

  test("dismissed_invitation_does_not_repeat", () => {
    const project = "project-avt" as ProjectId;
    const work = { projectId: project, updatedAt: "2026-11-14T13:00:00.000Z" };
    const dismissed = new Set([invitationKey(work)]);
    const offer = (w: typeof work) =>
      decideAttention({ ...input, kind: "task-return", alreadyDelivered: dismissed.has(invitationKey(w)) });

    expect(offer(work)).not.toBe("notify");
    expect(offer({ ...work })).not.toBe("notify"); // same unchanged work, asked again
    expect(offer({ ...work, updatedAt: "2026-11-14T15:00:00.000Z" })).toBe("notify"); // new work may be offered
  });
});

describe("local deadlines", () => {
  test("dst_produces_one_local_morning", () => {
    const local = (ms: number) =>
      new Intl.DateTimeFormat("en-US", { timeZone: NY, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(ms);
    // Each run schedules the next from its own deadline, across the 2026-11-01 fall-back.
    let deadline = nextLocalTime(at("2026-10-30T15:00:00Z"), NY, 9, 0);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push(deadline);
      deadline = nextLocalTime(deadline, NY, 9, 0);
    }
    expect(runs.map((ms) => localDate(ms, NY))).toEqual(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(runs.map(local)).toEqual(["09:00", "09:00", "09:00", "09:00", "09:00"]);
    expect(runs[1]! - runs[0]!).toBe(25 * 3_600_000); // the long day, still one morning
    expect(runs[2]! - runs[1]!).toBe(24 * 3_600_000);

    // Spring forward (2026-03-08 02:00): a 23-hour gap, still exactly one 09:00.
    const before = nextLocalTime(at("2026-03-06T15:00:00Z"), NY, 9, 0);
    const after = nextLocalTime(before, NY, 9, 0);
    expect([localDate(before, NY), localDate(after, NY)]).toEqual(["2026-03-07", "2026-03-08"]);
    expect(after - before).toBe(23 * 3_600_000);
    expect(local(after)).toBe("09:00");

    // A run exactly at its deadline never re-schedules the same morning.
    expect(nextLocalTime(at("2026-11-14T14:00:00Z"), NY, 9, 0)).toBe(at("2026-11-15T14:00:00Z"));
    expect(nextLocalTime(at("2026-11-14T12:00:00Z"), NY, 19, 30)).toBe(at("2026-11-15T00:30:00Z"));
  });
});

describe("brief assembly", () => {
  const owner = "owner-alice" as OwnerId;
  const avt = "project-avt" as ProjectId;
  const guides = "project-guides" as ProjectId;
  const canvas = "source-canvas" as SourceId;
  const commitment = (id: string, projectId: ProjectId, text: string, extra: Partial<Commitment> = {}): Commitment => ({
    id: id as TaskId,
    ownerId: owner,
    projectId,
    text,
    ownership: "user",
    evidenceIds: [],
    state: "open",
    ...extra,
  });
  const context = (commitments: Commitment[]): BriefContext => ({
    ownerId: owner,
    projects: [avt, guides],
    commitments,
    lastFocus: { projectId: avt, nextStep: "Tighten the AVT pitch opening." },
    evidence: [
      {
        id: "ev-canvas" as EvidenceId,
        ownerId: owner,
        sourceId: canvas,
        externalId: "assignment-1",
        version: "1",
        text: "Illustrative: Essay due 2026-11-14T23:59:00-05:00",
        occurredAt: "2026-11-13T12:00:00.000Z",
        receivedAt: "2026-11-13T12:00:00.000Z",
        projectIds: [guides],
        grantVersion: 1,
        freshness: "current",
        origin: "illustrative",
      },
    ],
    now: input.now,
    timezone: NY,
    sources: [{ id: canvas, kind: "canvas", lastCheckedAt: "2026-11-14T13:00:00.000Z", availability: "connected" }],
    preparedWork: [],
  });

  test("previous_focus_wins_unless_an_evidenced_deadline_outranks_it", () => {
    const calm = assembleBrief(context([commitment("t1", guides, "Draft the guide outline")]), "morning");
    expect(calm.recommendedAction).toBe("Tighten the AVT pitch opening.");
    expect(calm.suggested.map((s) => s.text)).toEqual(["Tighten the AVT pitch opening.", "Draft the guide outline"]);
    expect(calm.hard).toEqual([]);

    // A due date the user only typed (no evidence) does not outrank the chosen focus.
    const unbacked = assembleBrief(
      context([commitment("t2", guides, "Submit the essay", { dueAt: "2026-11-15T04:59:00.000Z" })]),
      "morning",
    );
    expect(unbacked.recommendedAction).toBe("Tighten the AVT pitch opening.");

    const due = assembleBrief(
      context([
        commitment("t2", guides, "Submit the essay", { dueAt: "2026-11-15T04:59:00.000Z", evidenceIds: ["ev-canvas" as EvidenceId] }),
      ]),
      "morning",
    );
    expect(due.recommendedAction).toBe("Submit the essay");
    expect(due.reason).toMatch(/^Due /);
    expect(due.hard).toMatchObject([{ commitmentId: "t2", kind: "deadline", sourceKind: "canvas", current: true }]);
    expect(due.suggested.map((s) => s.text)).toEqual(["Tighten the AVT pitch opening."]);
  });
});
