import { describe, expect, it } from "vitest";
import type { CaptureInput, CaptureReceipt, OwnerId } from "@companion/domain";
import { createIpcRouter, IpcRejected } from "../../apps/desktop/src/main/ipc";
import { makeOwners } from "../fixtures";

const APP_ORIGIN = "app://companion";
const trusted = { frameUrl: `${APP_ORIGIN}/index.html` };

function setup(initialOwner: OwnerId | null, ownerAfterSignIn: OwnerId | null = initialOwner) {
  let owner = initialOwner;
  let signIns = 0;
  const calls: { input: CaptureInput; ownerId: OwnerId }[] = [];
  const store = {
    async saveCapture(input: CaptureInput, ownerId: OwnerId): Promise<CaptureReceipt> {
      calls.push({ input, ownerId });
      return { id: "r1", saved: true, summary: input.text };
    },
    async loadPending(ownerId: OwnerId): Promise<CaptureInput[]> {
      return calls.filter((c) => c.ownerId === ownerId).map((c) => c.input);
    },
  };
  const auth = {
    currentOwner: () => owner,
    async signIn() {
      signIns++;
      owner = ownerAfterSignIn;
    },
  };
  const router = createIpcRouter({ appOrigin: APP_ORIGIN, auth, store });
  return { router, calls, signIns: () => signIns };
}

describe("ipc router", () => {
  it("ipc_rejects_arbitrary_path_and_origin", async () => {
    const { alice } = makeOwners();
    const { router, calls } = setup(alice.ownerId);
    const valid = { text: "AVT idea", origin: "typed" };

    // Unknown channel / method, including path-shaped ones.
    await expect(router.handle("fs:readFile", trusted, "/etc/passwd")).rejects.toBeInstanceOf(IpcRejected);
    await expect(router.handle("capture:save/../../shell", trusted, valid)).rejects.toBeInstanceOf(IpcRejected);
    await expect(router.handle("__proto__", trusted, valid)).rejects.toBeInstanceOf(IpcRejected);

    // Sender whose frame is not the app's own origin.
    for (const frameUrl of ["https://evil.example/index.html", "file:///etc/passwd", "app://companion.evil/x", "not a url"]) {
      await expect(router.handle("capture:save", { frameUrl }, valid)).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(router.handle("capture:save", { frameUrl: undefined }, valid)).rejects.toBeInstanceOf(IpcRejected);

    // Payload failing the schema, including a renderer-supplied ownerId.
    await expect(router.handle("capture:save", trusted, { text: "", origin: "typed" })).rejects.toBeInstanceOf(IpcRejected);
    await expect(
      router.handle("capture:save", trusted, { ...valid, ownerId: "owner-bob" }),
    ).rejects.toBeInstanceOf(IpcRejected);
    await expect(router.handle("capture:loadPending", trusted, { ownerId: "owner-bob" })).rejects.toBeInstanceOf(
      IpcRejected,
    );

    expect(calls).toEqual([]);
  });

  it("derives the owner from the signed-in session, never the renderer", async () => {
    const { alice } = makeOwners();
    const { router, calls } = setup(alice.ownerId);

    const receipt = await router.handle("capture:save", trusted, { text: "AVT idea", origin: "typed" });
    expect(receipt).toEqual({ id: "r1", saved: true, summary: "AVT idea" });
    expect(calls).toEqual([{ input: { text: "AVT idea", origin: "typed" }, ownerId: alice.ownerId }]);
    expect(await router.handle("capture:loadPending", trusted, undefined)).toEqual([{ text: "AVT idea", origin: "typed" }]);
  });

  it("rejects store calls when nobody is signed in instead of inventing an owner", async () => {
    const { router, calls } = setup(null);
    await expect(router.handle("capture:save", trusted, { text: "AVT idea", origin: "typed" })).rejects.toThrow(
      "Not signed in",
    );
    await expect(router.handle("capture:loadPending", trusted, undefined)).rejects.toThrow("Not signed in");
    expect(calls).toEqual([]);
  });

  it("reports an honest signed-out status and signs in only through the main process", async () => {
    const { alice } = makeOwners();
    const { router, signIns } = setup(null, alice.ownerId);
    expect(await router.handle("auth:status", trusted, undefined)).toEqual({ signedIn: false });
    await expect(router.handle("auth:signIn", trusted, { ownerId: alice.ownerId })).rejects.toBeInstanceOf(IpcRejected);
    await expect(router.handle("auth:signIn", { frameUrl: "https://evil.example/" }, undefined)).rejects.toBeInstanceOf(
      IpcRejected,
    );
    expect(signIns()).toBe(0);
    expect(await router.handle("auth:signIn", trusted, undefined)).toEqual({ signedIn: true });
    expect(signIns()).toBe(1);
  });
});
