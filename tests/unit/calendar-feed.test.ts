// The Canvas calendar feed: the iCalendar reader and the feed-link rule. Illustrative fixture only,
// written to mirror the measured shape of a real feed (CRLF, folded lines, both date forms).
import { describe, expect, test } from "vitest";
import { canvasFeedUrl, readCalendar } from "../../packages/domain/src/calendarFeed";

const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Illustrative//Canvas//EN",
  "X-WR-CALNAME:Alice Illustrative Calendar (Canvas)",
  "BEGIN:VEVENT",
  "DTEND:20261120T045900Z",
  "DTSTAMP:20261114T120000Z",
  "DTSTART:20261120T045900Z",
  "CLASS:PUBLIC",
  "DESCRIPTION:Write two pages\\, double spaced.\\nCite the reading\\; use \\\\APA\\\\.",
  "SEQUENCE:0",
  // Folded mid-word, the way the real feed folds long values.
  "SUMMARY:Essay 2: Reading resp",
  " onse [ILL 101]",
  "UID:event-assignment-501",
  "URL;VALUE=URI:https://illustrative.instructure.com/calendar?include_contexts=course_42&mon",
  "\tth=11#assignment_501",
  "X-ALT-DESC;FMTTYPE=text/html:<p>Write two pages</p>",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTAMP:20261114T120000Z",
  "DTSTART;VALUE=DATE;VALUE=DATE:20261123",
  "CLASS:PUBLIC",
  "LOCATION:Room 12",
  "SEQUENCE:0",
  "SUMMARY:Field trip",
  "UID:event-calendar-event-77",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:not-a-date",
  "SUMMARY:Broken",
  "UID:event-assignment-999",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20261125T150000Z",
  "SUMMARY:No uid",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("readCalendar", () => {
  test("reads timed and all-day events, unfolds, unescapes, ignores the HTML description", () => {
    const calendar = readCalendar(FEED);
    expect(calendar).not.toBeNull();
    expect(calendar!.events).toEqual([
      {
        uid: "event-assignment-501",
        summary: "Essay 2: Reading response [ILL 101]",
        description: "Write two pages, double spaced.\nCite the reading; use \\APA\\.",
        url: "https://illustrative.instructure.com/calendar?include_contexts=course_42&month=11#assignment_501",
        start: "2026-11-20T04:59:00.000Z",
        end: "2026-11-20T04:59:00.000Z",
        allDay: false,
      },
      { uid: "event-calendar-event-77", summary: "Field trip", location: "Room 12", start: "2026-11-23", allDay: true },
    ]);
    expect(calendar!.skipped).toBe(2); // the bad date and the event with no UID
  });

  test("never throws on malformed input", () => {
    const broken = [
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261301T000000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:y",
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nno colon here\nUID:z\nDTSTART;TZID=America/New_York:20261120T235900\nEND:VEVENT\nEND:VCALENDAR",
      "BEGIN:VCALENDAR\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nBEGIN:VEVENT\r\nEND:VCALENDAR",
    ];
    for (const text of broken) expect(() => readCalendar(text)).not.toThrow();
    expect(readCalendar(broken[0]!)).toEqual({ events: [], skipped: 2 }); // month 13; never closed
    expect(readCalendar(broken[1]!)).toEqual({ events: [], skipped: 1 }); // a time zone other than UTC
  });

  test("anything that is not a calendar is null", () => {
    expect(readCalendar("<!doctype html><title>Log in</title>")).toBeNull();
    expect(readCalendar("")).toBeNull();
  });
});

describe("canvasFeedUrl", () => {
  const good = "https://illustrative.instructure.com/feeds/calendars/user_AbC123xyz.ics";
  test("accepts a Canvas calendar feed link", () => {
    expect(canvasFeedUrl(good)?.toString()).toBe(good);
    expect(canvasFeedUrl(`  ${good}  `)?.toString()).toBe(good);
    expect(canvasFeedUrl("https://instructure.com/feeds/calendars/user_AbC.ics")).not.toBeNull();
  });
  test.each([
    ["http", "http://illustrative.instructure.com/feeds/calendars/user_AbC.ics"],
    ["another host", "https://canvas.illustrative.edu/feeds/calendars/user_AbC.ics"],
    ["look-alike host", "https://instructure.com.evil.example/feeds/calendars/user_AbC.ics"],
    ["look-alike suffix", "https://evilinstructure.com/feeds/calendars/user_AbC.ics"],
    ["not a calendar feed", "https://illustrative.instructure.com/courses/42/assignments/501"],
    ["not .ics", "https://illustrative.instructure.com/feeds/calendars/user_AbC.json"],
    ["traversal", "https://illustrative.instructure.com/feeds/calendars/../../api/v1/users/self.ics"],
    ["credentials", "https://alice:secret@illustrative.instructure.com/feeds/calendars/user_AbC.ics"],
    ["port", "https://illustrative.instructure.com:8443/feeds/calendars/user_AbC.ics"],
    ["query", "https://illustrative.instructure.com/feeds/calendars/user_AbC.ics?x=1"],
    ["not a URL", "user_AbC.ics"],
  ])("rejects %s", (_name, link) => {
    expect(canvasFeedUrl(link)).toBeNull();
  });
});
