// Canvas: base URL + owner's user token. No webhook and no scheduled refresh: deadlines are read
// at connect and whenever the user presses Refresh, and `lastCheckedAt` says how old they are.
import { ConvexError, v } from "convex/values";
import { z } from "zod";
import type { Evidence, SourceGrant } from "../../packages/domain/src/types";
import { internal } from "../_generated/api";
import { action, type ActionCtx } from "../_generated/server";
import { ingestItems, markChecked, markFailed, requireOwnedSource, type ProviderItem } from "../connections";
import { openCredential, ProviderError, providerJson, sealCredential } from "../lib/providerAuth";
import { evidenceFields } from "../schema";

const PLANNER_PAGE_SIZE = 50; // one page of upcoming items for the selected courses
const IsoWithOffset = z.iso.datetime({ offset: true });

type PlannerItem = {
  plannable_id?: number | string;
  plannable_type?: string;
  plannable_date?: string;
  course_id?: number | string;
  html_url?: string;
  plannable?: { title?: string; due_at?: string | null; updated_at?: string };
};

function canvasGet(baseUrl: string, path: string, token: string): Promise<unknown> {
  return providerJson(new URL(path, baseUrl).toString(), { headers: { authorization: `Bearer ${token}` } });
}

/** Upcoming planner items with a real due date in the selected courses (grant selectors = course ids). */
async function readDeadlines(ctx: ActionCtx, grant: SourceGrant, baseUrl: string, token: string): Promise<Evidence[]> {
  const params = new URLSearchParams({ start_date: new Date().toISOString(), per_page: String(PLANNER_PAGE_SIZE) });
  for (const course of grant.selectors) params.append("context_codes[]", `course_${course}`);
  const body = grant.selectors.length === 0 ? [] : await canvasGet(baseUrl, `/api/v1/planner/items?${params}`, token);
  if (!Array.isArray(body)) throw new ProviderError("needs-retry", "unexpected_response");

  const receivedAt = new Date().toISOString();
  const items: ProviderItem[] = [];
  for (const entry of body as PlannerItem[]) {
    const due = entry.plannable?.due_at ?? entry.plannable_date;
    if (!grant.selectors.includes(String(entry.course_id))) continue;
    if (due == null || !IsoWithOffset.safeParse(due).success) continue; // not a hard deadline
    const updated = entry.plannable?.updated_at;
    const hasUpdated = updated !== undefined && IsoWithOffset.safeParse(updated).success;
    items.push({
      externalId: `${entry.plannable_type}:${entry.plannable_id}`,
      version: `${due}@${updated ?? ""}`,
      // Due date kept exactly as Canvas sent it, offset included.
      text: `${entry.plannable_type} "${entry.plannable?.title ?? "Untitled"}" due ${due} (course ${entry.course_id})`,
      occurredAt: hasUpdated ? new Date(updated).toISOString() : receivedAt,
      ...(entry.html_url === undefined ? {} : { sourceUrl: new URL(entry.html_url, baseUrl).toString() }),
    });
  }
  return ingestItems(ctx, grant, items);
}

/** Read and record status. A failure keeps stored deadlines and the previous lastCheckedAt. */
async function refresh(ctx: ActionCtx, grant: SourceGrant, baseUrl: string, token: string): Promise<Evidence[]> {
  try {
    const records = await readDeadlines(ctx, grant, baseUrl, token);
    await markChecked(ctx, grant.id);
    return records;
  } catch (error) {
    throw new ConvexError((await markFailed(ctx, grant.id, error)).message);
  }
}

export const connect = action({
  args: { sourceId: v.string(), baseUrl: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, { sourceId, baseUrl, token }): Promise<null> => {
    const { ownerId, grant } = await requireOwnedSource(ctx, sourceId, "canvas");
    const url = URL.canParse(baseUrl) ? new URL(baseUrl) : null;
    if (url === null || url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      throw new ConvexError("Canvas base URL must be an https URL");
    }
    let userId: string;
    try {
      userId = String(((await canvasGet(url.origin, "/api/v1/users/self", token)) as { id?: unknown }).id);
    } catch (error) {
      if (error instanceof ProviderError) throw new ConvexError(error.message);
      throw error;
    }
    await ctx.runMutation(internal.connections.save, {
      ownerId,
      sourceId,
      provider: "canvas",
      accountKey: `${url.origin}/users/${userId}`,
      credential: await sealCredential({ baseUrl: url.origin, token }),
    });
    await refresh(ctx, grant, url.origin, token);
    return null;
  },
});

/** User-triggered only. Returns the deadlines this refresh read and holds as stored evidence. */
export const refreshByUser = action({
  args: { sourceId: v.string() },
  returns: v.array(v.object(evidenceFields)),
  handler: async (ctx, { sourceId }): Promise<Evidence[]> => {
    const { grant, connection } = await requireOwnedSource(ctx, sourceId, "canvas");
    if (connection === null) throw new ConvexError("Source is not connected");
    const { baseUrl, token } = await openCredential(connection.credential);
    return refresh(ctx, grant, baseUrl!, token!);
  },
});
