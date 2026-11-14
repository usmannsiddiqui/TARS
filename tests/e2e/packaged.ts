// Shared helpers for driving the PACKAGED app (run `pnpm package:mac` first) and the test-only harness.
import { mkdtempSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

const repo = join(import.meta.dirname, "../..");
const desktop = join(repo, "apps/desktop");
export const executablePath = join(desktop, "release/mac-arm64/Companion.app/Contents/MacOS/Companion");
/** Review screenshots (git-ignored). */
export const SHOTS = join(repo, "research-assets/ui-shots");

export const freshProfile = () => realpathSync(mkdtempSync(join(tmpdir(), "companion-e2e-")));
export const launch = (userData: string) => electron.launch({ executablePath, args: [`--user-data-dir=${userData}`] });

/**
 * Writes a session file through the app's own safeStorage, exactly as a completed sign-in would.
 * Live Auth0 sign-in is not exercised (no tenant yet); the illustrative owner is not a real account,
 * so the cloud honestly rejects or never confirms it.
 */
export async function seedSession(app: ElectronApplication) {
  await app.evaluate(async ({ app, safeStorage }) => {
    const session = {
      ownerId: "https://illustrative.example/|alice",
      idToken: "illustrative-id-token",
      accessToken: "illustrative-access-token",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const { writeFileSync } = process.getBuiltinModule("node:fs");
    const { join } = process.getBuiltinModule("node:path");
    writeFileSync(join(app.getPath("userData"), "session.bin"), await safeStorage.encryptStringAsync(JSON.stringify(session)));
  });
}

/** A profile with a seeded session, ready for a second launch. */
export async function signedInProfile() {
  const userData = freshProfile();
  const first = await launch(userData);
  await first.firstWindow();
  await seedSession(first);
  await first.close();
  return userData;
}

/** The window showing one view: "" for the full app, "#pet" or "#panel". */
export async function windowFor(app: ElectronApplication, hash: "" | "#pet" | "#panel"): Promise<Page> {
  const matches = (page: Page) => (hash === "" ? !new URL(page.url()).hash : page.url().endsWith(hash));
  return app.windows().find(matches) ?? (await app.waitForEvent("window", { predicate: matches }));
}

type ViteServer = { listen(): Promise<unknown>; resolvedUrls: { local: string[] } | null; close(): Promise<void> };

/** Serves tests/e2e/harness with the desktop app's own Vite; the harness never enters the product bundle. */
async function serveHarness(): Promise<{ url: string; close(): Promise<void> }> {
  const require = createRequire(join(desktop, "package.json"));
  const vite = (await import(pathToFileURL(require.resolve("vite")).href)) as { createServer(config: object): Promise<ViteServer> };
  const pkg = (name: string) => realpathSync(join(desktop, "node_modules", name));
  const server = await vite.createServer({
    configFile: false,
    root: join(import.meta.dirname, "harness"),
    publicDir: join(desktop, "src/renderer/public"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] } },
    resolve: {
      alias: [
        { find: /^react-dom(\/.*)?$/, replacement: `${pkg("react-dom")}$1` },
        { find: /^react(\/.*)?$/, replacement: `${pkg("react")}$1` },
      ],
    },
    oxc: { jsx: { runtime: "automatic" } },
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("Harness server did not start");
  return { url, close: () => server.close() };
}

export type Harness = {
  /** Opens one harness scene in its own window at the given content size. */
  open(name: string, options?: { size?: { width: number; height: number }; reducedMotion?: "reduce" }): Promise<Page>;
  close(): Promise<void>;
};

/** The harness shown in plain Electron windows (the same Chromium the product runs on). */
export async function startHarness(): Promise<Harness> {
  const server = await serveHarness();
  const electronBinary = createRequire(join(desktop, "package.json"))("electron") as string;
  const app = await electron.launch({ executablePath: electronBinary, args: [join(import.meta.dirname, "harness/main.mjs")] });
  return {
    async open(name, options = {}) {
      const size = options.size ?? { width: 1200, height: 800 };
      const opened = app.waitForEvent("window");
      await app.evaluate(
        ({ BrowserWindow }, { url, size, pet }) => {
          const win = new BrowserWindow({ ...size, useContentSize: true, frame: !pet, transparent: pet, resizable: false, webPreferences: { sandbox: true, contextIsolation: true } });
          void win.loadURL(url);
        },
        { url: `${server.url}#${name}`, size, pet: name.startsWith("pet-") },
      );
      const page = await opened;
      await page.waitForLoadState("load");
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: options.reducedMotion ?? "no-preference" });
      await page.locator("#root > *").first().waitFor();
      // Entrance transitions settle before anything is asserted or photographed.
      await page.evaluate(() => Promise.all((globalThis as unknown as { document: { getAnimations(): { finished: Promise<unknown> }[] } }).document.getAnimations().map((a) => a.finished)));
      return page;
    },
    async close() {
      await app.close();
      await server.close();
    },
  };
}
