// Drives the PACKAGED app (run `pnpm package:mac` first). Proves a capture survives quit/relaunch
// through the real safeStorage key, SQLite file and IPC path.
//
// Live Auth0 sign-in is not exercised (no tenant yet). Instead the first launch writes a session
// file through the app's own Electron safeStorage, exactly as a completed sign-in would; the
// illustrative owner below is not a real account.
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { launch as launchApp, seedSession, windowFor } from "./packaged";

// The preload bridge as these tests use it.
type Bridge = {
  chooseSource(kind: string, projectIds: string[]): Promise<{ id: string; state: string; cloudProcessing: boolean; name: string } | null>;
  listSources(): Promise<{ id: string; state: string; cloudProcessing: boolean }[]>;
};

test("capture survives quitting and relaunching the packaged app", async () => {
  const userData = realpathSync(mkdtempSync(join(tmpdir(), "companion-e2e-")));
  const launch = () => launchApp(userData);

  try {
    // Launch 1: fresh profile is honestly signed out; seed a session as a completed sign-in would.
    const first = await launch();
    expect(await first.evaluate(({ app }) => app.getPath("userData"))).toBe(userData);
    const page1 = await windowFor(first, "");
    await expect(page1.getByRole("navigation", { name: "TARS" }).getByRole("button", { name: "Sign in" })).toBeVisible();
    await seedSession(first);
    await first.close();

    // Launch 2: save one capture.
    const second = await launch();
    const page2 = await windowFor(second, "");
    await page2.getByLabel("Capture an idea").fill("AVT idea");
    await page2.getByRole("button", { name: "Save" }).click();
    await expect(page2.getByRole("status").filter({ hasText: "Saved" })).toHaveText("Saved on this Mac: AVT idea");
    await second.close();

    // Launch 3: the capture is still listed.
    const third = await launch();
    const page3 = await windowFor(third, "");
    await expect(page3.getByRole("list", { name: "Captured ideas" }).getByRole("listitem")).toHaveText(["AVT idea"]);
    await third.close();

    // The payload is encrypted at rest.
    for (const file of readdirSync(userData).filter((f) => f.startsWith("local.db"))) {
      expect(readFileSync(join(userData, file)).includes("AVT idea")).toBe(false);
    }
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a selected source survives quitting and relaunching; cloud processing starts off", async () => {
  const userData = realpathSync(mkdtempSync(join(tmpdir(), "companion-e2e-")));
  const vault = realpathSync(mkdtempSync(join(tmpdir(), "companion-e2e-vault-")));
  writeFileSync(join(vault, "plan.md"), "Illustrative note: AVT build order.");
  const launch = () => launchApp(userData);
  const cspViolations: string[] = [];

  try {
    const first = await launch();
    await windowFor(first, "");
    await seedSession(first);
    await first.close();

    // Launch 2: choose a folder. The OS picker is replaced in the main process only; no path crosses IPC.
    const second = await launch();
    const page2 = await windowFor(second, "");
    await second.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, vault);
    const chosen = await page2.evaluate(() =>
      (globalThis as unknown as { companion: Bridge }).companion.chooseSource("obsidian", ["project-avt"]),
    );
    expect(chosen).toMatchObject({ state: "active", cloudProcessing: false, name: basename(vault) });
    await second.close();

    // Launch 3: the source is restored from the encrypted store, still local-only.
    const third = await launch();
    const page3 = await windowFor(third, "");
    page3.on("console", (msg) => {
      if (msg.text().includes("Content Security Policy")) cspViolations.push(msg.text());
    });
    // Grants are restored before the window opens, so the first read already has them.
    expect(await page3.evaluate(() => (globalThis as unknown as { companion: Bridge }).companion.listSources())).toMatchObject([
      { id: chosen?.id, state: "active", cloudProcessing: false },
    ]);
    // The cloud section states where it stands; with an illustrative token it never claims an empty project list.
    const cloud = page3.getByRole("region", { name: "Recommended start" });
    await expect(cloud).toContainText(/Connecting to the cloud|Cloud unreachable|Checking your sign-in|did not accept/);
    await expect(page3.getByText("No projects yet")).toHaveCount(0);
    await third.close();
    expect(cspViolations).toEqual([]);

    // The selected path is stored encrypted, never in plaintext.
    for (const file of readdirSync(userData).filter((f) => f.startsWith("local.db"))) {
      expect(readFileSync(join(userData, file)).includes(vault)).toBe(false);
    }
  } finally {
    rmSync(userData, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});
