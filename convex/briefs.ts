// Daily brief, quiet contact and re-entry (T11). Deadline handlers are mutations: they can read
// only retained evidence, commitments and prepared work, and structurally cannot fetch a provider
// or call the model. Nothing here changes a commitment, sends anything or creates an action.
import { ConvexError, v } from "convex/values";
import {
  EVENING,
  MORNING,
  assembleBrief,
  assertTimezone,
  commitmentKey,
  decideAttention,
  detectTradeoff,
  invitationKey,
  isQuietTime,
  localDate,
  nextLocalTime,
  sessionState,
  summarizeReentry,
  type BriefContext,
  type BriefSource,
} from "../packages/domain/src/attention";
import {
  EvidenceSchema,
  type AttentionDecision,
  type AttentionInput,
  type Commitment,
  type Evidence,
  type EvidenceId,
  type OwnerId,
  type PreparedWork,
  type ProjectId,
  type SourceGrant,
  type TaskId,
} from "../packages/domain/src/types";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { StoredGrantSchema } from "./evidence";
import { requireOwnerId } from "./lib/auth";
import { loadFocus } from "./projects";
import schema, { commitmentFields } from "./schema";

type Ctx = Pick<QueryCtx, "db">;
type DailyKind = "morning" | "evening";

const briefValidator = schema.tables.pendingBriefs.validator.fields.brief;
const hardItemValidator = briefValidator.fields.hard.element;
const quietHoursValidator = v.object({ start: v.string(), end: v.string() });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_KEY_LENGTH = 300;

const attentionInputValidator = v.object({
  kind: v.union(v.literal("morning"), v.literal("task-return"), v.literal("evening")),
  now: v.string(),
  timezone: v.string(),
  working: v.boolean(),
  meeting: v.boolean(),
  quiet: v.boolean(),
  availability: v.union(v.literal("available"), v.literal("unknown")),
  panelOpen: v.boolean(),
  alreadyDelivered: v.boolean(),
  hasPreparedWork: v.boolean(),
});
const decisionValidator = v.union(v.literal("notify"), v.literal("panel-only"), v.literal("defer"), v.literal("suppress"));

// ---- Loading retained state.

async function loadSettings(ctx: Ctx, ownerId: string) {
  return await ctx.db
    .query("attentionSettings")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
}

async function pendingBrief(ctx: Ctx, ownerId: string, kind: DailyKind) {
  return await ctx.db
    .query("pendingBriefs")
    .withIndex("by_owner_kind", (q) => q.eq("ownerId", ownerId).eq("kind", kind))
    .unique();
}

async function ownedProjects(ctx: Ctx, ownerId: string) {
  return await ctx.db
    .query("projects")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .collect();
}

async function loadCommitments(ctx: Ctx, ownerId: string, projectIds: readonly string[]): Promise<Commitment[]> {
  const out: Commitment[] = [];
  for (const projectId of projectIds) {
    const rows = await ctx.db
      .query("commitments")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
      .collect();
    for (const row of rows) {
      out.push({
        id: row._id as string as TaskId,
        ownerId: ownerId as OwnerId,
        projectId: row.projectId as ProjectId,
        text: row.text,
        ownership: row.ownership,
        evidenceIds: row.evidenceIds as EvidenceId[],
        state: row.state,
        ...(row.dueAt === undefined ? {} : { dueAt: row.dueAt }),
      });
    }
  }
  return out;
}

