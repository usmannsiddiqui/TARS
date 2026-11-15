// Artifact revision policy: compare-and-set, undo and local-draft reconciliation. Pure: no I/O.
// Every change names the revision it was based on; a stale base never overwrites newer text.
import { z } from "zod";
import {
  EvidenceIdSchema,
  OwnerIdSchema,
  ProjectIdSchema,
  type Artifact,
  type EvidenceId,
  type RevisionId,
  type RevisionResult,
} from "./types";

export const MAX_ARTIFACT_TEXT = 100_000;

/** Artifact at a trust boundary (IPC, local disk). */
export const ArtifactSchema = z.strictObject({
  id: z.string().min(1).brand("ArtifactId"),
  ownerId: OwnerIdSchema,
  projectId: ProjectIdSchema,
  revision: z.string().min(1).brand("RevisionId"),
  text: z.string().max(MAX_ARTIFACT_TEXT),
  userEdited: z.boolean(),
  evidenceIds: z.array(EvidenceIdSchema),
  title: z.string().exactOptional(),
  form: z.enum(["document", "reply"]).exactOptional(),
}) satisfies z.ZodType<Artifact>;

export const FIRST_REVISION = "1" as RevisionId;
// Revisions are a per-artifact counter: unique and monotonic, compared only for equality.
const nextRevision = (revision: RevisionId) => String(Number(revision) + 1) as RevisionId;

export type Change = { text: string; changeSummary: string; userEdited?: boolean; evidenceIds?: EvidenceId[] };
export type Transition =
  | { status: "applied"; artifact: Artifact; previous: Artifact; changeSummary: string }
  | { status: "conflict"; artifact: Artifact; changeSummary: string };

const CONFLICT_SUMMARY = "Your text changed since this was requested, so it was left as it is.";

/** Apply `change` only if `current` is still at `baseRevision`; otherwise conflict with `current` untouched. */
export function applyChange(current: Artifact, baseRevision: RevisionId, change: Change): Transition {
  if (current.revision !== baseRevision) return { status: "conflict", artifact: current, changeSummary: CONFLICT_SUMMARY };
  return {
    status: "applied",
    previous: current,
    changeSummary: change.changeSummary,
    artifact: {
      ...current,
      revision: nextRevision(current.revision),
      text: change.text,
      userEdited: change.userEdited ?? current.userEdited,
      evidenceIds: change.evidenceIds ?? current.evidenceIds,
    },
  };
}

/**
 * Restore `target` (a stored prior version) as a new revision, only while the artifact is still at
 * `expectedCurrent`. An edit made after the revision being undone is never erased.
 */
export function planUndo(current: Artifact, expectedCurrent: RevisionId, target: Artifact | null): Transition {
  if (target === null || target.id !== current.id) {
    return { status: "conflict", artifact: current, changeSummary: "That earlier version is not available." };
  }
  return applyChange(current, expectedCurrent, {
    text: target.text,
    userEdited: target.userEdited,
    evidenceIds: target.evidenceIds,
    changeSummary: `Restored revision ${target.revision}.`,
  });
}

export function toRevisionResult(transition: Transition): RevisionResult {
  return transition.status === "applied"
    ? {
        status: "applied",
        artifact: transition.artifact,
        undoRevision: transition.previous.revision,
        changeSummary: transition.changeSummary,
      }
    : { status: "conflict", artifact: transition.artifact, changeSummary: transition.changeSummary };
}

export type DraftReconciliation =
  | { kind: "in-sync" }
  | { kind: "push"; baseRevision: RevisionId; text: string }
  | { kind: "conflict"; localText: string; cloud: Artifact };

/**
 * On reconnect, before any cloud write. `draft.revision` is the cloud revision the local text was
 * edited from. Only a draft on the current cloud revision may be pushed (still compare-and-set);
 * any other difference is surfaced, so neither side silently overwrites the other.
 */
export function reconcileDraft(draft: Artifact, cloud: Artifact): DraftReconciliation {
  if (draft.text === cloud.text) return { kind: "in-sync" };
  if (draft.revision === cloud.revision) return { kind: "push", baseRevision: draft.revision, text: draft.text };
  return { kind: "conflict", localText: draft.text, cloud };
}
