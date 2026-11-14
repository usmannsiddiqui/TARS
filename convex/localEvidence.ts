import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { intakeRecord, intakeResult } from "./evidence";
import { requireOwnerId } from "./lib/auth";
import { evidenceFields } from "./schema";

// Sources that live on the user's Mac. Cloud kinds arrive only through provider webhooks (evidence.ingest).
const LOCAL_KINDS: ReadonlySet<string> = new Set(["obsidian", "claude-code", "codex"]);

/**
 * The desktop hands off one local record. The owner is the verified caller only; the record must
 * name that owner and a stored local grant the user consented to cloud processing for.
 */
export const submit = mutation({
  args: { record: v.object(evidenceFields) },
  returns: intakeResult,
  handler: async (ctx, { record }) => {
    const ownerId = await requireOwnerId(ctx);
    return await intakeRecord(
      ctx,
      { ownerId, sourceId: record.sourceId, record },
      (grant) => LOCAL_KINDS.has(grant.kind) && grant.cloudProcessing,
    );
  },
});
