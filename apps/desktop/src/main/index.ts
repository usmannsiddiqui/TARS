// Electron main process: window lifecycle, app:// protocol, IPC wiring, encrypted local store, sign-in.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  net,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  webContents,
} from "electron";
import { z } from "zod";
import { api } from "../../../../convex/_generated/api";
import { watchAiContext } from "./ai-context";
import { startAttentionDelivery, type AttentionState } from "./attention";
import { authConfigFromEnv, createAuth, type SecretVault } from "./auth";
import { createHandoff } from "./cloud-handoff";
import { createDictation, createTranscriptionUploader } from "./dictation";
import { createIpcRouter, IPC_CHANNELS } from "./ipc";
import { appendLocalLog } from "./local-log";
import { aesGcmCipher, openLocalStore, type LocalStore } from "./local-store";
import { watchObservation } from "./observation";
import { createLogSync } from "./outcome-log";
import { createShortcut, DEFAULT_SHORTCUT } from "./shortcut";
import { createLocalSources, watchSelected } from "./source-watch";

const APP_SCHEME = "app";
const APP_HOST = "companion";
const devServerUrl = app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
const appOrigin = devServerUrl ? new URL(devServerUrl).origin : `${APP_SCHEME}://${APP_HOST}`;
const rendererDir = join(import.meta.dirname, "../renderer");

// Must run before "ready": app:// behaves like a secure, standard origin.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** Serves only files inside the built renderer directory. */
function serveRenderer(request: Request): Promise<Response> | Response {
  const url = new URL(request.url);
  if (url.host !== APP_HOST) return new Response("Not found", { status: 404 });
  const file = resolve(rendererDir, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(rendererDir + sep)) return new Response("Forbidden", { status: 403 });
  return net.fetch(pathToFileURL(file).toString());
}

/** A file whose contents are encrypted with safeStorage (macOS Keychain-protected key). */
function safeStorageFile(path: string): SecretVault {
  return {
    async read() {
      if (!existsSync(path)) return null;
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(readFileSync(path));
      if (shouldReEncrypt) writeFileSync(path, await safeStorage.encryptStringAsync(result), { mode: 0o600 });
      return result;
    },
    async write(value) {
      writeFileSync(path, await safeStorage.encryptStringAsync(value), { mode: 0o600 });
    },
  };
}

/**
 * The SQLite data key is random, generated once, and stored only wrapped by safeStorage.
 * Without OS-protected storage we refuse to store captures or tokens at all.
 */
async function loadDataKey(vault: SecretVault): Promise<Buffer> {
  const existing = await vault.read();
  if (existing) return Buffer.from(existing, "base64");
  const key = randomBytes(32);
  await vault.write(key.toString("base64"));
  return key;
}

/** Small, non-sensitive choices kept on this Mac: the capture shortcut and whether the pet is shown. */
const PrefsSchema = z.object({ shortcut: z.string().optional(), petVisible: z.boolean().optional() });
type Prefs = z.infer<typeof PrefsSchema>;
function prefsFile(path: string) {
  let prefs: Prefs = {};
  try {
    prefs = PrefsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // Missing or unreadable: defaults. These are conveniences, never data the user could lose.
  }
  return {
    get: () => prefs,
    set(patch: Prefs) {
      prefs = { ...prefs, ...patch };
      writeFileSync(path, JSON.stringify(prefs), { mode: 0o600 });
    },
  };
}

// Built observer helper: shipped in Resources by electron-builder; in dev, the SwiftPM release build.
const observerPath = app.isPackaged
  ? join(process.resourcesPath, "observer")
  : join(import.meta.dirname, "../../../../native/observer/.build/release/observer");

function isAppUrl(raw: string): boolean {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return `${url.protocol}//${url.host}` === appOrigin;
}

// One renderer, three views: the full app, the pet and the compact panel (chosen by the URL hash).
type View = "app" | "pet" | "panel";
const SIZES = { app: { width: 1200, height: 800 }, pet: { width: 104, height: 124 }, panel: { width: 360, height: 420 } };
const GROUND = "#141110";