/** Everything a brief may use, as already retained. Grants are revalidated here, at execution. */
async function loadBriefContext(ctx: Ctx, ownerId: string, nowMs: number, timezone: string): Promise<BriefContext> {
  const projects = (await ownedProjects(ctx, ownerId)).map((p) => p._id as string as ProjectId);
  const preparedWork: PreparedWork[] = [];
  for (const projectId of projects) {
    const row = await ctx.db
      .query("preparedWork")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
      .unique();
    if (row?.work !== undefined) preparedWork.push(row.work as PreparedWork);
  }

  const grants = new Map<string, SourceGrant | null>();
  const evidence: Evidence[] = [];
  const rows = await ctx.db
    .query("evidence")
    .withIndex("by_owner_current", (q) => q.eq("ownerId", ownerId).eq("isCurrent", true))
    .collect();
  for (const { _id, _creationTime, isCurrent, ...record } of rows) {
    void [_id, _creationTime, isCurrent];
    if (!grants.has(record.sourceId)) {
      const grantRow = await ctx.db
        .query("grants")
        .withIndex("by_source", (q) => q.eq("id", record.sourceId))
        .unique();
      grants.set(record.sourceId, grantRow === null ? null : StoredGrantSchema.parse(grantRow));
    }
    const grant = grants.get(record.sourceId);
    if (
      grant?.ownerId !== ownerId ||
      grant.state !== "active" ||
      !grant.read ||
      grant.version !== record.grantVersion ||
      !record.projectIds.some((p) => grant.projectIds.includes(p as ProjectId))
    ) {
      continue;
    }
    evidence.push(EvidenceSchema.parse(record));
  }

  const sources: BriefSource[] = [];
  for (const grant of grants.values()) {
    if (grant === null || grant.ownerId !== ownerId) continue;
    const connection = await ctx.db
      .query("connections")
      .withIndex("by_source", (q) => q.eq("sourceId", grant.id))
      .unique();
    sources.push({
      id: grant.id,
      kind: grant.kind,
      ...(connection?.lastCheckedAt === undefined ? {} : { lastCheckedAt: connection.lastCheckedAt }),
      ...(connection === null ? {} : { availability: connection.availability }),
    });
  }

  return {
    ownerId: ownerId as OwnerId,
    projects,
    commitments: await loadCommitments(ctx, ownerId, projects),
    lastFocus: await loadFocus(ctx, ownerId),
    evidence,
    now: new Date(nowMs).toISOString(),
    timezone,
    sources,
    preparedWork,
  };
}

async function hasReceipt(ctx: Ctx, ownerId: string, key: string) {
  const row = await ctx.db
    .query("deliveryReceipts")
    .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
    .first();
  return row !== null;
}

type AttentionItem = { input: AttentionInput; key: string; title: string; body: string };

/** The one thing that may reach the user next: morning brief, then task-return invitation, then evening recap. */
async function nextAttentionItem(ctx: Ctx, ownerId: string, settings: Doc<"attentionSettings">, nowMs: number): Promise<AttentionItem | null> {
  const events = await ctx.db
    .query("sessionEvents")
    .withIndex("by_owner_at", (q) => q.eq("ownerId", ownerId))
    .collect();
  const base = {
    now: new Date(nowMs).toISOString(),
    timezone: settings.timezone,
    ...sessionState(events, nowMs, settings.timezone),
    quiet: isQuietTime(nowMs, settings.timezone, settings.quietHours),
    panelOpen: false, // the desktop knows the panel; it re-decides with the live value
  };

  const morning = await pendingBrief(ctx, ownerId, "morning");
  const evening = await pendingBrief(ctx, ownerId, "evening");
  // A morning brief superseded by a newer evening recap is no longer offered as news.
  if (morning !== null && !(evening !== null && evening.preparedAt > morning.preparedAt)) {
    const alreadyDelivered = await hasReceipt(ctx, ownerId, morning.key);
    if (!alreadyDelivered) {
      return {
        input: { ...base, kind: "morning", alreadyDelivered, hasPreparedWork: morning.brief.items.length > 0 },
        key: morning.key,
        title: "Today",
        body: morning.brief.recommendedAction ?? morning.brief.items[0] ?? "",
      };
    }
  }

  const focus = await loadFocus(ctx, ownerId);
  if (focus.projectId !== undefined) {
    const projectId = focus.projectId;
    const prepared = await ctx.db
      .query("preparedWork")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
      .unique();
    if (prepared?.status === "ready" && prepared.work !== undefined) {
      const key = invitationKey({ projectId: projectId as ProjectId, updatedAt: prepared.updatedAt });
      const dismissed = await ctx.db
        .query("dismissedInvitations")
        .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
        .first();
      const alreadyDelivered = dismissed !== null || (await hasReceipt(ctx, ownerId, key));
      if (!alreadyDelivered) {
        return {
          input: { ...base, kind: "task-return", alreadyDelivered, hasPreparedWork: true },
          key,
          title: "Ready when you are",
          body: prepared.work.nextAction,
        };
      }
    }
  }

  if (evening !== null && !(await hasReceipt(ctx, ownerId, evening.key))) {
    return {
      input: { ...base, kind: "evening", alreadyDelivered: false, hasPreparedWork: evening.brief.items.length > 0 },
      key: evening.key,
      title: "Evening recap",
      body: evening.brief.items[0] ?? "",
    };
  }
  return null;
}

