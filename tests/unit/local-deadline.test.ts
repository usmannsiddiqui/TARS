import { describe, expect, test } from "vitest";
import { localToUtc } from "../../packages/domain/src/attention";
import { dueInstant } from "../../packages/domain/src/prepare";

const NY = "America/New_York";
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

describe("local wall time to UTC", () => {
  test("ordinary_times_use_the_zone_offset_of_that_day", () => {
    expect(iso(localToUtc("2026-11-16T17:00", NY))).toBe("2026-11-16T22:00:00.000Z"); // EST
    expect(iso(localToUtc("2026-07-01T09:30", NY))).toBe("2026-07-01T13:30:00.000Z"); // EDT
    expect(iso(localToUtc("2026-11-16T17:00", "Asia/Kolkata"))).toBe("2026-11-16T11:30:00.000Z");
  });

  test("november_overlap_picks_the_earlier_instant", () => {
    // 2026-11-01 01:30 happens twice in New York: 05:30Z (EDT) and 06:30Z (EST).
    expect(iso(localToUtc("2026-11-01T01:30", NY))).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(localToUtc("2026-11-01T00:59", NY))).toBe("2026-11-01T04:59:00.000Z");
    expect(iso(localToUtc("2026-11-01T02:00", NY))).toBe("2026-11-01T07:00:00.000Z");
  });

  test("march_gap_moves_forward_by_the_gap", () => {
    // 2026-03-08 02:30 does not exist in New York; it is read as 03:30 EDT.
    expect(iso(localToUtc("2026-03-08T02:30", NY))).toBe("2026-03-08T07:30:00.000Z");
    expect(iso(localToUtc("2026-03-08T01:59", NY))).toBe("2026-03-08T06:59:00.000Z");
    expect(iso(localToUtc("2026-03-08T03:00", NY))).toBe("2026-03-08T07:00:00.000Z");
  });

  test("malformed_or_impossible_wall_times_are_rejected", () => {
    expect(localToUtc("2026-13-01T10:00", NY)).toBeUndefined();
    expect(localToUtc("2026-02-30T10:00", NY)).toBeUndefined();
    expect(localToUtc("2026-11-16T24:00", NY)).toBeUndefined();
    expect(localToUtc("tomorrow 5pm", NY)).toBeUndefined();
  });
});

describe("model due time", () => {
  const written = [Date.parse("2026-11-15T14:00:00Z")];

  test("a_local_wall_time_is_converted_with_the_users_zone", () => {
    expect(dueInstant("2026-11-16T17:00", written, NY)).toBe("2026-11-16T22:00:00.000Z");
    expect(dueInstant("2026-11-16T17:00", written, null)).toBeUndefined(); // no zone: nothing guessed
  });

  test("a_zone_named_with_the_deadline_wins_for_that_deadline", () => {
    expect(dueInstant("2026-11-16T17:00 America/Los_Angeles", written, NY)).toBe("2026-11-17T01:00:00.000Z");
    expect(dueInstant("2026-11-16T17:00 Not/AZone", written, NY)).toBeUndefined();
  });

  test("legacy_instants_are_taken_as_given_and_absurd_dates_rejected", () => {
    expect(dueInstant("2026-11-16T22:00:00Z", written, NY)).toBe("2026-11-16T22:00:00.000Z");
    expect(dueInstant("2026-11-16T17:00:00-05:00", written, null)).toBe("2026-11-16T22:00:00.000Z");
    expect(dueInstant("2031-01-01T10:00", written, NY)).toBeUndefined();
    expect(dueInstant("2026-11-13T10:00", written, NY)).toBeUndefined();
  });
});
