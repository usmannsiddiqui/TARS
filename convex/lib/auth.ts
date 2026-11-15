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

/** The caller's display name and email from the verified token only; null fields when absent. */
export async function verifiedUser(ctx: Pick<QueryCtx, "auth">): Promise<{ name: string | null; email: string | null }> {
  const identity = await ctx.auth.getUserIdentity();
  const name =
    identity?.name ||
    [identity?.givenName, identity?.familyName].filter(Boolean).join(" ") ||
    identity?.nickname ||
    identity?.preferredUsername;
  return { name: name || null, email: identity?.email || null };
}
