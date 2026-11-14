import { describe, expect, test } from "vitest";
import type { Artifact, ArtifactId, EvidenceId, OwnerId, ProjectId, RevisionId } from "@companion/domain";
import {
  actionMarker,
  checkBinding,
  contentHash,
  logMarker,
  mailSubject,
  messageIdFor,
  outcomeLogEntry,
} from "../../packages/domain/src/actions";

const artifact: Artifact = {
  id: "artifact-1" as ArtifactId,
  ownerId: "owner-alice" as OwnerId,
  projectId: "project-avt" as ProjectId,
  revision: "2" as RevisionId,
  text: "AVT pitch follow-up\n\nHere is the outline we discussed.",
  userEdited: true,
  evidenceIds: [] as EvidenceId[],
};

async function intent(overrides: Record<string, string> = {}) {
  return {
    kind: "send-mail" as const,
    destination: "bob@illustrative.example",
    projectId: artifact.projectId as string,
    artifactId: artifact.id as string,
    revision: artifact.revision as string,
    contentHash: await contentHash(artifact.text),
    ...overrides,
  };
}

describe("instructed action binding", () => {
  test("matching revision, hash and a single address is bound", async () => {
    expect(checkBinding(await intent(), artifact, await contentHash(artifact.text))).toEqual({ ok: true });
  });

  test("a different revision or content hash asks again instead of sending", async () => {
    const hash = await contentHash(artifact.text);
    expect(checkBinding(await intent({ revision: "1" }), artifact, hash).ok).toBe(false);
    expect(checkBinding(await intent({ contentHash: await contentHash("other text") }), artifact, hash).ok).toBe(false);
  });

  test("the artifact must belong to the named project", async () => {
    const hash = await contentHash(artifact.text);
    expect(checkBinding(await intent({ projectId: "project-other" }), artifact, hash).ok).toBe(false);
    expect(checkBinding(await intent({ artifactId: "artifact-2" }), artifact, hash).ok).toBe(false);
  });

  test("send-mail needs exactly one plain address (no header injection, no lists)", async () => {
    const hash = await contentHash(artifact.text);
    for (const destination of ["bob", "a@x.example, c@y.example", "bob@x.example\r\nBcc: eve@x.example", ""]) {
      expect(checkBinding(await intent({ destination }), artifact, hash).ok).toBe(false);
    }
  });
});

describe("markers and log entries", () => {
  test("markers are deterministic per action and distinct for action and log", () => {
    expect(actionMarker("a1")).toBe(actionMarker("a1"));
    expect(actionMarker("a1")).not.toBe(logMarker("a1"));
    expect(messageIdFor("a1")).toMatch(/^<.+@.+>$/);
    expect(messageIdFor("a1")).toContain(actionMarker("a1"));
  });

  test("the log entry names what was verified and carries the log marker", () => {
    const entry = outcomeLogEntry({
      actionId: "a1",
      kind: "send-mail",
      destination: "bob@illustrative.example",
      externalId: "m1",
      verifiedAt: "2026-11-14T10:00:00.000Z",
    });
    expect(entry).toContain("bob@illustrative.example");
    expect(entry).toContain("m1");
    expect(entry).toContain(logMarker("a1"));
  });

  test("mail subject is the first non-empty line, bounded", () => {
    expect(mailSubject("\n  AVT pitch follow-up \nbody")).toBe("AVT pitch follow-up");
    expect(mailSubject("x".repeat(500)).length).toBeLessThanOrEqual(120);
  });
});
