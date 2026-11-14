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
  const tokenRequests: boolean[] = [];
  const auth = {
    currentOwner: () => owner,
    async signIn() {
      signIns++;
      owner = ownerAfterSignIn;
    },
    async idToken(forceRefresh: boolean) {
      tokenRequests.push(forceRefresh);
      return owner ? "short-lived-id-token" : null;
    },
  };
  let cloudTriggers = 0;
  const cloud = {
    async trigger() {
      cloudTriggers++;
    },
  };
  const sourceCalls: unknown[][] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      sourceCalls.push([name, ...args]);
      return { name };
    };
  const sources = {
    choose: record("choose"),
    list: (...args: unknown[]) => {
      sourceCalls.push(["list", ...args]);
      return [];
    },
    pause: record("pause"),
    resume: record("resume"),
    revoke: record("revoke"),
    setCloudProcessing: record("setCloudProcessing"),
  };
  const router = createIpcRouter({ appOrigin: APP_ORIGIN, auth, store, sources, cloud });
  return { router, calls, sourceCalls, tokenRequests, signIns: () => signIns, cloudTriggers: () => cloudTriggers };
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

  it("source methods take no paths or ownerId; the main process picks the path and supplies the owner", async () => {
    const { alice } = makeOwners();
    const { router, sourceCalls } = setup(alice.ownerId);
    const projectIds = ["project-avt"];

    // The renderer can never hand the main process a path to watch.
    for (const payload of [
      { kind: "obsidian", projectIds, path: "/etc" },
      { kind: "obsidian", projectIds, selectors: ["/Users"] },
      { kind: "obsidian", projectIds, ownerId: "owner-bob" },
      { kind: "slack", projectIds },
      { kind: "obsidian", projectIds: [] },
      "/etc/passwd",
    ]) {
      await expect(router.handle("sources:choose", trusted, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    for (const channel of ["sources:pause", "sources:resume", "sources:revoke"]) {
      await expect(router.handle(channel, trusted, { sourceId: "s1", ownerId: "owner-bob" })).rejects.toBeInstanceOf(
        IpcRejected,
      );
      await expect(router.handle(channel, trusted, "/tmp/vault")).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(router.handle("sources:list", { frameUrl: "https://evil.example/" }, undefined)).rejects.toBeInstanceOf(
      IpcRejected,
    );
    expect(sourceCalls).toEqual([]);

    await router.handle("sources:choose", trusted, { kind: "claude-code", projectIds });
    await router.handle("sources:list", trusted, undefined);
    await router.handle("sources:revoke", trusted, { sourceId: "s1" });
    expect(sourceCalls).toEqual([
      ["choose", alice.ownerId, { kind: "claude-code", projectIds }],
      ["list", alice.ownerId],
      ["revoke", alice.ownerId, "s1"],
    ]);
  });

  it("hands the renderer only the short-lived ID token, through one narrow method", async () => {
    const { alice } = makeOwners();
    const { router, tokenRequests } = setup(alice.ownerId);
    for (const payload of [undefined, {}, { forceRefresh: "yes" }, { forceRefresh: false, refreshToken: true }]) {
      await expect(router.handle("auth:idToken", trusted, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(
      router.handle("auth:idToken", { frameUrl: "https://evil.example/" }, { forceRefresh: false }),
    ).rejects.toBeInstanceOf(IpcRejected);
    expect(tokenRequests).toEqual([]);

    expect(await router.handle("auth:idToken", trusted, { forceRefresh: true })).toBe("short-lived-id-token");
    expect(tokenRequests).toEqual([true]);
    expect(await setup(null).router.handle("auth:idToken", trusted, { forceRefresh: false })).toBeNull();
  });

  it("cloud consent is per source, takes no path or owner, and requires sign-in", async () => {
    const { alice } = makeOwners();
    const { router, sourceCalls } = setup(alice.ownerId);
    for (const payload of [
      { sourceId: "s1" },
      { sourceId: "s1", enabled: "true" },
      { sourceId: "s1", enabled: true, ownerId: "owner-bob" },
      { sourceId: "s1", enabled: true, selectors: ["/Users"] },
    ]) {
      await expect(router.handle("sources:setCloudProcessing", trusted, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(
      setup(null).router.handle("sources:setCloudProcessing", trusted, { sourceId: "s1", enabled: true }),
    ).rejects.toThrow("Not signed in");
    expect(sourceCalls).toEqual([]);

    await router.handle("sources:setCloudProcessing", trusted, { sourceId: "s1", enabled: true });
    expect(sourceCalls).toEqual([["setCloudProcessing", alice.ownerId, "s1", true]]);
  });

  it("back-online from the renderer only triggers a hand-off pass", async () => {
    const { alice } = makeOwners();
    const { router, cloudTriggers } = setup(alice.ownerId);
    await expect(router.handle("cloud:online", trusted, { records: [] })).rejects.toBeInstanceOf(IpcRejected);
    expect(cloudTriggers()).toBe(0);
    expect(await router.handle("cloud:online", trusted, undefined)).toBeUndefined();
    expect(cloudTriggers()).toBe(1);
  });
});
