import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOwnerId } from "./lib/auth";

const MAX_PROJECT_NAME_LENGTH = 100;

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
