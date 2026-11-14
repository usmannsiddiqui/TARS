import { ConvexError, v } from "convex/values";
import { enterProject, leaveProject } from "../packages/domain/src/focus";
import type { ArtifactId, FocusState, ProjectId, ProjectSnapshot, RevisionId } from "../packages/domain/src/types";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireOwnerId } from "./lib/auth";
import { requireOwnedProject } from "./memory";
import { focusFields } from "./schema";

const MAX_PROJECT_NAME_LENGTH = 100;
const MAX_NEXT_STEP_LENGTH = 500;

// Chosen focus (invariant 6) changes only through an explicit user selection. The focus and
// snapshot tables are written solely by the helpers below, and only the exported mutations that
// require `userInitiated: v.literal(true)` call them. Capture, observation, notifications,
// recommendations and model output have no path here (tests/integration/project-continuity.test.ts).

async function loadFocus(ctx: Pick<QueryCtx, "db">, ownerId: string): Promise<FocusState> {
  const row = await ctx.db
    .query("focus")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (row === null) return {};
  const { _id, _creationTime, ownerId: _owner, ...focus } = row;
  void [_id, _creationTime, _owner];
  return focus as FocusState;
}

async function writeFocus(ctx: MutationCtx, ownerId: string, focus: FocusState) {
  const row = await ctx.db
    .query("focus")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (row === null) await ctx.db.insert("focus", { ownerId, ...focus });
  else await ctx.db.replace(row._id, { ownerId, ...focus });
}

async function snapshotRow(ctx: Pick<QueryCtx, "db">, ownerId: string, projectId: string) {
  return await ctx.db
    .query("projectSnapshots")
    .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
    .unique();
}

async function saveSnapshot(ctx: MutationCtx, ownerId: string, projectId: string, snapshot: ProjectSnapshot) {
  const row = await snapshotRow(ctx, ownerId, projectId);
  if (row === null) await ctx.db.insert("projectSnapshots", { ownerId, projectId, ...snapshot });
  else await ctx.db.replace(row._id, { ownerId, projectId, ...snapshot });
}

async function loadSnapshot(ctx: Pick<QueryCtx, "db">, ownerId: string, projectId: string): Promise<ProjectSnapshot | null> {
  const row = await snapshotRow(ctx, ownerId, projectId);
  if (row === null) return null;
  const { focus, artifactRevision, savedAt } = row;
  return { focus: focus as FocusState, ...(artifactRevision === undefined ? {} : { artifactRevision: artifactRevision as RevisionId }), savedAt };
}

async function currentArtifact(ctx: Pick<QueryCtx, "db">, ownerId: string, projectId: string) {
  const row = await ctx.db
    .query("artifacts")
    .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId))
    .unique();
  return row === null ? null : { id: row._id as string as ArtifactId, revision: row.revision as RevisionId };
}

const snapshotView = v.object({ focus: v.object(focusFields), artifactRevision: v.optional(v.string()), savedAt: v.string() });

export const listProjects = query({
  args: {},
  returns: v.array(v.object({ id: v.id("projects"), name: v.string() })),
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
    return projects.map((project) => ({ id: project._id, name: project.name }));
  },
});

export const createProject = mutation({
  args: { name: v.string() },
  returns: v.id("projects"),
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const name = args.name.trim();
    if (name.length === 0) {
      throw new ConvexError("Project name must not be empty");
    }
    if (name.length > MAX_PROJECT_NAME_LENGTH) {
      throw new ConvexError(`Project name must be at most ${MAX_PROJECT_NAME_LENGTH} characters`);
    }
    return await ctx.db.insert("projects", { ownerId, name });
  },
});

/** The caller's chosen focus ({} before the first selection). */
export const getFocus = query({
  args: {},
  returns: v.object(focusFields),
  handler: async (ctx) => loadFocus(ctx, await requireOwnerId(ctx)),
});

/**
 * The user chose another project: snapshot the one being left (focus + artifact revision + next
 * step) and return the target's restored snapshot, which becomes the chosen focus.
 */
export const switchProject = mutation({
  args: { targetProjectId: v.string(), userInitiated: v.literal(true) },
  returns: snapshotView,
  handler: async (ctx, { targetProjectId }) => {
    const ownerId = await requireOwnerId(ctx);
    await requireOwnedProject(ctx, ownerId, targetProjectId);
    const now = new Date().toISOString();
    const current = await loadFocus(ctx, ownerId);
    if (current.projectId !== undefined) {
      const left = leaveProject(current, (await currentArtifact(ctx, ownerId, current.projectId))?.revision, now);
      if (left !== null) await saveSnapshot(ctx, ownerId, current.projectId, left);
    }
    const entered = enterProject(
      targetProjectId as ProjectId,
      await loadSnapshot(ctx, ownerId, targetProjectId),
      await currentArtifact(ctx, ownerId, targetProjectId),
      now,
    );
    await writeFocus(ctx, ownerId, entered.focus);
    return entered;
  },
});

/** The user set a project's next step: on the chosen focus, or in that project's snapshot. */
export const setNextStep = mutation({
  args: { projectId: v.string(), nextStep: v.string(), userInitiated: v.literal(true) },
  returns: v.null(),
  handler: async (ctx, { projectId, nextStep }) => {
    const ownerId = await requireOwnerId(ctx);
    await requireOwnedProject(ctx, ownerId, projectId);
    const step = nextStep.trim();
    if (step.length === 0 || step.length > MAX_NEXT_STEP_LENGTH) {
      throw new ConvexError(`Next step must be 1-${MAX_NEXT_STEP_LENGTH} characters`);
    }
    const focus = await loadFocus(ctx, ownerId);
    if (focus.projectId === projectId) {
      await writeFocus(ctx, ownerId, { ...focus, nextStep: step });
    } else {
      const saved = (await loadSnapshot(ctx, ownerId, projectId)) ?? { focus: { projectId: projectId as ProjectId }, savedAt: new Date().toISOString() };
      await saveSnapshot(ctx, ownerId, projectId, { ...saved, focus: { ...saved.focus, nextStep: step } });
    }
    return null;
  },
});
