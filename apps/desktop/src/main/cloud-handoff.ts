// Hands consented local evidence to the cloud. Main process only, and event-driven: trigger() runs
// on evidence enqueued, sign-in, a consent change, OS resume or back-online. Nothing here runs on a
// timer; a failure becomes a visible "needs-retry" status and the next event tries again.
import type { Evidence, IntakeResult, OwnerId, SourceGrant, SourceId } from "@companion/domain";
import type { LocalGrantRecord } from "./local-store";
import { logTargetId } from "./outcome-log";

export type CloudSync = { state: "synced" } | { state: "needs-retry"; reason: string } | { state: "denied"; count: number };

/** A grant as mirrored to the cloud: no ownerId (the cloud takes it from the token) and no local paths (private). */
export type CloudGrant = Omit<SourceGrant, "ownerId">;

export type HandoffDeps = {
  currentOwner(): OwnerId | null;
  cloud: {
    setGrant(grant: CloudGrant): Promise<void>;
    submit(record: Evidence): Promise<IntakeResult>;
  };
  sources: {
    cloudGrants(ownerId: OwnerId): LocalGrantRecord[];
    markMirrored(ownerId: OwnerId, sourceId: SourceId, version: number): Promise<void>;
    setCloudSync(sourceId: SourceId, status: CloudSync): void;
  };
  outbox: {
    loadOutbox(ownerId: OwnerId): Promise<Evidence[]>;
    markSynced(evidence: Evidence, ownerId: OwnerId): Promise<void>;
  };
};

// An explicit allowlist: selectors and write targets can be local paths, so neither is sent as such.
// A write target goes as its opaque id: the cloud names the log note by it (setLogDestination, pendingLocalLogs).
const cloudGrantOf = (g: SourceGrant): CloudGrant => ({
  id: g.id,
  kind: g.kind,
  selectors: [],
  projectIds: g.projectIds,
  read: g.read,
  writeTargets: g.writeTargets.map(logTargetId),
  cloudProcessing: g.cloudProcessing,
  version: g.version,
  state: g.state,
});
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createHandoff(deps: HandoffDeps) {
  async function drain(): Promise<void> {
    const ownerId = deps.currentOwner();
    if (!ownerId) return;
    const stillSignedIn = () => deps.currentOwner() === ownerId;
    const outbox = await deps.outbox.loadOutbox(ownerId);

    for (const { grant, mirroredVersion } of deps.sources.cloudGrants(ownerId)) {
      // The cloud needs every version after it first learned of the grant (consent off, revoke), and none before.
      const needsMirror = mirroredVersion === null ? grant.cloudProcessing : mirroredVersion < grant.version;
      if (needsMirror) {
        if (!stillSignedIn()) return;
        try {
          await deps.cloud.setGrant(cloudGrantOf(grant));
          await deps.sources.markMirrored(ownerId, grant.id, grant.version);
        } catch (err) {
          deps.sources.setCloudSync(grant.id, { state: "needs-retry", reason: messageOf(err) });
          continue;
        }
      }
      if (grant.state !== "active" || !grant.cloudProcessing) continue;

      let denied = 0;
      let failure: string | undefined;
      for (const record of outbox.filter((e) => e.sourceId === grant.id && e.grantVersion === grant.version)) {
        if (!stillSignedIn()) return; // signed out mid-drain: leave the rest queued for that owner
        try {
          const result = await deps.cloud.submit(record);
          if (result === "denied") denied++;
          else await deps.outbox.markSynced(record, ownerId);
        } catch (err) {
          failure = messageOf(err);
          break; // keep order: later records wait for the next event
        }
      }
      deps.sources.setCloudSync(
        grant.id,
        failure !== undefined
          ? { state: "needs-retry", reason: failure }
          : denied > 0
            ? { state: "denied", count: denied }
            : { state: "synced" },
      );
    }
  }

  let running: Promise<void> | null = null;
  let again = false;

  return {
    /** Runs one drain; events during a drain coalesce into exactly one more pass. */
    trigger(): Promise<void> {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          await drain().catch((err: unknown) => console.error("cloud hand-off failed", err));
        } while (again);
        running = null;
      })();
      return running;
    },
  };
}
