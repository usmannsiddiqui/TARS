import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";

/** The caller's owner ID, taken only from the verified token. Throws when unauthenticated. */
export async function requireOwnerId(ctx: Pick<QueryCtx, "auth">): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new ConvexError("Not authenticated");
  }
  return identity.tokenIdentifier;
}
