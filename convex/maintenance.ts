// Internal maintenance, run only from the Convex CLI/dashboard: nothing here is exported to clients.
import { v } from "convex/values";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { requireOwnedProject } from "./memory";

// Deletes per call; a run stops here with `more: true` and is run again (stays within mutation limits).
const LIMIT = 1000;

const TABLES = [
  "commitments",
  "nudges",
  "threadMessages",
  "artifacts",
  "artifactVersions",
  "artifactSuggestions",
  "artifactShares",
  "artifactDocuments",
  "preparedWork",
  "preparationRuns",
  "captureItems",
  "dismissedInvitations",
  "deliveryReceipts",
  "actions",
  "whatsappOutbox",
  "evidence",
  "tradeoffFlags",
] as const satisfies readonly TableNames[];
type Table = (typeof TABLES)[number];

/**
 * Clears one owner's one project of derived data for a clean demo. dryRun: count only.
 * Keeps succeeded/verified/unknown actions (real or possibly real sends) and the Word documents they link,
 * evidence of kinds not in `evidenceKinds` and evidence shared with another project; never touches grants,
 * connections, memory, suppressions, attention settings, pending briefs, other projects or other owners.
 */
export const resetProject = internalMutation({
  args: { ownerId: v.string(), projectId: v.string(), evidenceKinds: v.array(v.string()), dryRun: v.boolean() },
  returns: v.object({ counts: v.record(v.string(), v.number()), more: v.boolean() }),
  handler: async (ctx, { ownerId, projectId, evidenceKinds, dryRun }) => {
    await requireOwnedProject(ctx, ownerId, projectId);
    const range = (prefix: string) => [prefix, `${prefix}\uffff`] as const;
    const db = ctx.db;

    // Children before parents, so a run cut at LIMIT still finds the rest next time.
    const rows: { table: Table; doc: Doc<Table> }[] = [];
    const add = (table: Table, docs: Doc<Table>[]) => docs.forEach((doc) => rows.push({ table, doc }));

    const actions = await db.query("actions").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId)).take(LIMIT + 1);
    const kept = actions.filter((a) => a.state === "succeeded" || a.state === "unknown" || a.verifiedAt !== undefined);
    const keptDocuments = new Set(kept.map((a) => a.documentId).filter((id) => id !== undefined));
    add("actions", actions.filter((a) => !kept.includes(a)));

    const artifacts = await db.query("artifacts").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId)).take(LIMIT + 1);
    for (const artifact of artifacts) {
      const artifactId = artifact._id;
      add("artifactVersions", await db.query("artifactVersions").withIndex("by_artifact_revision", (q) => q.eq("artifactId", artifactId)).take(LIMIT + 1));
      add("artifactSuggestions", await db.query("artifactSuggestions").withIndex("by_artifact", (q) => q.eq("artifactId", artifactId)).take(LIMIT + 1));
      add("artifactShares", await db.query("artifactShares").withIndex("by_artifact", (q) => q.eq("artifactId", artifactId)).take(LIMIT + 1));
      const documents = await db.query("artifactDocuments").withIndex("by_artifact_revision", (q) => q.eq("artifactId", artifactId)).take(LIMIT + 1);
      add("artifactDocuments", documents.filter((d) => !keptDocuments.has(d._id)));
      add("artifacts", [artifact]);
    }

    // Nudge and tradeoff keys are commitmentKey: `${projectId}:<text>`; invitation keys are `task:${projectId}@...`.
    const [kLo, kHi] = range(`${projectId}:`);
    const [tLo, tHi] = range(`task:${projectId}@`);
    const nudges = await db.query("nudges").withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).gte("key", kLo).lt("key", kHi)).take(LIMIT + 1);
    for (const nudge of nudges) {
      const [nLo, nHi] = range(`nudge:${nudge._id}@`);
      add("deliveryReceipts", await db.query("deliveryReceipts").withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).gte("key", nLo).lt("key", nHi)).take(LIMIT + 1));
      add("whatsappOutbox", await db.query("whatsappOutbox").withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", `nudge:${nudge.key}`)).take(LIMIT + 1));
    }
    add("deliveryReceipts", await db.query("deliveryReceipts").withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).gte("key", tLo).lt("key", tHi)).take(LIMIT + 1));
    add("dismissedInvitations", await db.query("dismissedInvitations").withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).gte("key", tLo).lt("key", tHi)).take(LIMIT + 1));
    add("nudges", nudges);
    add("tradeoffFlags", await db.query("tradeoffFlags").withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).gte("key", kLo).lt("key", kHi)).take(LIMIT + 1));

    add("threadMessages", await db.query("threadMessages").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId)).take(LIMIT + 1));
    add("preparedWork", await db.query("preparedWork").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId)).take(LIMIT + 1));
    add("preparationRuns", await db.query("preparationRuns").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId)).take(LIMIT + 1));
    const captures = await db.query("captureItems").withIndex("by_owner_capture", (q) => q.eq("ownerId", ownerId)).collect();
    add("captureItems", captures.filter((c) => c.projectId === projectId));
    add("commitments", await db.query("commitments").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId)).take(LIMIT + 1));

    if (evidenceKinds.length > 0) {
      const kindOf = new Map<string, string | undefined>();
      for await (const row of ctx.db.query("evidence").withIndex("by_owner_id", (q) => q.eq("ownerId", ownerId))) {
        if (rows.length > LIMIT) break;
        if (row.projectIds.length !== 1 || row.projectIds[0] !== projectId) continue;
        if (!kindOf.has(row.sourceId)) {
          const grant = await ctx.db.query("grants").withIndex("by_source", (q) => q.eq("id", row.sourceId)).unique();
          kindOf.set(row.sourceId, grant?.ownerId === ownerId ? grant.kind : undefined);
        }
        const kind = kindOf.get(row.sourceId);
        if (kind !== undefined && evidenceKinds.includes(kind)) add("evidence", [row]);
      }
    }

    const more = rows.length > LIMIT;
    const batch = rows.slice(0, LIMIT);
    const counts: Record<string, number> = Object.fromEntries(TABLES.map((t) => [t, 0]));
    for (const { table, doc } of batch) {
      counts[table] = (counts[table] ?? 0) + 1;
      if (dryRun) continue;
      if (table === "nudges") {
        const job = (doc as Doc<"nudges">).dueJob;
        if (job !== undefined && (await ctx.db.system.get(job))?.state.kind === "pending") await ctx.scheduler.cancel(job);
      }
      if (table === "artifactDocuments") {
        const storageId = (doc as Doc<"artifactDocuments">).storageId;
        if (storageId !== undefined) await ctx.storage.delete(storageId);
      }
      await ctx.db.delete(doc._id as Id<Table>);
    }
    return { counts, more };
  },
});
