// Electron main process: window lifecycle, app:// protocol, IPC wiring, encrypted local store, sign-in.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { app, BrowserWindow, dialog, ipcMain, net, powerMonitor, protocol, safeStorage, screen, session, shell } from "electron";
import { api } from "../../../../convex/_generated/api";
import { watchAiContext } from "./ai-context";
import { authConfigFromEnv, createAuth, type SecretVault } from "./auth";
import { createHandoff } from "./cloud-handoff";
import { createIpcRouter, IPC_CHANNELS } from "./ipc";
import { aesGcmCipher, openLocalStore, type LocalStore } from "./local-store";
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
function createWindows() {
  let main: BrowserWindow | null = null;
  let pet: BrowserWindow | null = null;
  let panel: BrowserWindow | null = null;
  let panelReady: Promise<void> | null = null;
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
    shown.once("ready-to-show", () => shown.showInactive());
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
    win.on("blur", () => win.hide());
    panel = win;
    panelReady = new Promise((done) => win.once("ready-to-show", () => done()));
    return { win, ready: panelReady };
  };

  return {
    openMain,
    openPet,
    hasMain: () => live(main),
    async openPanel(projectId?: string) {
      const { win, ready } = ensurePanel();
      await ready;
      const { workArea } = screen.getPrimaryDisplay();
      const anchor = live(pet) && pet.isVisible() ? pet.getBounds() : null;
      const x = anchor ? anchor.x + anchor.width - SIZES.panel.width : workArea.x + workArea.width - SIZES.panel.width - 24;
      const y = anchor ? anchor.y - SIZES.panel.height - 8 : workArea.y + workArea.height - SIZES.panel.height - 24;
      win.setPosition(Math.max(workArea.x, x), Math.max(workArea.y, y));
      win.webContents.send("panel:show", projectId ?? null);
      win.show(); // the user clicked the pet: the panel may take focus
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
      if (live(panel)) panel.hide();
    },
    setPetVisible(visible: boolean) {
      if (!live(pet)) return;
      if (visible) pet.showInactive();
      else pet.hide();
    },
  };
}

let store: LocalStore | undefined;

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

async function start(): Promise<void> {
  // No renderer permission (camera, mic, notifications, ...) is granted implicitly.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
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

  const sources = createLocalSources({
    // The only way a path enters the app: the user picks it in the OS dialog.
    async pickPath() {
      const win = BrowserWindow.getFocusedWindow();
      const options = { properties: ["openDirectory", "openFile"] as ("openDirectory" | "openFile")[] };
      const picked = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
    start: async (grant, emit, options) =>
      grant.kind === "obsidian" ? watchSelected(grant, emit, options) : watchAiContext(grant, emit, options),
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

  /** App start and sign-in: bring back this owner's selected sources, then hand off what is pending. */
  const resumeOwner = async () => {
    const owner = auth.currentOwner();
    if (owner) await sources.restore(owner);
    void handoff.trigger();
  };
  await resumeOwner();

  // Events missed while the Mac slept are picked up by one reconcile on wake (an OS event, not a timer).
  powerMonitor.on("resume", () => {
    sources.reconcileAll();
    void handoff.trigger();
  });

  const windows = createWindows();
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
  });
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, (event, payload: unknown) =>
      router.handle(channel, { frameUrl: event.senderFrame?.url }, payload),
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

app.on("will-quit", () => store?.close());
