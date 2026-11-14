import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDictation } from "../../apps/desktop/src/main/dictation";
import { aesGcmCipher, openLocalStore } from "../../apps/desktop/src/main/local-store";
import { makeOwners, makeProjects } from "../fixtures";

const MAIN = join(import.meta.dirname, "../../apps/desktop/src/main");
const source = (file: string) => readFileSync(join(MAIN, file), "utf8");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "companion-capture-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("quick capture", () => {
  test("capture_does_not_commit_or_switch", async () => {
    const { alice } = makeOwners();
    const { avt } = makeProjects(alice.ownerId);
    const store = openLocalStore(join(dir, "local.db"), aesGcmCipher(randomBytes(32)));
    try {
      const input = { text: "Idea: AVT demo by Friday?", origin: "dictated" as const, projectHint: avt.id };
      const receipt = await store.saveCapture(input, alice.ownerId);

      // A receipt is a saved idea: no commitment, ownership, deadline or focus fields.
      expect(Object.keys(receipt).sort()).toEqual(["id", "projectId", "saved", "summary"]);
      expect(receipt).toMatchObject({ saved: true, projectId: avt.id });
      // Stored exactly as given; "by Friday" did not become a dueAt.
      expect(await store.loadPending(alice.ownerId)).toEqual([input]);
    } finally {
      store.close();
    }

    // The capture path (store, cloud hand-off, dictation) has no route to focus or commitments.
    for (const file of ["local-store.ts", "cloud-handoff.ts", "dictation.ts"]) {
      expect(source(file)).not.toMatch(/switchProject|enterProject|setFocus|focus\b|commitment|dueAt/i);
    }
  });

  test("dictation_fills_editable_textbox_without_submit", async () => {
    const deps = {
      cipher: aesGcmCipher(randomBytes(32)),
      spoolDir: dir,
      startSession: vi.fn(async () => ({ recoveryId: "session000000000001" })),
      transcribe: vi.fn(async () => "draft for the textbox"),
      now: () => 0,
    };
    const dictation = createDictation(deps);
    await dictation.beginDictation();
    const result = await dictation.finishDictation(new Uint8Array([1, 2, 3]), "audio/webm");

    // The text goes back to the caller to place in the editable composer; nothing is saved or sent.
    expect(result).toEqual({ text: "draft for the textbox", recoveryId: "session000000000001" });
    expect(deps.transcribe).toHaveBeenCalledOnce();
    expect(Object.keys(deps).sort()).toEqual(["cipher", "now", "spoolDir", "startSession", "transcribe"]);
    expect(source("dictation.ts")).not.toMatch(/saveCapture|clipboard|paste|submit/i);
    // Still recoverable until the composer's own save acknowledges it.
    expect(await dictation.listRecoverable()).toHaveLength(1);
  });
});
