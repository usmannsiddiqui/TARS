import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  ProjectIdSchema,
  SourceIdSchema,
  type Artifact,
  type ArtifactId,
  type OwnerId,
  type RevisionId,
  type SourceGrant,
} from "@companion/domain";
import { aesGcmCipher, openLocalStore, type Cipher } from "../../apps/desktop/src/main/local-store";
import { makeEvidence, makeOwners, makeProjects } from "../fixtures";

// The app's real at-rest cipher with a random data key (in the app the key is wrapped by safeStorage).
const testCipher = (): Cipher => aesGcmCipher(randomBytes(32));

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "companion-store-"));
  dbPath = join(dir, "local.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("local capture store", () => {
  it("capture_survives_process_restart", async () => {
    const { alice } = makeOwners();
    const cipher = testCipher();

    const first = openLocalStore(dbPath, cipher);
    const receipt = await first.saveCapture({ text: "AVT idea", origin: "typed" }, alice.ownerId);
    first.close();

    expect(receipt.saved).toBe(true);
    expect(receipt.summary).toBe("AVT idea");

    const reopened = openLocalStore(dbPath, cipher);
    expect(await reopened.loadPending(alice.ownerId)).toEqual([{ text: "AVT idea", origin: "typed" }]);
    reopened.close();
  });

  it("does not report saved when the write fails before commit", async () => {
    const { alice } = makeOwners();
    const cipher = testCipher();
    const failing: Cipher = {
      encrypt() {
        throw new Error("keychain unavailable");
      },
      decrypt: cipher.decrypt,
    };

    const store = openLocalStore(dbPath, failing);
    await expect(store.saveCapture({ text: "AVT idea", origin: "typed" }, alice.ownerId)).rejects.toThrow(
      "keychain unavailable",
    );
    store.close();

    const reopened = openLocalStore(dbPath, cipher);
    expect(await reopened.loadPending(alice.ownerId)).toEqual([]);
    reopened.close();
  });

  it("owner_cannot_read_other_owner (local queue)", async () => {
    const { alice, bob } = makeOwners();
    const store = openLocalStore(dbPath, testCipher());
    await store.saveCapture({ text: "Alice's private AVT idea", origin: "typed" }, alice.ownerId);

    expect(await store.loadPending(bob.ownerId)).toEqual([]);
    expect(await store.loadPending(alice.ownerId)).toHaveLength(1);
    store.close();
  });

  it("does not store the capture payload as plaintext on disk", async () => {
    const { alice } = makeOwners();
    const store = openLocalStore(dbPath, testCipher());
    await store.saveCapture({ text: "secret AVT pricing idea", origin: "dictated" }, alice.ownerId);
    store.close();

    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file)).includes("secret AVT pricing idea")).toBe(false);
    }
  });

  it("rejects input that fails the CaptureInput schema", async () => {
    const { alice } = makeOwners();
    const store = openLocalStore(dbPath, testCipher());
    await expect(store.saveCapture({ text: "   ", origin: "typed" }, alice.ownerId)).rejects.toBeInstanceOf(ZodError);
    await expect(
      store.saveCapture({ text: "ok", origin: "telepathy" } as never, alice.ownerId),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await store.loadPending(alice.ownerId)).toEqual([]);
    store.close();
  });
});

describe("local evidence outbox", () => {
  it("evidence_survives_restart_encrypted_and_deduped", async () => {
    const { alice, bob } = makeOwners();
    const cipher = testCipher();
    const evidence = makeEvidence(alice.ownerId, [makeProjects(alice.ownerId).avt.id], {
      externalId: "plans/avt.md",
      version: "hash-1",
      text: "secret AVT build order",
    });

    const first = openLocalStore(dbPath, cipher);
    expect(await first.enqueueEvidence(evidence, alice.ownerId)).toBe(true);
    // Same source + externalId + version (e.g. an atomic-save double event) is a no-op.
    expect(await first.enqueueEvidence({ ...evidence, receivedAt: new Date().toISOString() }, alice.ownerId)).toBe(false);
    await expect(first.enqueueEvidence(evidence, bob.ownerId)).rejects.toThrow("owner");
    first.close();

    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file)).includes("secret AVT build order")).toBe(false);
    }

    const reopened = openLocalStore(dbPath, cipher);
    expect(await reopened.loadOutbox(alice.ownerId)).toEqual([evidence]);
    expect(await reopened.loadOutbox(bob.ownerId)).toEqual([]);
    expect(await reopened.enqueueEvidence({ ...evidence, version: "hash-2" }, alice.ownerId)).toBe(true);

    expect(await reopened.discardSource(bob.ownerId, evidence.sourceId)).toBe(0);
    expect(await reopened.discardSource(alice.ownerId, evidence.sourceId)).toBe(2);
    expect(await reopened.loadOutbox(alice.ownerId)).toEqual([]);
    reopened.close();
  });
});

