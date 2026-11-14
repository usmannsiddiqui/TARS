import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { aesGcmCipher, openLocalStore, type Cipher } from "../../apps/desktop/src/main/local-store";
import { makeOwners } from "../fixtures";

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
