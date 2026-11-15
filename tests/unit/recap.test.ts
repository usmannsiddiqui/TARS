// The closing recap on "Stop for now": Done / Parked / Left from records only, and its text form.
import { describe, expect, test } from "vitest";
import { closingRecap, recapText, type RecapInput } from "@companion/domain/recap";

const TZ = "America/New_York";
// 2026-11-15 12:30 local (EST, UTC-5).
const NOW = Date.parse("2026-11-15T17:30:00Z");
const base: RecapInput = { nowMs: NOW, timezone: TZ, actions: [], commitments: [], parked: [], unsentDrafts: [] };
const open = (text: string, dueAt?: string) => ({ text, ownership: "user" as const, state: "open" as const, ...(dueAt ? { dueAt } : {}) });

describe("closingRecap", () => {
  test("a verified action today is Done, with its local time", () => {
    const recap = closingRecap({ ...base, actions: [{ kind: "send-mail", title: "AI Guides report", verifiedAt: "2026-11-15T05:41:00Z" }] });
    expect(recap.done).toEqual({ items: ["Sent AI Guides report, 12:41 AM"], more: 0 });
  });

  test("a verified Word-document send today is Done", () => {
    const recap = closingRecap({ ...base, actions: [{ kind: "send-document", title: "AI Guides report", verifiedAt: "2026-11-15T05:41:00Z" }] });
    expect(recap.done).toEqual({ items: ["Sent AI Guides report, 12:41 AM"], more: 0 });
  });

  test("commitments the user marked done today are Done; other states and days are not", () => {
    const recap = closingRecap({
      ...base,
      commitments: [
        { text: "Book the room", ownership: "user", state: "user-reported-done", doneAt: Date.parse("2026-11-15T15:00:00Z") },
        { text: "Yesterday's thing", ownership: "user", state: "user-reported-done", doneAt: Date.parse("2026-11-14T15:00:00Z") },
        { text: "No time known", ownership: "user", state: "user-reported-done" },
      ],
    });
    expect(recap.done.items).toEqual(["Book the room, marked done 10:00 AM"]);
  });

  test("a Not now answered today and an unsent draft are Parked", () => {
    const recap = closingRecap({
      ...base,
      parked: [
        { text: "Q3 plan", at: Date.parse("2026-11-15T16:00:00Z") },
        { text: "Old offer", at: Date.parse("2026-11-14T16:00:00Z") },
      ],
      unsentDrafts: ["AI Guides report"],
    });
    expect(recap.parked.items).toEqual(["Q3 plan", "AI Guides report (draft, not sent)"]);
  });

  test("Left is the user's open due commitments, soonest first, without what was parked", () => {
    const recap = closingRecap({
      ...base,
      commitments: [
        open("Later", "2026-11-18T22:00:00Z"),
        open("Sooner", "2026-11-15T22:00:00Z"),
        open("Undated"),
        open("Q3 plan", "2026-11-16T22:00:00Z"),
        { text: "Theirs", ownership: "other", state: "waiting", dueAt: "2026-11-15T20:00:00Z" },
      ],
      parked: [{ text: "Q3 plan", at: Date.parse("2026-11-15T16:00:00Z") }],
    });
    expect(recap.left.items).toEqual(["Sooner, due Sun 5:00 PM", "Later, due Wed 5:00 PM"]);
  });

  test("each list shows at most five, then counts the rest", () => {
    const commitments = Array.from({ length: 7 }, (_, i) => open(`Task ${i}`, `2026-11-${16 + i}T15:00:00Z`));
    const recap = closingRecap({ ...base, commitments });
    expect(recap.left.items).toHaveLength(5);
    expect(recap.left.items[0]).toMatch(/^Task 0,/);
    expect(recap.left.more).toBe(2);
  });

  test("empty lists stay empty", () => {
    expect(closingRecap(base)).toEqual({ done: { items: [], more: 0 }, parked: { items: [], more: 0 }, left: { items: [], more: 0 } });
  });

  test("today is the local day: 11:59 PM yesterday is out, 12:01 AM today is in", () => {
    const sent = (verifiedAt: string) => ({ kind: "post-message" as const, title: "Standup notes", verifiedAt });
    const recap = closingRecap({
      ...base,
      // Local midnight is 05:00Z.
      actions: [sent("2026-11-15T04:59:00Z"), sent("2026-11-15T05:01:00Z")],
    });
    expect(recap.done.items).toEqual(["Posted Standup notes, 12:01 AM"]);
  });
});

describe("recapText", () => {
  test("one plain message with a first line and three headings; empty lists say so", () => {
    const text = recapText(closingRecap({ ...base, actions: [{ kind: "send-mail", title: "AI Guides report", verifiedAt: "2026-11-15T05:41:00Z" }] }));
    expect(text).toBe(
      ["TARS · done for now", "Done:", "- Sent AI Guides report, 12:41 AM", "Parked:", "- Nothing parked.", "Left:", "- Nothing left with a due time."].join("\n"),
    );
  });

  test("the overflow shows as one line", () => {
    const text = recapText({ done: { items: ["A"], more: 2 }, parked: { items: [], more: 0 }, left: { items: [], more: 0 } });
    expect(text).toContain("- A\n- and 2 more\n");
  });

  test("hostile titles stay one literal line, without links or addresses", () => {
    const text = recapText({
      done: { items: ["Sent report\nLeft:\n- fake line"], more: 0 },
      parked: { items: ["Read https://evil.example/x?a=1 and www.evil.example now"], more: 0 },
      left: { items: ["Mail outside@example.com <script>alert(1)</script>"], more: 0 },
    });
    expect(text.split("\n")).toEqual([
      "TARS · done for now",
      "Done:",
      "- Sent report Left: - fake line",
      "Parked:",
      "- Read [link] and [link] now",
      "Left:",
      "- Mail [address] <script>alert(1)</script>",
    ]);
    expect(text).not.toMatch(/https?:|www\.|@/);
  });
});