function newWindow(view: View, options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...SIZES[view],
    show: false,
    ...options,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  void win.loadURL(`${devServerUrl ?? `${appOrigin}/index.html`}${view === "app" ? "" : `#${view}`}`);
  return win;
}

/**
 * Window policy: only a user action opens or focuses a window. The pet is never focusable and is
 * shown inactive; background changes reach windows as subscription updates, never as focus or a notification.
 */
function createWindows(petPref: { visible: boolean; save(visible: boolean): void }) {
  let main: BrowserWindow | null = null;
  let pet: BrowserWindow | null = null;
  let panel: BrowserWindow | null = null;
  let panelReady: Promise<void> | null = null;
  let petVisible = petPref.visible;
  // Set when the shortcut opened the panel over another app: dismissing it hands focus back to that app.
  let returnFocusOnClose = false;
  const live = (win: BrowserWindow | null): win is BrowserWindow => win !== null && !win.isDestroyed();

  const openMain = () => {
    if (live(main)) return main;
    const win = newWindow("app", { title: "Companion", minWidth: 960, minHeight: 640, backgroundColor: GROUND });
    // Launching the app is the user's action, so its window may take focus once it has painted.
    win.once("ready-to-show", () => win.show());
    main = win;
    return win;
  };

  const openPet = () => {
    const { workArea } = screen.getPrimaryDisplay();
    pet = newWindow("pet", {
      title: "Companion pet",
      x: workArea.x + workArea.width - SIZES.pet.width - 24,
      y: workArea.y + workArea.height - SIZES.pet.height - 24,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
    });
    pet.setAlwaysOnTop(true, "floating");
    pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const shown = pet;
    shown.once("ready-to-show", () => {
      if (petVisible) shown.showInactive();
    });
  };

  const ensurePanel = () => {
    if (live(panel) && panelReady) return { win: panel, ready: panelReady };
    const win = newWindow("panel", {
      title: "Companion panel",
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: GROUND,
    });
    win.on("blur", () => {
      returnFocusOnClose = false; // focus already went where the user clicked
      win.hide();
    });
    panel = win;
    panelReady = new Promise((done) => win.once("ready-to-show", () => done()));
    return { win, ready: panelReady };
  };

  return {
    openMain,
    openPet,
    hasMain: () => live(main),
    isPanelOpen: () => live(panel) && panel.isVisible(),
    /**
     * Opens the panel; `capture` (the shortcut) also asks it to show the capture box. Only the panel
     * takes focus, and nothing here starts the microphone: recording needs a Record click.
     */
    async openPanel(projectId?: string, capture = false) {
      const { win, ready } = ensurePanel();
      await ready;
      const { workArea } = screen.getPrimaryDisplay();
      const anchor = live(pet) && pet.isVisible() ? pet.getBounds() : null;
      const x = anchor ? anchor.x + anchor.width - SIZES.panel.width : workArea.x + workArea.width - SIZES.panel.width - 24;
      const y = anchor ? anchor.y - SIZES.panel.height - 8 : workArea.y + workArea.height - SIZES.panel.height - 24;
      win.setPosition(Math.max(workArea.x, x), Math.max(workArea.y, y));
      win.webContents.send("panel:show", projectId ?? null);
      if (capture) {
        returnFocusOnClose = BrowserWindow.getFocusedWindow() === null;
        win.webContents.send("capture:open");
      }
      win.show(); // a user action (pet click, shortcut, notification click): the panel may take focus
    },
    openApp(projectId?: string) {
      if (live(panel)) panel.hide();
      const win = openMain();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      const navigate = () => win.webContents.send("app:navigate", projectId ?? null);
      if (win.webContents.isLoading()) win.webContents.once("did-finish-load", navigate);
      else navigate();
    },
    closePanel() {
      if (!live(panel)) return;
      panel.hide();
      // Hiding the app (not focusing another of our windows) lets macOS return focus to the previous app.
      if (returnFocusOnClose && process.platform === "darwin") app.hide();
      returnFocusOnClose = false;
    },
    petVisible: () => petVisible,
    setPetVisible(visible: boolean) {
      petVisible = visible;
      petPref.save(visible);
      if (!live(pet)) return;
      if (visible) pet.showInactive();
      else pet.hide();
    },
  };
}

let store: LocalStore | undefined;
let stopShortcut: (() => void) | undefined;

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

async function start(): Promise<void> {
  // No renderer permission is granted implicitly. The single exception: audio-only capture for the app's
  // own frames, in a window where the user pressed Record (dictation.begin), never at startup or on the shortcut.
  const micWindows = new Set<number>();
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const types = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    const audioOnly = permission === "media" && types.length > 0 && types.every((t) => t === "audio");
    callback(audioOnly && micWindows.has(wc.id) && isAppUrl(details.requestingUrl));
  });
  protocol.handle(APP_SCHEME, serveRenderer);

  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("OS-protected storage is unavailable; captures and sign-in cannot be stored securely.");
  }
  const userData = app.getPath("userData");
  const dataKey = await loadDataKey(safeStorageFile(join(userData, "data-key.bin")));
  store = openLocalStore(join(userData, "local.db"), aesGcmCipher(dataKey));

  const auth = createAuth({
    config: authConfigFromEnv(process.env),
    openExternal: (url) => shell.openExternal(url),
    vault: safeStorageFile(join(userData, "session.bin")),
  });
  await auth.restore();

  const broadcast = (channel: string, value: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, value);
  };
  const sources = createLocalSources({
    // The only way a path enters the app: the user picks it in the OS dialog.
    async pickPath(purpose) {
      const win = BrowserWindow.getFocusedWindow();
      const options: Electron.OpenDialogOptions =
        purpose === "note"
          ? { title: "Choose the outcome log note", properties: ["openFile"], filters: [{ name: "Markdown", extensions: ["md"] }] }
          : { properties: ["openDirectory", "openFile"] };
      const picked = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
    start: async (grant, emit, options) =>
      grant.kind === "obsidian"
        ? watchSelected(grant, emit, options)
        : grant.kind === "observation"
          ? watchObservation(grant, emit, {
              spawn: () => spawn(observerPath, [], { stdio: "pipe" }),
              // Status words only (ready, permission-missing, ...): never observed text.
              onStatus: (status) => broadcast("observation:status", { sourceId: grant.id, ...status }),
            })
          : watchAiContext(grant, emit, options),
    store,
    // New evidence, a consent change or a revoke: one hand-off pass.
    onChange: () => void handoff.trigger(),
  });

  // Main-process cloud client, authenticated per call with the current (refreshed) ID token.
  const convex = new ConvexHttpClient(import.meta.env.CONVEX_URL);
  const authedConvex = async () => {
    const token = await auth.idToken(false);
    if (!token) throw new Error("Not signed in");
    convex.setAuth(token);
    return convex;
  };
  const handoff = createHandoff({
    currentOwner: () => auth.currentOwner(),
    cloud: {
      setGrant: async (grant) => void (await (await authedConvex()).mutation(api.evidence.setGrant, grant)),
      submit: async (record) => (await authedConvex()).mutation(api.localEvidence.submit, { record }),
    },
    sources,
    outbox: store,
  });

  // One live (WebSocket) client for main-process subscriptions: the cloud pushes changes, nothing is polled.
  const live = new ConvexClient(import.meta.env.CONVEX_URL);
  const logError = (what: string) => (err: unknown) => console.error(`${what} failed:`, err instanceof Error ? err.message : err);

  /** App start and sign-in: bring back this owner's selected sources, then hand off what is pending. */
  const resumeOwner = async () => {
    const owner = auth.currentOwner();
    if (owner) await sources.restore(owner);
    // (Re)authenticate the live client; its subscriptions rerun for the signed-in owner.
    live.setAuth(({ forceRefreshToken }) => auth.idToken(forceRefreshToken));
    void handoff.trigger();
  };
  await resumeOwner();

  const prefs = prefsFile(join(userData, "prefs.json"));
  const windows = createWindows({ visible: prefs.get().petVisible ?? true, save: (petVisible) => prefs.set({ petVisible }) });

  // Outcome log on this Mac: the cloud pushes the appends that are due; each is reported back.
  const logSync = createLogSync({
    grants: () => {
      const owner = auth.currentOwner();
      return owner ? sources.cloudGrants(owner).map((r) => r.grant) : [];
    },
    append: (grant, request) => appendLocalLog(grant, request),
    report: async (actionId, result) => void (await live.mutation(api.actions.reportLocalLog, { actionId, result })),
  });
  live.onUpdate(api.actions.pendingLocalLogs, {}, (items) => void logSync.handle(items).catch(logError("outcome log")), logError("log subscription"));

  // Quiet contact: at most one OS notification per prepared item, decided by the shared policy.
  const shown = new Set<Notification>(); // held until closed, so the click handler survives GC
  startAttentionDelivery({
    showNotification({ title, body }) {
      const note = new Notification({ title, body });
      shown.add(note);
      note.on("click", () => void windows.openPanel()); // the user's click opens the panel
      note.on("close", () => shown.delete(note));
      note.show();
    },
    isPanelOpen: () => windows.isPanelOpen(),
    subscribe: (onState) =>
      live.onUpdate(api.briefs.getAttentionState, {}, (state) => onState(state as AttentionState), logError("attention subscription")),
    markDelivered: async (receipt) => void (await live.mutation(api.briefs.markDelivered, receipt)),
  });

  // Waking or unlocking is a return to the Mac, never proof the user is available.
  const reportReturn = () => {
    if (auth.currentOwner()) void live.mutation(api.briefs.handleReturn, { panelOpen: windows.isPanelOpen() }).catch(logError("return"));
  };
  // Events missed while the Mac slept are picked up by one reconcile on wake (an OS event, not a timer).
  powerMonitor.on("resume", () => {
    sources.reconcileAll();
    void handoff.trigger();
    reportReturn();
  });
  powerMonitor.on("unlock-screen", reportReturn);

  const spoolDir = join(userData, "dictation");
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  const dictation = createDictation({
    cipher: aesGcmCipher(dataKey),
    spoolDir,
    startSession: () => live.mutation(api.transcription.beginDictation, {}),
    transcribe: createTranscriptionUploader({ siteUrl: import.meta.env.CONVEX_SITE_URL, getIdToken: () => auth.idToken(false) }),
    now: Date.now,
  });

  const shortcut = createShortcut(
    {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
      onTrigger: () => void windows.openPanel(undefined, true),
      save: (accelerator) => prefs.set({ shortcut: accelerator }),
    },
    prefs.get().shortcut ?? DEFAULT_SHORTCUT,
  );
  stopShortcut = () => shortcut.stop();
  const router = createIpcRouter({
    appOrigin,
    auth: {
      currentOwner: () => auth.currentOwner(),
      idToken: (forceRefresh) => auth.idToken(forceRefresh),
      async signIn() {
        await auth.signIn();
        await resumeOwner();
      },
    },
    store,
    sources,
    cloud: handoff,
    windows,
    dictation: {
      // Pressing Record is the user action that may show the macOS microphone prompt.
      async begin(senderId) {
        if (process.platform === "darwin" && !(await systemPreferences.askForMediaAccess("microphone"))) {
          return { microphone: "denied" };
        }
        await dictation.beginDictation();
        if (!micWindows.has(senderId)) {
          micWindows.add(senderId);
          webContents.fromId(senderId)?.once("destroyed", () => micWindows.delete(senderId));
        }
        return { microphone: "granted" };
      },
      finish: (audio, mime) => dictation.finishDictation(audio, mime),
      retry: (recoveryId) => dictation.retryDictation(recoveryId),
      discard: (recoveryId) => dictation.discardDictation(recoveryId),
      acknowledge: (recoveryId) => dictation.acknowledgeTranscript(recoveryId),
      listRecoverable: () => dictation.listRecoverable(),
    },
    shortcut,
    system: {
      openExternal: (url) => shell.openExternal(url),
      openAccessibilitySettings: () =>
        shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"),
    },
  });
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, (event, payload: unknown) =>
      router.handle(channel, { frameUrl: event.senderFrame?.url, senderId: event.sender.id }, payload),
    );
  }

  windows.openMain();
  windows.openPet();
  // Clicking the Dock icon is a user action: bring back the full app if it was closed.
  app.on("activate", () => {
    if (!windows.hasMain()) windows.openMain();
  });
}

app
  .whenReady()
  .then(start)
  .catch((err: unknown) => {
    dialog.showErrorBox("Companion could not start", err instanceof Error ? err.message : String(err));
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  stopShortcut?.();
  store?.close();
});
