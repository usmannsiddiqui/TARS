// T7: one companion, the pet and its panel, progressive setup.
// Packaged-app tests drive the real app. No real sign-in exists yet, so a session is seeded and the
// cloud never confirms it: anything needing live cloud projects runs against the TEST-ONLY harness
// (tests/e2e/harness), which mounts the same presentational screens with illustrative props.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { freshProfile, launch, SHOTS, signedInProfile, startHarness, windowFor, type Harness } from "./packaged";

type Bridge = {
  listSources(): Promise<{ id: string; state: string; cloudProcessing: boolean }[]>;
  chooseSource(kind: string, projectIds: string[]): Promise<{ id: string; name: string } | null>;
};
const listSources = (page: Page) => page.evaluate(() => (globalThis as unknown as { companion: Bridge }).companion.listSources());

let harness: Harness;
test.beforeAll(async () => {
  harness = await startHarness();
});
test.afterAll(async () => {
  await harness?.close();
});
const scene = (name: string, options?: Parameters<Harness["open"]>[1]) => harness.open(name, options);
const calls = (page: Page) => page.evaluate(() => (globalThis as unknown as { __calls: unknown[][] }).__calls);
const focused = (page: Page) => page.locator("*:focus");
const style = (page: Page, selector: string, property: string) =>
  page.locator(selector).first().evaluate((el, property) => el.ownerDocument.defaultView.getComputedStyle(el)[property] as string, property);

/** Presses Tab until the focused element has this accessible text; fails after `limit` presses. */
async function tabTo(page: Page, text: string | RegExp, limit = 40) {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    const label = await focused(page).evaluate((el) => String(el.getAttribute("aria-label") ?? el.labels?.[0]?.textContent ?? el.textContent ?? "").trim());
    if (typeof text === "string" ? label === text : text.test(label)) return;
  }
  throw new Error(`Never reached ${String(text)} with Tab`);
}

