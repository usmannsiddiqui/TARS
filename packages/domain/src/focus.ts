// Chosen-focus snapshots. Pure: no I/O. Focus changes only through an explicit user selection;
// these functions are called solely by the user-initiated switch (convex/projects.ts).
import type { ArtifactId, FocusState, ProjectId, ProjectSnapshot, RevisionId } from "./types";

/** Snapshot of the project being left, or null when nothing was focused. */
export function leaveProject(focus: FocusState, artifactRevision: RevisionId | undefined, savedAt: string): ProjectSnapshot | null {
  if (focus.projectId === undefined) return null;
  return { focus, ...(artifactRevision === undefined ? {} : { artifactRevision }), savedAt };
}

/** Focus for the project being entered: its saved next step/task, pointing at its current artifact. */
export function enterProject(
  target: ProjectId,
  saved: ProjectSnapshot | null,
  artifact: { id: ArtifactId; revision: RevisionId } | null,
  now: string,
): ProjectSnapshot {
  const { artifactId: _stale, ...kept } = saved?.focus ?? {};
  void _stale;
  const artifactRevision = saved?.artifactRevision ?? artifact?.revision;
  return {
    focus: { ...kept, projectId: target, ...(artifact === null ? {} : { artifactId: artifact.id }) },
    ...(artifactRevision === undefined ? {} : { artifactRevision }),
    savedAt: saved?.savedAt ?? now,
  };
}