/** Evaluate each commitment once, against the obligations evaluated before it. */
async function flagNewTradeoffs(ctx: MutationCtx, ownerId: string, commitments: readonly Commitment[]) {
  const flags = await ctx.db
    .query("tradeoffFlags")
    .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId))
    .collect();
  const evaluated = new Set(flags.map((f) => f.key));
  const existing = commitments.filter((c) => evaluated.has(commitmentKey(c)));
  for (const commitment of commitments) {
    const key = commitmentKey(commitment);
    if (evaluated.has(key)) continue;
    const text = detectTradeoff(commitment, existing);
    await ctx.db.insert("tradeoffFlags", { ownerId, key, ...(text === null ? { state: "none" as const } : { state: "open" as const, text }) });
    evaluated.add(key);
    existing.push(commitment);
  }
}

// ---- Settings and scheduling.

export const setAttentionSettings = mutation({
  args: { timezone: v.string(), quietHours: v.optional(quietHoursValidator) },
  returns: v.null(),
  handler: async (ctx, { timezone, quietHours }) => {
    const ownerId = await requireOwnerId(ctx);
    try {
      assertTimezone(timezone);
    } catch {
      throw new ConvexError("Unknown timezone");
    }
    if (quietHours !== undefined && (!HHMM.test(quietHours.start) || !HHMM.test(quietHours.end) || quietHours.start === quietHours.end)) {
      throw new ConvexError("Quiet hours must be two different HH:MM times");
    }
    const existing = await loadSettings(ctx, ownerId);
    if (existing !== null) {
      for (const job of [existing.morningJob, existing.eveningJob]) {
        if ((await ctx.db.system.get(job))?.state.kind === "pending") await ctx.scheduler.cancel(job);
      }
    }
    const now = Date.now();
    const morningAt = nextLocalTime(now, timezone, MORNING.hour, MORNING.minute);
    const eveningAt = nextLocalTime(now, timezone, EVENING.hour, EVENING.minute);
    // Backend auth does not carry into scheduled functions: pass the owner, revalidate on run.
    const fields = {
      ownerId,
      timezone,
      morningAt,
      morningJob: await ctx.scheduler.runAt(morningAt, internal.briefs.prepareMorning, { ownerId, scheduledFor: morningAt }),
      eveningAt,
      eveningJob: await ctx.scheduler.runAt(eveningAt, internal.briefs.prepareEvening, { ownerId, scheduledFor: eveningAt }),
      ...(quietHours === undefined ? {} : { quietHours }),
    };
    if (existing === null) await ctx.db.insert("attentionSettings", fields);
    else await ctx.db.replace(existing._id, fields);
    return null;
  },
});

/** Prepare one daily brief, replace the pending one, schedule exactly the next local deadline. */
async function prepareDaily(ctx: MutationCtx, kind: DailyKind, ownerId: string, scheduledFor: number): Promise<null> {
  const settings = await loadSettings(ctx, ownerId);
  // Owner gone or settings changed since this run was scheduled: a stale run does nothing.
  if (settings === null || (kind === "morning" ? settings.morningAt : settings.eveningAt) !== scheduledFor) return null;
  const now = Date.now();
  const context = await loadBriefContext(ctx, ownerId, now, settings.timezone);
  await flagNewTradeoffs(ctx, ownerId, context.commitments);
  const old = await pendingBrief(ctx, ownerId, kind);
  if (old !== null) await ctx.db.delete(old._id);
  await ctx.db.insert("pendingBriefs", {
    ownerId,
    kind,
    key: `${kind}:${localDate(scheduledFor, settings.timezone)}`,
    preparedAt: now,
    brief: assembleBrief(context, kind),
  });
  // From now, not from the missed deadline: no catch-up chain after downtime.
  const time = kind === "morning" ? MORNING : EVENING;
  const next = nextLocalTime(Math.max(now, scheduledFor), settings.timezone, time.hour, time.minute);
  const fn = kind === "morning" ? internal.briefs.prepareMorning : internal.briefs.prepareEvening;
  const job = await ctx.scheduler.runAt(next, fn, { ownerId, scheduledFor: next });
  await ctx.db.patch(settings._id, kind === "morning" ? { morningAt: next, morningJob: job } : { eveningAt: next, eveningJob: job });
  return null;
}

