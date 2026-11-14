import { ConvexError, v, type Infer } from "convex/values";
import { z } from "zod";
import { decideIntake } from "../packages/domain/src/evidence";
import { EvidenceSchema, SourceGrantSchema, type SourceGrant } from "../packages/domain/src/types";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { requireOwnerId } from "./lib/auth";
import { evidenceFields, grantInputFields } from "./schema";

const GrantInputSchema = SourceGrantSchema.omit({ ownerId: true });
// Non-strict copy drops Convex system fields (_id, _creationTime) when reading a grant row.
export const StoredGrantSchema = z.object(SourceGrantSchema.shape);

/** Create or change the caller's grant for one source. A revoke is a new version, state "revoked". */
export const setGrant = mutation({
  args: grantInputFields,
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const parsed = GrantInputSchema.safeParse(args);
    if (!parsed.success) {
      throw new ConvexError(`Invalid grant: ${z.prettifyError(parsed.error)}`);
    }
    const existing = await ctx.db
      .query("grants")
      .withIndex("by_source", (q) => q.eq("id", args.id))
      .unique();
    if (existing === null) {
      await ctx.db.insert("grants", { ...args, ownerId });
      return null;
    }
    if (existing.ownerId !== ownerId) {
      throw new ConvexError("Source is not available");
    }
    if (args.version <= existing.version) {
      throw new ConvexError(`Grant version must be greater than ${existing.version}`);
    }
    await ctx.db.replace(existing._id, { ...args, ownerId });
    return null;
  },
});

export const intakeResult = v.union(v.literal("accepted"), v.literal("duplicate"), v.literal("denied"));

/**
 * The one intake path: decide against the STORED grant, then store the revision. `grantAllows`
 * narrows which stored grants a caller may write under (the local hand-off accepts only local kinds).
 */
export async function intakeRecord(
  ctx: MutationCtx,
  { ownerId, sourceId, record }: { ownerId: string; sourceId: string; record: Infer<typeof evidenceRecord> },
  grantAllows: (grant: SourceGrant) => boolean = () => true,
): Promise<Infer<typeof intakeResult>> {
  const parsed = EvidenceSchema.safeParse(record);
  if (!parsed.success || record.ownerId !== ownerId || record.sourceId !== sourceId) {
    return "denied";
  }
  const grantRow = await ctx.db
    .query("grants")
    .withIndex("by_source", (q) => q.eq("id", sourceId))
    .unique();
  const grant = grantRow === null ? null : StoredGrantSchema.parse(grantRow);
  const stored = await ctx.db
    .query("evidence")
    .withIndex("by_item", (q) =>
      q.eq("ownerId", ownerId).eq("sourceId", sourceId).eq("externalId", record.externalId),
    )
    .collect();

  const decision = decideIntake(grant !== null && grantAllows(grant) ? grant : null, parsed.data, stored);
  if (decision.result !== "accepted") return decision.result;

  if (decision.becomesCurrent) {
    for (const row of stored.filter((revision) => revision.isCurrent)) {
      await ctx.db.patch(row._id, { isCurrent: false });
    }
  }
  await ctx.db.insert("evidence", { ...record, isCurrent: decision.becomesCurrent });
  return "accepted";
}

const evidenceRecord = v.object(evidenceFields);

/**
 * Store one source record. Internal only: provider webhooks call it after mapping the
 * delivery to an owner and source. The grant is always the stored one, never the caller's.
 */
export const ingest = internalMutation({
  args: { ownerId: v.string(), sourceId: v.string(), record: evidenceRecord },
  returns: intakeResult,
  handler: (ctx, args) => intakeRecord(ctx, args),
});

/** The caller's current evidence revisions that name this project. */
export const listCurrentEvidence = query({
  args: { projectId: v.string() },
  returns: v.array(v.object(evidenceFields)),
  handler: async (ctx, { projectId }) => {
    const ownerId = await requireOwnerId(ctx);
    const rows = await ctx.db
      .query("evidence")
      .withIndex("by_owner_current", (q) => q.eq("ownerId", ownerId).eq("isCurrent", true))
      .collect();
    return rows.filter((row) => row.projectIds.includes(projectId)).map(toEvidence);
  },
});

/** A stored row as an Evidence-shaped value: system fields and isCurrent removed. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructuring to omit fields
function toEvidence({ _id, _creationTime, isCurrent, ...evidence }: Doc<"evidence">) {
  return evidence;
}
