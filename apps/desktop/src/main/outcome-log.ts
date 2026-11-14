// Performs the Obsidian outcome-log appends the cloud says are due (actions.pendingLocalLogs), driven
// by a live Convex subscription: each update is a push, nothing here runs on a timer.
import { createHash } from "node:crypto";
import type { SourceGrant } from "@companion/domain";
import type { LocalLogRequest, LocalLogResult } from "./local-log";

export type PendingLog = { actionId: string; target: string; marker: string; entry: string };

/** How the cloud names a designated note: an opaque id, so the local path never leaves the Mac. */
export const logTargetId = (notePath: string) => createHash("sha256").update(notePath).digest("hex").slice(0, 32);

export type LogSyncDeps = {
  /** The signed-in owner's local grants. */
  grants(): SourceGrant[];
  append(grant: SourceGrant, request: LocalLogRequest): Promise<LocalLogResult>;
  report(actionId: string, result: "written" | "failed"): Promise<void>;
};

export function createLogSync(deps: LogSyncDeps) {
  // The subscription can push the same item again before our report round-trips.
  const inFlight = new Set<string>();

  async function one(item: PendingLog): Promise<void> {
    const grant = deps
      .grants()
      .find((g) => g.kind === "obsidian" && g.state === "active" && g.writeTargets.some((t) => logTargetId(t) === item.target));
    const notePath = grant?.writeTargets.find((t) => logTargetId(t) === item.target);
    // No grant here (paused, revoked, another Mac): say so, so the log shows as failed instead of waiting forever.
    const outcome = grant && notePath ? await deps.append(grant, { notePath, marker: item.marker, entry: item.entry }) : null;
    await deps.report(item.actionId, outcome?.result ?? "failed");
  }

  return {
    async handle(items: PendingLog[]): Promise<void> {
      const fresh = items.filter((item) => !inFlight.has(item.actionId));
      await Promise.all(
        fresh.map(async (item) => {
          inFlight.add(item.actionId);
          try {
            await one(item);
          } finally {
            inFlight.delete(item.actionId);
          }
        }),
      );
    },
  };
}
