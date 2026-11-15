// The morning brief's "what I read" rows and schedule words come only from the stored record and the real schedule.
import { describe, expect, it } from "vitest";
import { briefList, briefSchedule, readRows, type HardItem } from "../../apps/desktop/src/renderer/model";

describe("readRows", () => {
  it("one row per kind really read, in reading order, with the real count in a plain sentence", () => {
    expect(
      readRows([
        { kind: "commitments", count: 6 },
        { kind: "gmail", count: 4 },
        { kind: "canvas", count: 2 },
        { kind: "outlook-calendar", count: 3 },
      ]),
    ).toEqual([
      { kind: "outlook-calendar", text: "Read today's 3 meetings" },
      { kind: "gmail", text: "Read 4 new emails" },
      { kind: "canvas", text: "Checked 2 Canvas deadlines" },
      { kind: "commitments", text: "Went through 6 open commitments" },
    ]);
  });

  it("says one item in the singular", () => {
    expect(readRows([{ kind: "outlook-calendar", count: 1 }, { kind: "outlook-mail", count: 1 }, { kind: "canvas", count: 1 }, { kind: "commitments", count: 1 }]).map((r) => r.text)).toEqual([
      "Read today's meeting",
      "Read 1 new email",
      "Checked 1 Canvas deadline",
      "Went through 1 open commitment",
    ]);
  });

  it("leaves out a zero, an unknown kind and a missing record", () => {
    expect(readRows([{ kind: "gmail", count: 0 }, { kind: "fax", count: 3 }, { kind: "slack", count: 2 }])).toEqual([{ kind: "slack", text: "Read 2 new Slack messages" }]);
    expect(readRows(undefined)).toEqual([]);
    expect(readRows([])).toEqual([]);
  });
});

describe("briefSchedule", () => {
  const NY = "America/New_York";
  const nineTomorrow = Date.parse("2026-11-15T14:00:00Z"); // Sunday 09:00 in New York

  it("says the daily routine and the next run from the real setting", () => {
    expect(briefSchedule(nineTomorrow, NY, Date.parse("2026-11-14T16:00:00Z"))).toEqual({ routine: "Every day · 9:00 AM", at: "9:00 AM", next: "tomorrow, 9:00 AM" });
  });

  it("says today when the next run is later today, and the weekday when it is further away", () => {
    expect(briefSchedule(nineTomorrow, NY, Date.parse("2026-11-15T12:00:00Z")).next).toBe("today, 9:00 AM");
    expect(briefSchedule(nineTomorrow, NY, Date.parse("2026-11-13T12:00:00Z")).next).toBe("Sunday, 9:00 AM");
  });
});

describe("briefList", () => {
  const hard = (text: string, kind: HardItem["kind"] = "deadline"): HardItem => ({ commitmentId: text, projectId: "p", text, dueAt: "2026-11-14T22:00:00Z", kind, current: true });
  const suggested = (text: string) => ({ projectId: "p", text });

  it("puts the recommended start first, then real dates, then suggestions, at most five, each said once", () => {
    const list = briefList({
      recommendedAction: "Take the quiz",
      hard: [hard("Rehearsal call", "meeting"), hard("Take the quiz"), hard("Submit Essay 2")],
      suggested: [suggested("Time the demo"), suggested("Tidy slides"), suggested("Email the venue")],
    });
    expect(list.map((i) => [i.text, i.kind])).toEqual([
      ["Take the quiz", "deadline"],
      ["Rehearsal call", "meeting"],
      ["Submit Essay 2", "deadline"],
      ["Time the demo", "suggested"],
      ["Tidy slides", "suggested"],
    ]);
    expect(list[0]!.recommended).toBe(true);
    expect(list.slice(1).some((i) => i.recommended)).toBe(false);
  });

  it("is empty for an empty brief", () => {
    expect(briefList({ hard: [], suggested: [] })).toEqual([]);
  });
});
