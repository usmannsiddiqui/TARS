import { describe, expect, test } from "vitest";
import type { Artifact, ArtifactId, EvidenceId, OwnerId, ProjectId, RevisionId } from "@companion/domain";
import {
  FIRST_REVISION,
  applyChange,
  planUndo,
  reconcileDraft,
  toRevisionResult,
} from "../../packages/domain/src/artifacts";
import { enterProject, leaveProject } from "../../packages/domain/src/focus";

const rev = (n: number) => String(n) as RevisionId;
const artifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: "artifact-1" as ArtifactId,
  ownerId: "owner-alice" as OwnerId,
  projectId: "project-ai-guides" as ProjectId,
  revision: FIRST_REVISION,
  text: "Prepared run-through.",
  userEdited: false,
  evidenceIds: ["evidence-1" as EvidenceId],
  ...overrides,
});

describe("revision compare-and-set", () => {
  test("matching base applies, bumps the revision and keeps the previous version", () => {
    const current = artifact();
    const t = applyChange(current, FIRST_REVISION, { text: "Shorter run-through.", changeSummary: "Shortened." });
    expect(t.status).toBe("applied");
    if (t.status !== "applied") return;
    expect(t.artifact).toEqual({ ...current, revision: rev(2), text: "Shorter run-through." });
    expect(t.previous).toEqual(current);
    expect(toRevisionResult(t)).toEqual({
      status: "applied",
      artifact: t.artifact,
      undoRevision: FIRST_REVISION,
      changeSummary: "Shortened.",
    });
  });

  test("stale base is a conflict and returns the current artifact untouched", () => {
    const current = artifact({ revision: rev(3), text: "User's newer text.", userEdited: true });
    const t = applyChange(current, rev(2), { text: "Late model text.", changeSummary: "Shortened." });
    expect(t.status).toBe("conflict");
    expect(t.artifact).toBe(current);
    expect(toRevisionResult(t).undoRevision).toBeUndefined();
  });

  test("a user edit marks userEdited", () => {
    const t = applyChange(artifact(), FIRST_REVISION, { text: "Mine.", userEdited: true, changeSummary: "Saved." });
    expect(t.status === "applied" && t.artifact.userEdited).toBe(true);
  });
});

describe("undo", () => {
  const original = artifact();
  const revised = artifact({ revision: rev(2), text: "Revised." });

  test("restores the intended prior version as a new revision", () => {
    const t = planUndo(revised, rev(2), original);
    expect(t.status).toBe("applied");
    expect(t.artifact).toEqual({ ...original, revision: rev(3) });
  });

  test("refuses when the artifact moved past the expected revision", () => {
    const edited = artifact({ revision: rev(3), text: "Intervening edit.", userEdited: true });
    const t = planUndo(edited, rev(2), original);
    expect(t.status).toBe("conflict");
    expect(t.artifact.text).toBe("Intervening edit.");
  });

  test("refuses when the target version is missing or belongs to another artifact", () => {
    expect(planUndo(revised, rev(2), null).status).toBe("conflict");
    expect(planUndo(revised, rev(2), artifact({ id: "other" as ArtifactId })).status).toBe("conflict");
  });
});

describe("local draft reconciliation", () => {
  const cloud = artifact({ revision: rev(4), text: "Cloud text." });

  test("same text is in sync", () => {
    expect(reconcileDraft(artifact({ revision: rev(4), text: "Cloud text." }), cloud)).toEqual({ kind: "in-sync" });
  });
  test("draft on the current cloud revision can be pushed with that base", () => {
    expect(reconcileDraft(artifact({ revision: rev(4), text: "Offline edit." }), cloud)).toEqual({
      kind: "push",
      baseRevision: rev(4),
      text: "Offline edit.",
    });
  });
  test("draft on an older revision is a conflict carrying both texts", () => {
    expect(reconcileDraft(artifact({ revision: rev(2), text: "Old offline edit." }), cloud)).toEqual({
      kind: "conflict",
      localText: "Old offline edit.",
      cloud,
    });
  });
});

describe("focus rules", () => {
  const guides = "project-ai-guides" as ProjectId;
  const avt = "project-avt" as ProjectId;

  test("leaving a project snapshots its focus and artifact revision", () => {
    const focus = { projectId: guides, nextStep: "Read section one." };
    expect(leaveProject(focus, rev(5), "2026-11-14T10:00:00.000Z")).toEqual({
      focus,
      artifactRevision: rev(5),
      savedAt: "2026-11-14T10:00:00.000Z",
    });
    expect(leaveProject({}, undefined, "2026-11-14T10:00:00.000Z")).toBeNull();
  });

  test("entering restores the saved next step and points at the current artifact", () => {
    const saved = { focus: { projectId: guides, nextStep: "Read section one." }, artifactRevision: rev(5), savedAt: "t" };
    const art = { id: "artifact-1" as ArtifactId, revision: rev(5) };
    expect(enterProject(guides, saved, art, "now")).toEqual({
      focus: { projectId: guides, nextStep: "Read section one.", artifactId: "artifact-1" },
      artifactRevision: rev(5),
      savedAt: "t",
    });
  });

  test("entering a project never visited starts with just that project", () => {
    expect(enterProject(avt, null, null, "now")).toEqual({ focus: { projectId: avt }, savedAt: "now" });
  });
});
