import { describe, expect, it } from "vitest";
import type { CaptureInput, CaptureReceipt, OwnerId } from "@companion/domain";
import { DictationError } from "../../apps/desktop/src/main/dictation";
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
  const sourcesWithExtras = {
    ...sources,
    observe: record("observe"),
    deleteRetained: record("deleteRetained"),
    designateLog: record("designateLog"),
  };
  const windowCalls: unknown[][] = [];
  const windows = {
    openPanel: (projectId?: string) => void windowCalls.push(["openPanel", projectId]),
    openApp: (projectId?: string) => void windowCalls.push(["openApp", projectId]),
    closePanel: () => void windowCalls.push(["closePanel"]),
    setPetVisible: (visible: boolean) => void windowCalls.push(["setPetVisible", visible]),
    petVisible: () => false,
    dragPet: (senderId: number, dx: number, dy: number) => void windowCalls.push(["dragPet", senderId, dx, dy]),
    pointerOver: (senderId: number, over: boolean) => void windowCalls.push(["pointerOver", senderId, over]),
    petPress: (senderId: number, phase: string) => void windowCalls.push(["petPress", senderId, phase]),
    openCapture: (transcript?: { text: string; recoveryId: string }) => void windowCalls.push(["openCapture", transcript]),
  };
  const dictationCalls: unknown[][] = [];
  let finishError: unknown = null;
  const dictation = {
    begin: async (senderId: number) => {
      dictationCalls.push(["begin", senderId]);
      return { microphone: "granted" as const };
    },
    finish: async (audio: Uint8Array, mime: string) => {
      dictationCalls.push(["finish", audio.byteLength, mime]);
      if (finishError) throw finishError;
      return { text: "hello", recoveryId: "rec_12345678" };
    },
    retry: async (id: string) => {
      dictationCalls.push(["retry", id]);
      return { text: "hello", recoveryId: id };
    },
    discard: async (id: string) => void dictationCalls.push(["discard", id]),
    acknowledge: async (id: string) => void dictationCalls.push(["acknowledge", id]),
    listRecoverable: async () => [],
  };
  const shortcutCalls: string[] = [];
  const shortcut = {
    status: () => ({ accelerator: "CommandOrControl+Shift+Space", registered: true }),
    set: (accelerator: string) => {
      shortcutCalls.push(accelerator);
      return { accelerator, registered: true };
    },
  };
  const systemCalls: unknown[][] = [];
  const system = {
    openExternal: async (url: string) => void systemCalls.push(["openExternal", url]),
    openAccessibilitySettings: async () => void systemCalls.push(["openAccessibilitySettings"]),
    openMicrophoneSettings: async () => void systemCalls.push(["openMicrophoneSettings"]),
  };
  const talkKey = { status: () => ({ key: "Right Option (⌥)", state: "permission-missing" }) };
  const selfTextCalls: unknown[][] = [];
  const selfText = {
    get: () => ({ enabled: false, handle: "" }),
    set: (setting: unknown) => (selfTextCalls.push(["set", setting]), setting),
    sendTest: async (...args: unknown[]) => (selfTextCalls.push(["sendTest", ...args]), "sent"),
    sendRecap: async (...args: unknown[]) => (selfTextCalls.push(["sendRecap", ...args]), "sent"),
  };
  const router = createIpcRouter({
    appOrigin: APP_ORIGIN,
    auth,
    store,
    sources: sourcesWithExtras,
    cloud,
    windows,
    dictation,
    shortcut,
    system,
    talkKey,
    selfText,
  });
  return {
    router,
    selfTextCalls,
    calls,
    sourceCalls,
    windowCalls,
    dictationCalls,
    shortcutCalls,
    systemCalls,
    failFinishWith: (err: unknown) => void (finishError = err),
    tokenRequests,
    signIns: () => signIns,
    cloudTriggers: () => cloudTriggers,
  };
}

