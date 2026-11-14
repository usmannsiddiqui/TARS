// Drives the PACKAGED app (run `pnpm package:mac` first). Proves a capture survives quit/relaunch
// through the real safeStorage key, SQLite file and IPC path.
//
// Live Auth0 sign-in is not exercised (no tenant yet). Instead the first launch writes a session
// file through the app's own Electron safeStorage, exactly as a completed sign-in would; the
// illustrative owner below is not a real account.
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const executablePath = join(
  import.meta.dirname,
  "../../apps/desktop/release/mac-arm64/Companion.app/Contents/MacOS/Companion",
);

test("capture survives quitting and relaunching the packaged app", async () => {
  const userData = realpathSync(mkdtempSync(join(tmpdir(), "companion-e2e-")));
  const launch = () => electron.launch({ executablePath, args: [`--user-data-dir=${userData}`] });

  try {
    // Launch 1: fresh profile is honestly signed out; seed a session as a completed sign-in would.
    const first = await launch();
    expect(await first.evaluate(({ app }) => app.getPath("userData"))).toBe(userData);
    const page1 = await first.firstWindow();
    await expect(page1.getByText("Not signed in")).toBeVisible();
    await first.evaluate(async ({ app, safeStorage }) => {
      const session = {
        ownerId: "illustrative|alice",
        idToken: "illustrative-id-token",
        accessToken: "illustrative-access-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
      const { writeFileSync } = process.getBuiltinModule("node:fs");
      const { join } = process.getBuiltinModule("node:path");
      writeFileSync(join(app.getPath("userData"), "session.bin"), await safeStorage.encryptStringAsync(JSON.stringify(session)));
    });
    await first.close();

    // Launch 2: save one capture.
    const second = await launch();
    const page2 = await second.firstWindow();
    await page2.getByLabel("Capture an idea").fill("AVT idea");
    await page2.getByRole("button", { name: "Save" }).click();
    await expect(page2.getByRole("status")).toHaveText("Saved on this Mac: AVT idea");
    await second.close();

    // Launch 3: the capture is still listed.
    const third = await launch();
    const page3 = await third.firstWindow();
    await expect(page3.getByRole("list", { name: "Pending captures" }).getByRole("listitem")).toHaveText(["AVT idea"]);
    await third.close();

    // The payload is encrypted at rest.
    for (const file of readdirSync(userData).filter((f) => f.startsWith("local.db"))) {
      expect(readFileSync(join(userData, file)).includes("AVT idea")).toBe(false);
    }
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
