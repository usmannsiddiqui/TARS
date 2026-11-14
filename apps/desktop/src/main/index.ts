// Electron main process: window lifecycle, app:// protocol, IPC wiring, encrypted local store, sign-in.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, session, shell } from "electron";
import { authConfigFromEnv, createAuth, type SecretVault } from "./auth";
import { createIpcRouter, IPC_CHANNELS } from "./ipc";
import { aesGcmCipher, openLocalStore, type LocalStore } from "./local-store";

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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 640,
    title: "Companion",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  void win.loadURL(devServerUrl ?? `${appOrigin}/index.html`);
  return win;
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

  const router = createIpcRouter({ appOrigin, auth, store });
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, (event, payload: unknown) =>
      router.handle(channel, { frameUrl: event.senderFrame?.url }, payload),
    );
  }

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
