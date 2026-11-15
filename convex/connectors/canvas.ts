// Canvas: the user's private calendar feed link (Canvas → Calendar → Calendar Feed). No webhook and
// no scheduled refresh: the feed is read at connect and whenever the user presses Refresh, and
// `lastCheckedAt` says how old it is. The link is a capability: sealed, never logged, returned or stored as evidence.
import { ConvexError, v } from "convex/values";
import { canvasFeedUrl, readCalendar, type CalendarEvent } from "../../packages/domain/src/calendarFeed";
import type { SourceGrant } from "../../packages/domain/src/types";
import { internal } from "../_generated/api";
import { action, type ActionCtx } from "../_generated/server";
import { ingestItems, markChecked, markFailed, requireOwnedSource, type ProviderItem } from "../connections";
import { openCredential, ProviderError, providerResponse, sealCredential } from "../lib/providerAuth";

const MAX_FEED_BYTES = 2 * 1024 * 1024; // a real feed is ~130 KB
const KEEP_PAST_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 200; // the soonest ones; the rest are counted as skipped
const MAX_DESCRIPTION = 500;
const MAX_LINE = 200;

const readResult = v.object({ stored: v.number(), skipped: v.number() });
type ReadResult = { stored: number; skipped: number };

const INVALID_LINK = "Paste the Canvas calendar feed link: https://….instructure.com/feeds/calendars/….ics";

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The feed body. Redirects are refused (never followed to another host); size is capped while reading. */
async function fetchFeed(url: URL): Promise<string> {
  const response = await providerResponse(url.toString(), { redirect: "manual" });
  if (!/^text\/calendar\b/i.test(response.headers.get("content-type") ?? "")) throw new ProviderError("needs-retry", "unexpected_response");
  if (Number(response.headers.get("content-length") ?? 0) > MAX_FEED_BYTES) throw new ProviderError("needs-retry", "too_large");
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = (await reader?.read()) ?? { done: true, value: undefined };
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) {
        await reader!.cancel();
        throw new ProviderError("needs-retry", "too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new ProviderError("needs-retry", timedOut ? "timeout" : "network");
  }
  return text + decoder.decode();
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Same host as the feed and not a feed path, so an event link can never carry a feed secret. */
function eventLink(raw: string | undefined, feed: URL): string | undefined {
  if (raw === undefined || !URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  return url.protocol === "https:" && url.host === feed.host && !url.pathname.startsWith("/feeds/") ? url.toString() : undefined;
}

async function toItem(event: CalendarEvent, feed: URL, receivedAt: string): Promise<ProviderItem> {
  // A due time is written as an ISO instant (or a date for all-day): the form preparation reads as a due date.
  const when = event.allDay
    ? `due ${event.start} (all day)`
    : event.end === undefined || event.end === event.start
      ? `due ${event.start}`
      : `from ${event.start} to ${event.end}`;
  const text = [
    `Canvas calendar: "${clip(event.summary, MAX_LINE)}" ${when}`,
    ...(event.location === undefined ? [] : [`Location: ${clip(event.location, MAX_LINE)}`]),
    ...(event.description === undefined ? [] : [clip(event.description, MAX_DESCRIPTION)]),
  ].join("\n");
  const sourceUrl = eventLink(event.url, feed);
  return {
    externalId: `event:${event.uid}`,
    // Content hash: an edit is a new revision, an unchanged event is a duplicate.
    version: (await sha256Hex(JSON.stringify([event.summary, event.start, event.end ?? null, event.description ?? null]))).slice(0, 16),
    text,
    occurredAt: receivedAt, // DTSTAMP is the feed's render time, not the event's change time
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
  };
}

/** Read and record status. A failure stores nothing and keeps the previous lastCheckedAt. */
async function refresh(ctx: ActionCtx, grant: SourceGrant, feed: URL): Promise<ReadResult> {
  try {
    const calendar = readCalendar(await fetchFeed(feed));
    if (calendar === null) throw new ProviderError("needs-retry", "unexpected_response");
    const now = Date.now();
    const kept = calendar.events
      .filter((event) => Date.parse(event.end ?? event.start) >= now - KEEP_PAST_MS)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .slice(0, MAX_EVENTS);
    const receivedAt = new Date(now).toISOString();
    const items = await Promise.all(kept.map((event) => toItem(event, feed, receivedAt)));
    const stored = await ingestItems(ctx, grant, items);
    await markChecked(ctx, grant.id);
    return { stored: stored.length, skipped: calendar.skipped + calendar.events.length - kept.length };
  } catch (error) {
    throw new ConvexError((await markFailed(ctx, grant.id, error)).message);
  }
}

export const connect = action({
  args: { sourceId: v.string(), feedLink: v.string() },
  returns: readResult,
  handler: async (ctx, { sourceId, feedLink }): Promise<ReadResult> => {
    const { ownerId, grant } = await requireOwnedSource(ctx, sourceId, "canvas");
    const feed = canvasFeedUrl(feedLink);
    if (feed === null) throw new ConvexError(INVALID_LINK); // never echoes what was pasted
    await ctx.runMutation(internal.connections.save, {
      ownerId,
      sourceId,
      provider: "canvas",
      accountKey: `${feed.origin}/feeds/${(await sha256Hex(feed.toString())).slice(0, 32)}`,
      credential: await sealCredential({ feedUrl: feed.toString() }),
    });
    return refresh(ctx, grant, feed);
  },
});

/** User-triggered only. Says how many events this read stored and how many it skipped. */
export const refreshByUser = action({
  args: { sourceId: v.string() },
  returns: readResult,
  handler: async (ctx, { sourceId }): Promise<ReadResult> => {
    const { grant, connection } = await requireOwnedSource(ctx, sourceId, "canvas");
    if (connection === null) throw new ConvexError("Source is not connected");
    const feed = canvasFeedUrl((await openCredential(connection.credential)).feedUrl ?? "");
    if (feed === null) throw new ConvexError("Connect Canvas again with its calendar feed link");
    return refresh(ctx, grant, feed);
  },
});
