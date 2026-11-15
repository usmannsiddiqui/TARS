import { ConvexError, v, type Infer } from "convex/values";
import { z } from "zod";
import { decideIntake } from "../packages/domain/src/evidence";
import { EvidenceSchema, SourceGrantSchema, type SourceGrant } from "../packages/domain/src/types";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { requireOwnerId, verifiedUser } from "./lib/auth";
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
    await saveProfile(ctx, ownerId);
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
    await replaceGrant(ctx, existing, { ...args, ownerId });
    return null;
  },
});

/** Pause, resume or disconnect one of the caller's sources: the next version, nothing else changed. */
export const setGrantState = mutation({
  args: { sourceId: v.string(), state: v.union(v.literal("active"), v.literal("paused"), v.literal("revoked")) },
  returns: v.null(),
  handler: async (ctx, { sourceId, state }) => {
    const ownerId = await requireOwnerId(ctx);
    const existing = await ctx.db
      .query("grants")
      .withIndex("by_source", (q) => q.eq("id", sourceId))
      .unique();
    if (existing === null || existing.ownerId !== ownerId) throw new ConvexError("Source is not available");
    // Revoke already stopped the provider watch; coming back is a new connect, not a resume.
    if (existing.state === "revoked") throw new ConvexError("This source was disconnected; connect it again");
    const { _id, _creationTime, ...grant } = existing;
    void [_id, _creationTime];
    await replaceGrant(ctx, existing, { ...grant, state, version: existing.version + 1 });
    return null;
  },
});

/** Remember who the user is (verified token only) for preparations that run without a caller. */
async function saveProfile(ctx: MutationCtx, ownerId: string) {
  const { name, email } = await verifiedUser(ctx);
  const profile = { ownerId, ...(name === null ? {} : { name }), ...(email === null ? {} : { email }) };
  const row = await ctx.db
    .query("ownerProfiles")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (row === null) await ctx.db.insert("ownerProfiles", profile);
  else await ctx.db.replace(row._id, profile);
}

const WATCHED_KINDS = new Set(["gmail", "outlook-mail", "outlook-calendar"]);

/**
 * The one way a stored grant changes: a strictly newer version. Entering "revoked" on a connected
 * Gmail/Outlook/Composio source hands one provider cleanup (stop watch / delete subscriptions /
 * delete the Composio account) to an action.
 */
async function replaceGrant(ctx: MutationCtx, existing: Doc<"grants">, next: Omit<Doc<"grants">, "_id" | "_creationTime">) {
  if (next.version <= existing.version) {
    throw new ConvexError(`Grant version must be greater than ${existing.version}`);
  }
  await ctx.db.replace(existing._id, next);
  if (next.state !== "revoked" || existing.state === "revoked") return;
  const connection = await ctx.db
    .query("connections")
    .withIndex("by_source", (q) => q.eq("sourceId", existing.id))
    .unique();
  if (connection === null) return;
  const stop =
    connection.broker === "composio"
      ? internal.connectors.composio.disconnect // delete the connected account and its triggers
      : !WATCHED_KINDS.has(existing.kind)
        ? null
        : existing.kind === "gmail"
          ? internal.connectors.gmail.stopWatch
          : internal.connectors.outlook.stopSubscriptions;
  if (stop !== null) await ctx.scheduler.runAfter(0, stop, { sourceId: existing.id, grantVersion: next.version });
}

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
  // grant is non-null here: decideIntake denies without one. Owner and consent come from the stored grant.
  if (decision.becomesCurrent && grant!.cloudProcessing) {
    for (const projectId of record.projectIds) await requestAutomaticPreparation(ctx, grant!.ownerId, projectId);
  }
  return "accepted";
}

/**
 * Coalesced: at most one pending or running automatic preparation per project. Evidence that lands
 * while one is pending is read by it; while one is running, it earns exactly one follow-up run.
 */
async function requestAutomaticPreparation(ctx: MutationCtx, ownerId: string, projectId: string) {
  const id = ctx.db.normalizeId("projects", projectId);
  const project = id === null ? null : await ctx.db.get(id);
  if (project === null || project.ownerId !== ownerId) return; // only the owner's confirmed projects
  const run = await ctx.db
    .query("preparationRuns")
    .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
    .unique();
  if (run === null) {
    await ctx.db.insert("preparationRuns", { ownerId, projectId, state: "pending", followUp: false });
    await ctx.scheduler.runAfter(0, internal.prepare.runAutomatic, { ownerId, projectId });
  } else if (run.state === "running" && !run.followUp) {
    await ctx.db.patch(run._id, { followUp: true });
  }
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
