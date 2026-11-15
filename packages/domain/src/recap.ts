// The closing recap on "Stop for now": what is done, parked and left, from records only. Pure: no I/O,
// no clock, no model. Plain wording: no counts of misses, no streaks, no scores.
import { localDate } from "./attention";
import type { Commitment } from "./types";

export type RecapInput = {
  nowMs: number;
  timezone: string;
  /** Actions whose receipt was verified (state succeeded); `title` names the item, never its content. */
  actions: { kind: "send-mail" | "post-message" | "update-note"; title: string; verifiedAt: string }[];
  /** `doneAt`: when the user marked it done, if recorded. */
  commitments: (Pick<Commitment, "text" | "ownership" | "state" | "dueAt"> & { doneAt?: number })[];
  /** Nudge offers the user answered "Not now", with when. */
  parked: { text: string; at: number }[];
  /** Titles of drafts started but not sent. */
  unsentDrafts: string[];
};
export type RecapList = { items: string[]; more: number };
export type ClosingRecap = { done: RecapList; parked: RecapList; left: RecapList };

const MAX_ITEMS = 5;
const VERB = { "send-mail": "Sent", "post-message": "Posted", "update-note": "Updated" } as const;

const bounded = (items: string[]): RecapList => ({ items: items.slice(0, MAX_ITEMS), more: Math.max(0, items.length - MAX_ITEMS) });

export function closingRecap(input: RecapInput): ClosingRecap {
  const today = localDate(input.nowMs, input.timezone);
  const isToday = (ms: number) => localDate(ms, input.timezone) === today;
  const time = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: input.timezone, hour: "numeric", minute: "2-digit" }).format(ms);
  const due = (ms: number) =>
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(ms);

  const done = [
    ...input.actions.map((a) => ({ at: Date.parse(a.verifiedAt), text: `${VERB[a.kind]} ${a.title},` })),
    ...input.commitments.flatMap((c) =>
      c.state === "user-reported-done" && c.doneAt !== undefined ? [{ at: c.doneAt, text: `${c.text}, marked done` }] : [],
    ),
  ]
    .filter((d) => isToday(d.at))
    .sort((a, b) => a.at - b.at)
    .map((d) => `${d.text} ${time(d.at)}`);

  const parkedToday = input.parked.filter((p) => isToday(p.at)).sort((a, b) => a.at - b.at);
  const parkedTexts = new Set(parkedToday.map((p) => p.text));
  const parked = [...parkedToday.map((p) => p.text), ...input.unsentDrafts.map((title) => `${title} (draft, not sent)`)];

  const left = input.commitments
    .filter((c): c is typeof c & { dueAt: string } => c.ownership === "user" && c.state === "open" && c.dueAt !== undefined && !parkedTexts.has(c.text))
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    .map((c) => `${c.text}, due ${due(Date.parse(c.dueAt))}`);

  return { done: bounded(done), parked: bounded(parked), left: bounded(left) };
}

/** What an empty list says, on screen and in the text. */
export const RECAP_EMPTY = { done: "Nothing recorded yet.", parked: "Nothing parked.", left: "Nothing left with a due time." } as const;
const MAX_LINE = 90;

/** One item as one literal line: no line breaks, links or email addresses. */
function line(text: string): string {
  const clean = text
    .replace(/\s+/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]")
    .replace(/\S+@\S+/g, "[address]")
    .trim();
  return clean.length > MAX_LINE ? `${clean.slice(0, MAX_LINE - 1)}…` : clean;
}

/** The recap as one plain-text message for the user's own phone, readable on a lock screen. */
export function recapText(recap: ClosingRecap): string {
  const section = (heading: string, list: RecapList, empty: string) => [
    `${heading}:`,
    ...(list.items.length === 0 ? [`- ${empty}`] : list.items.map((item) => `- ${line(item)}`)),
    ...(list.more > 0 ? [`- and ${list.more} more`] : []),
  ];
  return [
    "TARS · done for now",
    ...section("Done", recap.done, RECAP_EMPTY.done),
    ...section("Parked", recap.parked, RECAP_EMPTY.parked),
    ...section("Left", recap.left, RECAP_EMPTY.left),
  ].join("\n");
}