const deadlineArgs = { ownerId: v.string(), scheduledFor: v.number() };

export const prepareMorning = internalMutation({
  args: deadlineArgs,
  returns: v.null(),
  handler: (ctx, { ownerId, scheduledFor }): Promise<null> => prepareDaily(ctx, "morning", ownerId, scheduledFor),
});

export const prepareEvening = internalMutation({
  args: deadlineArgs,
  returns: v.null(),
  handler: (ctx, { ownerId, scheduledFor }): Promise<null> => prepareDaily(ctx, "evening", ownerId, scheduledFor),
});

// ---- Explicit user events.

export const recordSessionEvent = mutation({
  args: {
    kind: v.union(
      v.literal("start"),
      v.literal("stop"),
      v.literal("break"),
      v.literal("resume"),
      v.literal("meeting-start"),
      v.literal("meeting-end"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { kind }) => {
    const ownerId = await requireOwnerId(ctx);
    await ctx.db.insert("sessionEvents", { ownerId, kind, at: Date.now() });
    return null;
  },
});

/** The Mac woke, unlocked or the user came back: record it and say what contact is allowed. No OS call. */
export const handleReturn = mutation({
  args: { panelOpen: v.boolean() },
  returns: v.object({ decision: decisionValidator, key: v.optional(v.string()) }),
  handler: async (ctx, { panelOpen }): Promise<{ decision: AttentionDecision; key?: string }> => {
    const ownerId = await requireOwnerId(ctx);
    const settings = await loadSettings(ctx, ownerId);
    if (settings === null) throw new ConvexError("Set your timezone first");
    const now = Date.now();
    await ctx.db.insert("sessionEvents", { ownerId, kind: "return", at: now });
    const item = await nextAttentionItem(ctx, ownerId, settings, now);
    if (item === null) return { decision: "suppress" };
    return { decision: decideAttention({ ...item.input, panelOpen }), key: item.key };
  },
});

const validKey = (key: string) => key.length <= MAX_KEY_LENGTH && /^((morning|evening):\d{4}-\d{2}-\d{2}|task:.+)$/.test(key);

/** A brief or invitation was shown (OS notification or panel): it is never delivered again. */
export const markDelivered = mutation({
  args: { key: v.string(), channel: v.union(v.literal("notification"), v.literal("panel")) },
  returns: v.null(),
  handler: async (ctx, { key, channel }) => {
    const ownerId = await requireOwnerId(ctx);
    if (!validKey(key)) throw new ConvexError("Invalid delivery key");
    if (!(await hasReceipt(ctx, ownerId, key))) await ctx.db.insert("deliveryReceipts", { ownerId, key, channel, at: Date.now() });
    return null;
  },
});

export const dismissInvitation = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, { key }) => {
    const ownerId = await requireOwnerId(ctx);
    if (!validKey(key) || !key.startsWith("task:")) throw new ConvexError("Invalid invitation key");
    const existing = await ctx.db
      .query("dismissedInvitations")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
      .first();
    if (existing === null) await ctx.db.insert("dismissedInvitations", { ownerId, key, at: Date.now() });
    return null;
  },
});

/** The user's choice ends the flag. The commitment itself is not changed. */
export const resolveTradeoff = mutation({
  args: {
    commitmentId: v.id("commitments"),
    choice: v.union(v.literal("keep"), v.literal("defer"), v.literal("renegotiate")),
  },
  returns: v.null(),
  handler: async (ctx, { commitmentId, choice }) => {
    const ownerId = await requireOwnerId(ctx);
    const commitment = await ctx.db.get(commitmentId);
    if (commitment === null || commitment.ownerId !== ownerId) throw new ConvexError("Commitment not found");
    const flag = await ctx.db
      .query("tradeoffFlags")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", commitmentKey({ projectId: commitment.projectId as ProjectId, text: commitment.text })))
      .first();
    if (flag?.state !== "open") throw new ConvexError("No open tradeoff for this commitment");
    await ctx.db.patch(flag._id, { state: "resolved", choice });
    return null;
  },
});

