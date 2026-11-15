// A calendar feed (iCalendar, RFC 5545) read as plain events, and the rule for which Canvas feed
// links may be fetched. Pure, no dependency, never throws: a bad event is skipped and counted.
// shortcut: no RRULE/EXDATE expansion and no time zones other than UTC and all-day dates (Canvas
// feeds use neither); move to a full iCalendar library before reading feeds that do.

export type CalendarEvent = {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  /** ISO-8601 UTC instant, or YYYY-MM-DD when allDay. */
  start: string;
  end?: string;
  allDay: boolean;
};

type Property = { params: string[]; value: string };

/** null when the text is not a calendar at all; otherwise the readable events and how many were not. */
export function readCalendar(text: string): { events: CalendarEvent[]; skipped: number } | null {
  // Unfold: a line break followed by one space or tab continues the previous line.
  const lines = text.replace(/^﻿/, "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  if (lines[0]?.trim().toUpperCase() !== "BEGIN:VCALENDAR") return null;
  const events: CalendarEvent[] = [];
  let skipped = 0;
  let event: Map<string, Property> | null = null;
  let nested = 0; // components inside the current event (VALARM): their properties are not the event's
  for (const line of lines) {
    const property = contentLine(line);
    if (property === null) continue;
    const { name, params, value } = property;
    const component = value.trim().toUpperCase();
    if (name === "BEGIN" && component === "VEVENT") {
      if (event !== null) skipped++; // the previous one never ended
      event = new Map();
      nested = 0;
    } else if (event === null) {
      continue;
    } else if (name === "BEGIN") {
      nested++;
    } else if (name === "END" && component === "VEVENT") {
      const read = toEvent(event);
      if (read === null) skipped++;
      else events.push(read);
      event = null;
    } else if (name === "END") {
      nested = Math.max(0, nested - 1);
    } else if (nested === 0 && !event.has(name)) {
      event.set(name, { params, value });
    }
  }
  if (event !== null) skipped++;
  return { events, skipped };
}

function contentLine(line: string): { name: string; params: string[]; value: string } | null {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) {
      const [name = "", ...params] = line.slice(0, i).split(";");
      return { name: name.trim().toUpperCase(), params: params.map((p) => p.toUpperCase()), value: line.slice(i + 1) };
    }
  }
  return null;
}

function toEvent(props: Map<string, Property>): CalendarEvent | null {
  const uid = props.get("UID")?.value.trim() ?? "";
  const start = dateOf(props.get("DTSTART"));
  const endProp = props.get("DTEND");
  const end = endProp === undefined ? undefined : dateOf(endProp);
  if (uid === "" || start === null || end === null) return null;
  const text = (key: string) => {
    const value = props.get(key)?.value;
    return value === undefined || value.trim() === "" ? undefined : unescape(value).trim();
  };
  const [description, location, url] = [text("DESCRIPTION"), text("LOCATION"), props.get("URL")?.value.trim()];
  return {
    uid,
    summary: text("SUMMARY") ?? "Untitled",
    ...(description === undefined ? {} : { description }),
    ...(location === undefined ? {} : { location }),
    ...(url === undefined || url === "" ? {} : { url }),
    start: start.value,
    ...(end === undefined ? {} : { end: end.value }),
    allDay: start.allDay,
  };
}

const unescape = (value: string) => value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

/** `20261120T045900Z` (UTC) or, with VALUE=DATE (Canvas repeats the parameter), `20261120`. */
function dateOf(property: Property | undefined): { value: string; allDay: boolean } | null {
  if (property === undefined) return null;
  const allDay = property.params.includes("VALUE=DATE");
  const match = (allDay ? /^(\d{4})(\d\d)(\d\d)$/ : /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/).exec(property.value.trim());
  if (match === null) return null;
  const [y, mo, d, h = 0, mi = 0, s = 0] = match.slice(1).map(Number) as number[];
  const date = new Date(Date.UTC(y!, mo! - 1, d!, h, mi, s));
  if (date.getUTCMonth() !== mo! - 1 || date.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  const iso = date.toISOString();
  return { value: allDay ? iso.slice(0, 10) : iso, allDay };
}

/**
 * The feed link as a URL when it may be fetched, else null: https, an Instructure host, the
 * calendar-feed path, no credentials, port or query. The link itself is the secret.
 * shortcut: only instructure.com hosts; schools on their own Canvas domain need an explicit allowlist.
 */
export function canvasFeedUrl(text: string): URL | null {
  const trimmed = text.trim();
  if (!URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  const instructure = url.hostname === "instructure.com" || url.hostname.endsWith(".instructure.com");
  if (url.protocol !== "https:" || !instructure || url.username !== "" || url.password !== "" || url.port !== "" || url.search !== "") return null;
  if (!/^\/feeds\/calendars\/[A-Za-z0-9_-]+\.ics$/.test(url.pathname)) return null;
  url.hash = "";
  return url;
}
