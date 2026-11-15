// The closing recap shown on "Stop for now" (and sent to his linked WhatsApp on the stop event).
// Read-only: built from receipts, commitments, nudge answers and drafts the caller owns.
import { ConvexError, v } from "convex/values";
import {
  assertTimezone,
  commitmentKey,
} from "../packages/domain/src/attention";
import {
  closingRecap,
  type ClosingRecap,
  type RecapInput,
} from "../packages/domain/src/recap";
import type { ProjectId } from "../packages/domain/src/types";
import { query, type QueryCtx } from "./_generated/server";
import { requireOwnerId } from "./lib/auth";

const list = v.object({ items: v.array(v.string()), more: v.number() });

export const getClosingRecap = query({
  args: { timezone: v.string() },
  returns: v.object({ done: list, parked: list, left: list }),
  handler: async (ctx, { timezone }): Promise<ClosingRecap> => {
    const ownerId = await requireOwnerId(ctx);
    try {
      assertTimezone(timezone);
    } catch {
      throw new ConvexError("Unknown timezone");
    }
    return buildRecap(ctx, ownerId, timezone);
  },
});

/** Today's recap for one owner: item titles only. Also sent to his linked WhatsApp on "Stop for now". */
export async function buildRecap(ctx: Pick<QueryCtx, "db">, ownerId: string, timezone: string): Promise<ClosingRecap> {
    const input: RecapInput = {
      nowMs: Date.now(),
      timezone,
      actions: [],
      commitments: [],
      parked: [],
      unsentDrafts: [],
    };
    const nudges = await ctx.db
      .query("nudges")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId))
      .collect();
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
    for (const project of projects) {
      // Items are named by the prepared work's title (or the project's name), never by draft text or recipients.
      const title =
        (
          await ctx.db
            .query("preparedWork")
            .withIndex("by_owner_project", (q) =>
              q.eq("ownerId", ownerId).eq("projectId", project._id),
            )
            .unique()
        )?.work?.title ?? project.name;
      const actions = await ctx.db
        .query("actions")
        .withIndex("by_owner_project", (q) =>
          q.eq("ownerId", ownerId).eq("projectId", project._id),
        )
        .collect();
      for (const a of actions) {
        if (a.state === "succeeded" && a.verifiedAt !== undefined)
          input.actions.push({ kind: a.kind, title, verifiedAt: a.verifiedAt });
      }
      const artifact = await ctx.db
        .query("artifacts")
        .withIndex("by_owner_project", (q) =>
          q.eq("ownerId", ownerId).eq("projectId", project._id),
        )
        .unique();
      if (
        artifact !== null &&
        !actions.some(
          (a) => a.artifactId === artifact._id && a.state === "succeeded",
        )
      )
        input.unsentDrafts.push(title);
      const commitments = await ctx.db
        .query("commitments")
        .withIndex("by_owner_project", (q) =>
          q.eq("ownerId", ownerId).eq("projectId", project._id),
        )
        .collect();
      for (const c of commitments) {
        input.commitments.push({
          text: c.text,
          ownership: c.ownership,
          state: c.state,
          ...(c.dueAt === undefined ? {} : { dueAt: c.dueAt }),
          ...(c.doneAt === undefined ? {} : { doneAt: c.doneAt }),
        });
      }
      for (const nudge of nudges) {
        if (nudge.projectId !== project._id || nudge.parkedAt === undefined)
          continue;
        const c = commitments.find(
          (row) =>
            row.ownership === "user" &&
            commitmentKey({
              projectId: row.projectId as ProjectId,
              text: row.text,
            }) === nudge.key,
        );
        if (c?.state === "open")
          input.parked.push({ text: c.text, at: nudge.parkedAt });
      }
    }
    // Lines he parked in a brain dump, at the time he said them (with or without a project).
    const captured = await ctx.db
      .query("captureItems")
      .withIndex("by_owner_capture", (q) => q.eq("ownerId", ownerId))
      .collect();
    for (const line of captured) {
      if (line.kind === "parked") input.parked.push({ text: line.text, at: line.createdAt });
    }
    return closingRecap(input);
}
