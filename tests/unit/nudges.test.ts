import { describe, expect, test } from "vitest";
import { NUDGE_GAP_MS, decideNudge, dueSoonAt, nudgeCopy, type NudgeInput } from "../../packages/domain/src/attention";

const HOUR = 3_600_000;
const due = Date.parse("2026-11-14T22:00:00.000Z");
const now = due - 6 * HOUR;

const base: NudgeInput = {
  trigger: "return",
  nowMs: now,
  commitment: { ownership: "user", state: "open", dueAt: new Date(due).toISOString() },
  quiet: false,
  meeting: false,
  working: false,
};

describe("gentle nudge policy", () => {
  test("first_return_nudge_is_allowed_for_my_open_due_commitment", () => {
    expect(decideNudge(base)).toBe(true);
  });

  test("return_nudge_needs_two_hours_since_the_last_one", () => {
    expect(NUDGE_GAP_MS).toBe(2 * HOUR);
    expect(decideNudge({ ...base, lastNudgedAt: now - 2 * HOUR + 1 })).toBe(false);
    expect(decideNudge({ ...base, lastNudgedAt: now - 2 * HOUR })).toBe(true);
  });

  test("not_now_snoozes_until_the_next_allowed_window_not_forever", () => {
    // "Not now" is recorded as the last nudge: blocked for two hours, then allowed again.
    const saidNotNowAt = now;
    expect(decideNudge({ ...base, nowMs: now + HOUR, lastNudgedAt: saidNotNowAt })).toBe(false);
    expect(decideNudge({ ...base, nowMs: now + 2 * HOUR, lastNudgedAt: saidNotNowAt })).toBe(true);
  });

  test("never_during_quiet_hours_meetings_or_active_work", () => {
    expect(decideNudge({ ...base, quiet: true })).toBe(false);
    expect(decideNudge({ ...base, meeting: true })).toBe(false);
    expect(decideNudge({ ...base, working: true })).toBe(false);
    expect(decideNudge({ ...base, trigger: "due-soon", nowMs: dueSoonAt(due), quiet: true })).toBe(false);
  });

  test("stops_when_done_or_past_due", () => {
    expect(decideNudge({ ...base, commitment: { ...base.commitment, state: "user-reported-done" } })).toBe(false);
    expect(decideNudge({ ...base, commitment: { ...base.commitment, state: "verified-done" } })).toBe(false);
    expect(decideNudge({ ...base, nowMs: due })).toBe(false);
    expect(decideNudge({ ...base, nowMs: due + HOUR })).toBe(false);
  });

  test("only_my_commitments_with_a_due_time", () => {
    expect(decideNudge({ ...base, commitment: { ...base.commitment, ownership: "other" } })).toBe(false);
    expect(decideNudge({ ...base, commitment: { ...base.commitment, ownership: "unassigned" } })).toBe(false);
    expect(decideNudge({ ...base, commitment: { ownership: "user", state: "open" } })).toBe(false);
  });

  test("the_one_due_minus_one_hour_job_is_allowed_even_inside_the_gap", () => {
    expect(dueSoonAt(due)).toBe(due - HOUR);
    const dueSoon: NudgeInput = { ...base, trigger: "due-soon", nowMs: dueSoonAt(due), lastNudgedAt: dueSoonAt(due) - 10 * 60_000 };
    expect(decideNudge(dueSoon)).toBe(true);
    expect(decideNudge({ ...dueSoon, commitment: { ...base.commitment, state: "user-reported-done" } })).toBe(false);
  });

  test("copy_is_plain_and_kind", () => {
    const started = nudgeCopy({ text: "Send the budget to Dana", startedForYou: true });
    expect(started.body).toMatch(/I started this for you, want to finish it together\?/);
    const later = nudgeCopy({ text: "Send the budget to Dana", startedForYou: false });
    for (const copy of [started, later]) {
      expect(`${copy.title} ${copy.body}`).not.toMatch(/miss|late|overdue|streak|again|still|forgot|\d+ (times|nudges)/i);
    }
  });
});