test("one_companion_across_projects", async () => {
  const page = await scene("today");
  // One identity: a single companion name, no roster of agents.
  await expect(page.getByRole("navigation", { name: "Companion" })).toBeVisible();
  await expect(page.locator(".wordmark")).toHaveCount(1);
  // Four project contexts side by side.
  const rail = page.getByRole("list", { name: "Projects" });
  await expect(rail.getByRole("button")).toHaveText(["AI GuidesFocus", "AVT", "Personal projects", "CourseworkNeeds retry"]);
  // Exactly one recommended start, with its reason, and exactly one amber action on the screen.
  const start = page.getByRole("region", { name: "Recommended start" });
  await expect(start).toContainText("AI Guides");
  await expect(start).toContainText("Why this one: You chose AI Guides last, and prepared work is ready.");
  await expect(page.locator(".primary")).toHaveCount(1);
  await expect(start.getByRole("button", { name: "Help me start" })).toBeVisible();
  await expect(start.getByRole("button", { name: "Improve content first" })).toBeVisible();
  // Alternatives and the full backlog stay reachable.
  const others = page.getByRole("region", { name: "Other ways to start" });
  for (const name of ["AVT", "Personal projects", "Coursework"]) await expect(others.getByRole("button", { name: `Open ${name}` })).toBeVisible();
  await page.getByText("All open work").click();
  await expect(page.getByRole("region", { name: "Open work in Coursework" })).toContainText("Reading response 4");

  // Looking at another project does not change focus; only an explicit pick does.
  await others.getByRole("button", { name: "Open AVT" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("AVT");
  await expect(page.getByText("Not your focus.")).toBeVisible();
  expect(await calls(page)).toEqual([]);
  await page.getByRole("button", { name: "Work on this now" }).click();
  expect(await calls(page)).toEqual([["switchProject", { targetProjectId: "avt", userInitiated: true }]]);
  await expect(page.getByText("Your focus")).toBeVisible();
  await page.close();
});

test("first_value_before_all_connections", async () => {
  const userData = await signedInProfile();
  try {
    const app = await launch(userData);
    const page = await windowFor(app, "");
    // No source is connected, and capture still works: keyboard only.
    expect(await listSources(page)).toEqual([]);
    await page.locator("body").focus();
    await tabTo(page, "Capture an idea");
    await page.keyboard.type("Personal project: budget tracker for the band");
    await page.keyboard.press("Meta+Enter");
    await expect(page.getByRole("status").filter({ hasText: "Saved on this Mac" })).toHaveText("Saved on this Mac: Personal project: budget tracker for the band");
    await expect(page.getByRole("list", { name: "Captured ideas" }).getByRole("listitem")).toHaveText(["Personal project: budget tracker for the band"]);
    // The cloud state is said plainly, never shown as an empty project list.
    await expect(page.getByRole("region", { name: "Recommended start" })).toContainText(/Connecting to the cloud|Cloud unreachable|Checking your sign-in|did not accept/);
    await app.close();
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("optional_connections_start_off", async () => {
  const userData = await signedInProfile();
  const vault = realpathSync(mkdtempSync(join(tmpdir(), "companion-e2e-vault-")));
  writeFileSync(join(vault, "plan.md"), "Illustrative note: AVT build order.");
  try {
    const app = await launch(userData);
    const page = await windowFor(app, "");
    await page.getByRole("navigation", { name: "Companion" }).getByRole("button", { name: "Connections" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connections");
    await expect(page.getByText("All off. You can capture ideas and plan without any of them.")).toBeVisible();
    const states = await page.locator(".source-state").allTextContents();
    expect(states.length).toBeGreaterThanOrEqual(10);
    expect(new Set(states)).toEqual(new Set(["Off"]));
    expect(await listSources(page)).toEqual([]);

    // Add a folder (the OS picker is replaced in the main process only; no path crosses IPC).
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, vault);
    await page.evaluate(() => (globalThis as unknown as { companion: Bridge }).companion.chooseSource("obsidian", ["project-avt"]));
    await page.getByRole("button", { name: "Today" }).click();
    await page.getByRole("button", { name: "Connections" }).click();
    const row = page.getByRole("listitem").filter({ hasText: `Notes folder: ${basename(vault)}` });
    await expect(row).toContainText("Cloud processing: off, stays on this Mac");

    // Consent wording comes before cloud processing; declining keeps it local.
    await row.getByRole("button", { name: "Turn on cloud processing…" }).click();
    await expect(row.getByRole("group", { name: /Cloud processing for/ })).toContainText(
      `Only the items you select from Notes folder: ${basename(vault)} are read. Excerpts are sent to our cloud and to OpenAI`,
    );
    await row.getByRole("button", { name: "Keep it on this Mac" }).click();
    expect((await listSources(page))[0]?.cloudProcessing).toBe(false);
    await row.getByRole("button", { name: "Turn on cloud processing…" }).click();
    await row.getByRole("button", { name: "Turn on cloud processing", exact: true }).click();
    await expect(row).toContainText("Cloud processing: on");
    expect((await listSources(page))[0]?.cloudProcessing).toBe(true);
    await app.close();
  } finally {
    rmSync(userData, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  }
});

test("panel_opens_without_focus_stealing_notification", async () => {
  const userData = freshProfile();
  try {
    const app = await launch(userData);
    await windowFor(app, "");
    await app.evaluate(({ app, Notification }) => {
      const g = globalThis as unknown as { __focus: string[]; __notifications: number };
      g.__focus = [];
      g.__notifications = 0;
      app.on("browser-window-focus", (_event, win) => g.__focus.push(new URL(win.webContents.getURL()).hash || "app"));
      const show = Notification.prototype.show;
      Notification.prototype.show = function (this: Electron.Notification) {
        g.__notifications++;
        show.call(this);
      };
    });
    const log = () => app.evaluate(() => globalThis as unknown as { __focus: string[]; __notifications: number }).then((g) => ({ focus: g.__focus, notifications: g.__notifications }));
    const windowState = (hash: string) =>
      app.evaluate(({ BrowserWindow }, hash) => {
        const win = BrowserWindow.getAllWindows().find((w) => (new URL(w.webContents.getURL()).hash || "") === hash);
        return win && { focusable: win.isFocusable(), focused: win.isFocused(), visible: win.isVisible(), onTop: win.isAlwaysOnTop() };
      }, hash);

    // The pet is shown without taking focus and can never take it.
    const pet = await windowFor(app, "#pet");
    await expect.poll(() => windowState("#pet")).toEqual({ focusable: false, focused: false, visible: true, onTop: true });
    // No panel exists until the user asks for it.
    expect(await windowState("#panel")).toBeUndefined();

    // A user click opens the panel with context, one next action and "Open app".
    await pet.getByRole("button", { name: /^Open companion panel\. (Idle|Working|Done)\.$/ }).click();
    const panel = await windowFor(app, "#panel");
    await expect.poll(async () => (await windowState("#panel"))?.visible).toBe(true);
    await expect(panel.getByRole("button", { name: "Open app" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Stop for now" })).toBeVisible();
    await expect(panel.getByRole("heading", { level: 1 })).toHaveText("No project chosen");
    await expect(panel.getByText("Not signed in")).toBeVisible();

    // Escape closes it; "Open app" brings the full app forward, again only because the user asked.
    await panel.keyboard.press("Escape");
    await expect.poll(async () => (await windowState("#panel"))?.visible).toBe(false);
    await pet.getByRole("button", { name: /^Open companion panel/ }).click();
    await expect.poll(async () => (await windowState("#panel"))?.visible).toBe(true);
    await panel.getByRole("button", { name: "Open app" }).click();
    await expect.poll(async () => (await windowState("#panel"))?.visible).toBe(false);
    await expect.poll(async () => (await windowState(""))?.visible).toBe(true);

    const { focus, notifications } = await log();
    expect(notifications).toBe(0);
    expect(focus).not.toContain("#pet");
    await app.close();
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("keyboard-only main path with visible focus", async () => {
  const page = await scene("today");
  await page.locator("body").focus();
  await tabTo(page, "Help me start");
  expect(await style(page, "*:focus", "outlineStyle")).toBe("solid");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("AI Guides");
  // Help me start lands focus on the one small step.
  await expect(page.locator(".step")).toBeFocused();
  await expect(page.locator(".step")).toHaveText("Open slides 9–18 and time the demo section against 25 minutes.");
  // Ask for a revision, then undo it, without a mouse.
  await tabTo(page, "Tell me what to change");
  await page.keyboard.type("Make the demo shorter");
  await tabTo(page, "Revise");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Changed: Shortened the live demo to 7 minutes.");
  await page.getByRole("status").getByRole("button", { name: "Undo" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Restored revision 3.");
  expect((await calls(page)).map((c) => c[0])).toEqual(["revise", "undo"]);
  // How to stop is always one key path away.
  await page.locator("body").focus();
  await tabTo(page, "Stop for now");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stopped for now.");
  await page.close();
});

test("reduced motion: nothing travels and states still read by words and shape", async () => {
  const page = await scene("today", { reducedMotion: "reduce" });
  const durations = await Promise.all([".primary", ".secondary", ".screen", ".rail-item"].map((s) => style(page, s, "transitionDuration")));
  expect(new Set(durations.flatMap((d) => d.split(", ")))).toEqual(new Set(["0s"]));
  await page.close();
  for (const state of ["idle", "working", "done"] as const) {
    const pet = await scene(`pet-${state}`, { reducedMotion: "reduce", size: { width: 104, height: 124 } });
    await expect(pet.getByRole("button")).toHaveAccessibleName(`Open companion panel. ${{ idle: "Idle", working: "Working", done: "Done" }[state]}.`);
    const marks = await pet.locator(".pet-mark > *").count();
    expect(marks).toBe(state === "working" ? 3 : 1);
    await pet.close();
  }
});

test("ui_shots", async () => {
  mkdirSync(SHOTS, { recursive: true });
  // Harness renders (ILLUSTRATIVE props), at the real window sizes.
  for (const name of ["today", "project", "memory", "connections"]) {
    const page = await scene(name);
    await page.screenshot({ path: join(SHOTS, `harness-${name}-1200x800.png`) });
    await page.close();
  }
  for (const name of ["panel", "panel-done"]) {
    const page = await scene(name, { size: { width: 360, height: 420 } });
    await page.screenshot({ path: join(SHOTS, `harness-${name}-360x420.png`) });
    await page.close();
  }
  for (const state of ["idle", "working", "done"]) {
    const page = await scene(`pet-${state}`, { size: { width: 104, height: 124 } });
    await page.addStyleTag({ content: "html { background: #3a3f46 !important }" }); // stand-in desktop behind the transparent window
    await page.screenshot({ path: join(SHOTS, `harness-pet-${state}-104x124.png`) });
    await page.close();
  }
  // Live packaged app with a seeded (unconfirmed) session.
  const userData = await signedInProfile();
  try {
    const app = await launch(userData);
    const page = await windowFor(app, "");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Today");
    await page.screenshot({ path: join(SHOTS, "live-today-1200x800.png") });
    await page.getByRole("button", { name: "Connections" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connections");
    await page.screenshot({ path: join(SHOTS, "live-connections-1200x800.png") });
    await app.close();
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