const untrusted = [{ frameUrl: "https://evil.example/index.html" }, { frameUrl: undefined }, { frameUrl: "app://companion.evil/x" }];

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

  it("window requests take only an optional project and work before sign-in; nothing else opens a window", async () => {
    const { router, windowCalls } = setup(null);
    for (const [channel, payload] of [
      ["window:openPanel", { projectId: "" }],
      ["window:openPanel", { projectId: "p1", focus: true }],
      ["window:openApp", { url: "https://evil.example/" }],
      ["window:openApp", "p1"],
      ["window:closePanel", { projectId: "p1" }],
      ["pet:setVisible", { visible: "no" }],
      ["pet:setVisible", undefined],
    ] as const) {
      await expect(router.handle(channel, trusted, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(router.handle("window:openApp", { frameUrl: "https://evil.example/" }, {})).rejects.toBeInstanceOf(
      IpcRejected,
    );
    expect(windowCalls).toEqual([]);

    await router.handle("window:openPanel", trusted, {});
    await router.handle("window:openApp", trusted, { projectId: "p1" });
    await router.handle("window:closePanel", trusted, undefined);
    await router.handle("pet:setVisible", trusted, { visible: false });
    expect(windowCalls).toEqual([
      ["openPanel", undefined],
      ["openApp", "p1"],
      ["closePanel"],
      ["setPetVisible", false],
    ]);
  });
});

describe("ipc router: wired routes", () => {
  const withSender = { ...trusted, senderId: 7 };

  it("dictation routes need the app origin, sign-in and strict payloads; begin is bound to the calling window", async () => {
    const { alice } = makeOwners();
    const { router, dictationCalls } = setup(alice.ownerId);
    const audio = new Uint8Array([1, 2, 3]);
    for (const sender of untrusted) {
      await expect(router.handle("dictation:begin", { ...sender, senderId: 7 }, undefined)).rejects.toBeInstanceOf(IpcRejected);
      await expect(router.handle("dictation:finish", sender, { bytes: audio, mime: "audio/webm" })).rejects.toBeInstanceOf(IpcRejected);
    }
    for (const [channel, payload] of [
      ["dictation:begin", { ownerId: "owner-bob" }],
      ["dictation:finish", { bytes: [1, 2, 3], mime: "audio/webm" }],
      ["dictation:finish", { bytes: audio, mime: "audio/webm", path: "/tmp/a.webm" }],
      ["dictation:finish", { bytes: audio }],
      ["dictation:retry", { recoveryId: "../../etc/passwd" }],
      ["dictation:discard", "/tmp/x.spool"],
      ["dictation:acknowledge", { recoveryId: "rec_12345678", ownerId: "owner-bob" }],
      ["dictation:listRecoverable", { dir: "/tmp" }],
    ] as const) {
      await expect(router.handle(channel, withSender, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    // No window identity: begin cannot be attributed to a window, so it is refused.
    await expect(router.handle("dictation:begin", trusted, undefined)).rejects.toBeInstanceOf(IpcRejected);
    await expect(setup(null).router.handle("dictation:begin", withSender, undefined)).rejects.toThrow("Not signed in");
    expect(dictationCalls).toEqual([]);

    expect(await router.handle("dictation:begin", withSender, undefined)).toEqual({ microphone: "granted" });
    expect(await router.handle("dictation:finish", withSender, { bytes: audio, mime: "audio/webm;codecs=opus" })).toEqual({
      ok: true,
      text: "hello",
      recoveryId: "rec_12345678",
    });
    await router.handle("dictation:acknowledge", withSender, { recoveryId: "rec_12345678" });
    expect(dictationCalls).toEqual([
      ["begin", 7],
      ["finish", 3, "audio/webm;codecs=opus"],
      ["acknowledge", "rec_12345678"],
    ]);
  });

  it("a failed transcription comes back as a code plus recovery id the renderer can Retry or Discard", async () => {
    const { alice } = makeOwners();
    const { router, failFinishWith } = setup(alice.ownerId);
    failFinishWith(new DictationError("transcription_failed", "rec_12345678", "network"));
    expect(await router.handle("dictation:finish", trusted, { bytes: new Uint8Array([1]), mime: "audio/webm" })).toEqual({
      ok: false,
      code: "transcription_failed",
      recoveryId: "rec_12345678",
    });
    failFinishWith(new Error("disk full"));
    await expect(router.handle("dictation:finish", trusted, { bytes: new Uint8Array([1]), mime: "audio/webm" })).rejects.toThrow(
      "disk full",
    );
  });

  it("the shortcut takes one accelerator with a modifier, from the app origin only", async () => {
    const { router, shortcutCalls } = setup(null);
    for (const payload of [{ accelerator: "Space" }, { accelerator: "" }, { accelerator: "Cmd+Shift+Space; rm -rf" }, "Cmd+K", { accelerator: "Cmd+K", global: true }]) {
      await expect(router.handle("shortcut:set", trusted, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    for (const sender of untrusted) {
      await expect(router.handle("shortcut:set", sender, { accelerator: "Alt+Shift+K" })).rejects.toBeInstanceOf(IpcRejected);
    }
    expect(shortcutCalls).toEqual([]);
    expect(await router.handle("shortcut:status", trusted, undefined)).toEqual({ accelerator: "CommandOrControl+Shift+Space", registered: true });
    expect(await router.handle("shortcut:set", trusted, { accelerator: "Alt+Shift+K" })).toEqual({ accelerator: "Alt+Shift+K", registered: true });
    expect(shortcutCalls).toEqual(["Alt+Shift+K"]);
  });

  it("texts to self: a validated own handle, a test with no recipient, from the app origin only", async () => {
    const { router, selfTextCalls } = setup(null);
    for (const payload of [
      { enabled: true, handle: "5551234567" },
      { enabled: true, handle: "+15551234567", recipient: "+15557654321" },
      { enabled: "on", handle: "+15551234567" },
      { enabled: true },
      "+15551234567",
    ]) {
      await expect(router.handle("selfText:set", trusted, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    // The test text takes no payload, so no recipient can be named.
    for (const payload of [{ handle: "+15557654321" }, "+15557654321", { text: "hi" }]) {
      await expect(router.handle("selfText:test", trusted, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    for (const sender of untrusted) {
      for (const [channel, payload] of [["selfText:get", undefined], ["selfText:set", { enabled: true, handle: "+15551234567" }], ["selfText:test", undefined]] as const) {
        await expect(router.handle(channel, sender, payload)).rejects.toBeInstanceOf(IpcRejected);
      }
    }
    expect(selfTextCalls).toEqual([]);
    expect(await router.handle("selfText:get", trusted, undefined)).toEqual({ enabled: false, handle: "" });
    await router.handle("selfText:set", trusted, { enabled: true, handle: "me@icloud.com" });
    expect(await router.handle("selfText:test", trusted, undefined)).toBe("sent");
    expect(selfTextCalls).toEqual([["set", { enabled: true, handle: "me@icloud.com" }], ["sendTest"]]);
  });

  it("recap text: three bounded lists of short titles, no recipient, from the app origin only", async () => {
    const { router, selfTextCalls } = setup(null);
    const list = (items: string[], more = 0) => ({ items, more });
    const recap = { done: list(["Sent AI Guides report, 12:41 AM"]), parked: list([]), left: list(["Q3 plan, due Mon 5:00 PM"], 2) };
    for (const payload of [
      undefined,
      { ...recap, recipient: "+15557654321" },
      { ...recap, done: list(Array.from({ length: 6 }, () => "x")) },
      { ...recap, done: list(["x".repeat(301)]) },
      { ...recap, left: list([], -1) },
      { done: recap.done, parked: recap.parked },
    ]) {
      await expect(router.handle("selfText:recap", trusted, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    for (const sender of untrusted) {
      await expect(router.handle("selfText:recap", sender, recap)).rejects.toBeInstanceOf(IpcRejected);
    }
    expect(selfTextCalls).toEqual([]);
    expect(await router.handle("selfText:recap", trusted, recap)).toBe("sent");
    expect(selfTextCalls).toEqual([["sendRecap", recap]]);
  });

  it("observation takes only bundle ids or bundle|origin selectors chosen by the user; never a path or owner", async () => {
    const { alice } = makeOwners();
    const { router, sourceCalls, systemCalls } = setup(alice.ownerId);
    const projectIds = ["project-avt"];
    for (const payload of [
      { selectors: ["/Applications/Notes.app"], projectIds },
      { selectors: ["com.apple.Notes|file:///etc"], projectIds },
      { selectors: ["com.google.Chrome|https://docs.example.com/path"], projectIds },
      { selectors: ["com.apple.Notes|https://a.example|extra"], projectIds },
      { selectors: [], projectIds },
      { selectors: ["com.apple.Notes"], projectIds: [] },
      { selectors: ["com.apple.Notes"], projectIds, ownerId: "owner-bob" },
    ]) {
      await expect(router.handle("observation:start", trusted, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(router.handle("observation:deleteRetained", trusted, { sourceId: "s1", path: "/tmp" })).rejects.toBeInstanceOf(IpcRejected);
    await expect(router.handle("observation:openAccessibilitySettings", trusted, { pane: "x-apple.systempreferences:other" })).rejects.toBeInstanceOf(IpcRejected);
    for (const sender of untrusted) {
      await expect(router.handle("observation:start", sender, { selectors: ["com.apple.Notes"], projectIds })).rejects.toBeInstanceOf(IpcRejected);
      await expect(router.handle("observation:openAccessibilitySettings", sender, undefined)).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(
      setup(null).router.handle("observation:start", trusted, { selectors: ["com.apple.Notes"], projectIds }),
    ).rejects.toThrow("Not signed in");
    expect(sourceCalls).toEqual([]);
    expect(systemCalls).toEqual([]);

    const selectors = ["com.apple.Notes", "com.google.Chrome|https://docs.example.com"];
    await router.handle("observation:start", trusted, { selectors, projectIds });
    await router.handle("observation:deleteRetained", trusted, { sourceId: "s1" });
    await router.handle("observation:openAccessibilitySettings", trusted, undefined);
    expect(sourceCalls).toEqual([
      ["observe", alice.ownerId, { selectors, projectIds }],
      ["deleteRetained", alice.ownerId, "s1"],
    ]);
    expect(systemCalls).toEqual([["openAccessibilitySettings"]]);
  });

  it("designating the log note takes only a source id: main opens the dialog and supplies the owner", async () => {
    const { alice } = makeOwners();
    const { router, sourceCalls } = setup(alice.ownerId);
    for (const payload of [{ sourceId: "s1", notePath: "/Users/a/vault/Log.md" }, { sourceId: "s1", ownerId: "owner-bob" }, "/tmp/Log.md", undefined]) {
      await expect(router.handle("logs:designate", trusted, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(router.handle("logs:designate", untrusted[0]!, { sourceId: "s1" })).rejects.toBeInstanceOf(IpcRejected);
    expect(sourceCalls).toEqual([]);
    await router.handle("logs:designate", trusted, { sourceId: "s1" });
    expect(sourceCalls).toEqual([["designateLog", alice.ownerId, "s1"]]);
  });

  it("openExternalAuth opens only Google, Microsoft or Composio sign-in pages over https", async () => {
    const { router, systemCalls } = setup(null);
    for (const url of [
      "http://accounts.google.com/o/oauth2",
      "https://accounts.google.com.evil.example/",
      "https://connect.composio.dev.evil.example/link/ln_1",
      "https://composio.dev/link/ln_1",
      "https://evil.example/?next=https://accounts.google.com/",
      "https://user@accounts.google.com/",
      "https://accounts.google.com:8443/",
      "https://login.microsoftonline.co/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
    ]) {
      await expect(router.handle("auth:openExternal", trusted, { url })).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(router.handle("auth:openExternal", untrusted[0]!, { url: "https://accounts.google.com/" })).rejects.toBeInstanceOf(IpcRejected);
    expect(systemCalls).toEqual([]);
    await router.handle("auth:openExternal", trusted, { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" });
    await router.handle("auth:openExternal", trusted, { url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize" });
    await router.handle("auth:openExternal", trusted, { url: "https://connect.composio.dev/link/ln_1" });
    expect(systemCalls).toEqual([
      ["openExternal", "https://accounts.google.com/o/oauth2/v2/auth?client_id=x"],
      ["openExternal", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"],
      ["openExternal", "https://connect.composio.dev/link/ln_1"],
    ]);
  });

  it("the persisted hide-pet choice is readable without sign-in and takes no payload", async () => {
    const { router } = setup(null);
    await expect(router.handle("pet:visible", trusted, { visible: true })).rejects.toBeInstanceOf(IpcRejected);
    await expect(router.handle("pet:visible", untrusted[0]!, undefined)).rejects.toBeInstanceOf(IpcRejected);
    expect(await router.handle("pet:visible", trusted, undefined)).toBe(false);
  });

  it("pet_drag_takes_only_bounded_integer_steps_from_a_known_window", async () => {
    const { router, windowCalls } = setup(null);
    for (const payload of [
      { dx: 1.5, dy: 0 },
      { dx: Number.NaN, dy: 0 },
      { dx: Number.POSITIVE_INFINITY, dy: 0 },
      { dx: 4001, dy: 0 },
      { dx: 0, dy: -4001 },
      { dx: "10", dy: 0 },
      { dx: 10 },
      { dx: 10, dy: 0, x: 0 },
      undefined,
    ]) {
      await expect(router.handle("pet:dragBy", withSender, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(router.handle("pet:dragBy", untrusted[0]!, { dx: 10, dy: 0 })).rejects.toBeInstanceOf(IpcRejected);
    // Main decides which window moves: a frame without a sender id moves nothing.
    await expect(router.handle("pet:dragBy", trusted, { dx: 10, dy: 0 })).rejects.toBeInstanceOf(IpcRejected);
    expect(windowCalls).toEqual([]);
    await router.handle("pet:dragBy", withSender, { dx: -4000, dy: 12 });
    expect(windowCalls).toEqual([["dragPet", 7, -4000, 12]]);
  });

  it("pointer_hover_reports_only_a_boolean_and_main_knows_the_window", async () => {
    const { router, windowCalls } = setup(null);
    for (const payload of [{ over: "yes" }, { over: true, window: "panel" }, {}, undefined]) {
      await expect(router.handle("window:hover", withSender, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(router.handle("window:hover", untrusted[0]!, { over: true })).rejects.toBeInstanceOf(IpcRejected);
    await expect(router.handle("window:hover", trusted, { over: true })).rejects.toBeInstanceOf(IpcRejected);
    await router.handle("window:hover", withSender, { over: true });
    expect(windowCalls).toEqual([["pointerOver", 7, true]]);
  });

  it("pet_press_reports_only_a_phase_from_a_known_window", async () => {
    const { router, windowCalls } = setup(null);
    for (const payload of [{ phase: "hover" }, { phase: "down", x: 1 }, { down: true }, {}, undefined]) {
      await expect(router.handle("pet:press", withSender, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(router.handle("pet:press", untrusted[0]!, { phase: "down" })).rejects.toBeInstanceOf(IpcRejected);
    await expect(router.handle("pet:press", trusted, { phase: "down" })).rejects.toBeInstanceOf(IpcRejected);
    for (const phase of ["down", "up", "dragged"]) await router.handle("pet:press", withSender, { phase });
    expect(windowCalls).toEqual([
      ["petPress", 7, "down"],
      ["petPress", 7, "up"],
      ["petPress", 7, "dragged"],
    ]);
  });

  it("open_capture_takes_an_optional_bounded_transcript_with_a_plain_recovery_id", async () => {
    const { router, windowCalls } = setup(null);
    for (const payload of [
      undefined,
      { transcript: { text: "", recoveryId: "rec_12345678" } },
      { transcript: { text: "x".repeat(50_001), recoveryId: "rec_12345678" } },
      { transcript: { text: "hello", recoveryId: "../../etc/passwd" } },
      { transcript: { text: "hello", recoveryId: "rec_12345678", save: true } },
      { transcript: { text: "hello" } },
      { projectId: "project-avt" },
    ]) {
      await expect(router.handle("capture:open", trusted, payload)).rejects.toBeInstanceOf(IpcRejected);
    }
    await expect(router.handle("capture:open", untrusted[0]!, {})).rejects.toBeInstanceOf(IpcRejected);
    await router.handle("capture:open", trusted, {});
    await router.handle("capture:open", trusted, { transcript: { text: "Book the venue walk-through", recoveryId: "rec_12345678" } });
    expect(windowCalls).toEqual([
      ["openCapture", undefined],
      ["openCapture", { text: "Book the venue walk-through", recoveryId: "rec_12345678" }],
    ]);
  });

  it("microphone_settings_and_the_talk_key_status_take_no_payload", async () => {
    const { router, systemCalls } = setup(null);
    await expect(router.handle("dictation:openMicrophoneSettings", trusted, { url: "x-apple.systempreferences:" })).rejects.toBeInstanceOf(IpcRejected);
    await expect(router.handle("dictation:openMicrophoneSettings", untrusted[0]!, undefined)).rejects.toBeInstanceOf(IpcRejected);
    await router.handle("dictation:openMicrophoneSettings", trusted, undefined);
    expect(systemCalls).toEqual([["openMicrophoneSettings"]]);
    await expect(router.handle("talk:keyStatus", trusted, {})).rejects.toBeInstanceOf(IpcRejected);
    expect(await router.handle("talk:keyStatus", trusted, undefined)).toEqual({ key: "Right Option (⌥)", state: "permission-missing" });
  });
});