// ---- Subscriptions.

export const getPendingBrief = query({
  args: { kind: v.optional(v.union(v.literal("morning"), v.literal("evening"))) },
  returns: v.union(
    v.null(),
    v.object({
      key: v.string(),
      kind: v.union(v.literal("morning"), v.literal("evening")),
      preparedAt: v.number(),
      delivered: v.boolean(),
      brief: briefValidator,
      tradeoffs: v.array(v.object({ commitmentId: v.id("commitments"), text: v.string() })),
    }),
  ),
  handler: async (ctx, { kind }) => {
    const ownerId = await requireOwnerId(ctx);
    const row = await pendingBrief(ctx, ownerId, kind ?? "morning");
    if (row === null) return null;
    const open = await ctx.db
      .query("tradeoffFlags")
      .withIndex("by_owner_state", (q) => q.eq("ownerId", ownerId).eq("state", "open"))
      .collect();
    const projects = (await ownedProjects(ctx, ownerId)).map((p) => p._id as string);
    const byKey = new Map((await loadCommitments(ctx, ownerId, projects)).map((c) => [commitmentKey(c), c.id as string]));
    const tradeoffs = open.flatMap((flag) => {
      const id = byKey.get(flag.key);
      const commitmentId = id === undefined ? null : ctx.db.normalizeId("commitments", id);
      return commitmentId === null || flag.text === undefined ? [] : [{ commitmentId, text: flag.text }];
    });
    return { key: row.key, kind: row.kind, preparedAt: row.preparedAt, delivered: await hasReceipt(ctx, ownerId, row.key), brief: row.brief, tradeoffs };
  },
});

/** What may contact the user next, as the AttentionInput the desktop decides on (with live panel state). */
export const getAttentionState = query({
  args: {},
  returns: v.union(v.null(), v.object({ input: attentionInputValidator, key: v.string(), title: v.string(), body: v.string() })),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const settings = await loadSettings(ctx, ownerId);
    return settings === null ? null : await nextAttentionItem(ctx, ownerId, settings, Date.now());
  },
});

/** Restart after time away: what changed, what is urgent, one next action, the whole backlog and drafts. */
export const getReentry = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      since: v.union(v.null(), v.string()),
      changed: v.array(v.object({ evidenceId: v.string(), sourceId: v.string(), text: v.string(), occurredAt: v.string() })),
      changedCount: v.number(),
      urgent: v.array(hardItemValidator),
      recommendedAction: v.optional(v.string()),
      reason: v.optional(v.string()),
      backlog: v.array(v.object({ id: v.string(), ownerId: v.string(), projectId: v.string(), ...commitmentFields })),
      staleSourceIds: v.array(v.string()),
      drafts: v.array(
        v.object({ artifactId: v.id("artifacts"), projectId: v.string(), revision: v.string(), userEdited: v.boolean(), preview: v.string() }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const settings = await loadSettings(ctx, ownerId);
    if (settings === null) return null;
    const now = Date.now();
    // The latest return is the current visit; the one before it is when the user was last here.
    const returns = await ctx.db
      .query("sessionEvents")
      .withIndex("by_owner_at", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .filter((q) => q.eq(q.field("kind"), "return"))
      .take(2);
    const previous = returns[1];
    const since = previous === undefined ? null : new Date(previous.at).toISOString();
    const context = await loadBriefContext(ctx, ownerId, now, settings.timezone);
    const drafts = [];
    for (const projectId of context.projects) {
      const artifact = await ctx.db
        .query("artifacts")
        .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
        .unique();
      if (artifact !== null) {
        drafts.push({ artifactId: artifact._id, projectId, revision: artifact.revision, userEdited: artifact.userEdited, preview: artifact.text.slice(0, 140) });
      }
    }
    return { ...summarizeReentry(context, since), drafts };
  },
});