describe("local source grants", () => {
  const grantOf = (ownerId: OwnerId, overrides: Partial<SourceGrant> = {}): SourceGrant => ({
    id: SourceIdSchema.parse("source-vault"),
    ownerId,
    kind: "obsidian",
    selectors: ["/Users/illustrative/private-vault"],
    projectIds: [ProjectIdSchema.parse("project-avt")],
    read: true,
    writeTargets: [],
    cloudProcessing: false,
    version: 1,
    state: "active",
    ...overrides,
  });

  it("grant_survives_restart_encrypted_and_owner_scoped", async () => {
    const { alice, bob } = makeOwners();
    const cipher = testCipher();
    const first = openLocalStore(dbPath, cipher);
    await first.saveGrant({ grant: grantOf(alice.ownerId), mirroredVersion: null });
    await first.saveGrant({ grant: grantOf(alice.ownerId, { version: 2, state: "revoked" }), mirroredVersion: 1 });
    first.close();

    // The selected path is private: never on disk in plaintext.
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file)).includes("private-vault")).toBe(false);
    }
    const reopened = openLocalStore(dbPath, cipher);
    expect(await reopened.loadGrants(alice.ownerId)).toEqual([
      { grant: grantOf(alice.ownerId, { version: 2, state: "revoked" }), mirroredVersion: 1 },
    ]);
    expect(await reopened.loadGrants(bob.ownerId)).toEqual([]);
    reopened.close();
  });

  it("synced evidence leaves the outbox and is not queued again", async () => {
    const { alice } = makeOwners();
    const store = openLocalStore(dbPath, testCipher());
    const evidence = makeEvidence(alice.ownerId, [makeProjects(alice.ownerId).avt.id]);
    expect(await store.enqueueEvidence(evidence, alice.ownerId)).toBe(true);
    await store.markSynced(evidence, alice.ownerId);
    expect(await store.loadOutbox(alice.ownerId)).toEqual([]);
    // A rescan after restart re-emits unchanged notes; they were already handed off.
    expect(await store.enqueueEvidence({ ...evidence, receivedAt: new Date().toISOString() }, alice.ownerId)).toBe(false);
    expect(await store.loadOutbox(alice.ownerId)).toEqual([]);
    store.close();
  });
});

describe("local artifact drafts", () => {
  const projectId = ProjectIdSchema.parse("project-ai-guides");
  const draftOf = (ownerId: OwnerId, overrides: Partial<Artifact> = {}): Artifact => ({
    id: "artifact-ai-guides" as ArtifactId,
    ownerId,
    projectId,
    revision: "3" as RevisionId,
    text: "secret offline run-through edit",
    userEdited: true,
    evidenceIds: [],
    ...overrides,
  });

  it("crash_offline_preserves_acknowledged_draft", async () => {
    const { alice, bob } = makeOwners();
    const cipher = testCipher();
    const crashed = openLocalStore(dbPath, cipher);
    await crashed.saveDraft(draftOf(alice.ownerId, { text: "first edit" }), alice.ownerId);
    await crashed.saveDraft(draftOf(alice.ownerId), alice.ownerId);
    // No close(): the process dies with the handle open and the WAL not checkpointed.

    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file)).includes("secret offline run-through edit")).toBe(false);
    }
    const restarted = openLocalStore(dbPath, cipher);
    expect(await restarted.loadDraft("artifact-ai-guides" as ArtifactId, alice.ownerId)).toEqual(draftOf(alice.ownerId));
    expect(await restarted.loadDraft("artifact-ai-guides" as ArtifactId, bob.ownerId)).toBeNull();
    await expect(restarted.saveDraft(draftOf(alice.ownerId), bob.ownerId)).rejects.toThrow("owner");
    await expect(restarted.saveDraft({ ...draftOf(alice.ownerId), revision: "" } as Artifact, alice.ownerId)).rejects.toBeInstanceOf(
      ZodError,
    );
    restarted.close();
    crashed.close();
  });
});
