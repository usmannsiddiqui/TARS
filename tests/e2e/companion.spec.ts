// T7: one companion, the pet and its panel, progressive setup. T10/T11 UI: briefs, acting, completion.
// Packaged-app tests drive the real app. No real sign-in exists yet, so a session is seeded and the
// cloud never confirms it: anything needing live cloud projects runs against the TEST-ONLY harness
// (tests/e2e/harness), which mounts the same presentational screens with illustrative props.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
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
/** Today types its recommended step once; photographs wait until the sentence stands whole. */
const typed = (page: Page) => page.waitForFunction(() => !(globalThis as unknown as { CSS: { highlights: { has(n: string): boolean } } }).CSS.highlights.has("type-rest"));
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
  await expect(page.getByRole("navigation", { name: "TARS" })).toBeVisible();
  await expect(page.locator(".wordmark")).toHaveCount(1);
  // The left list: Today, then the four project contexts as two-line rows; the focus says so where the time goes.
  const nav = page.getByRole("navigation", { name: "TARS" });
  const rows = nav.locator(".row");
  await expect(rows.locator(".row-name")).toHaveText(["Today", "AI Guides", "AVT", "Personal projects", "Coursework"]);
  await expect(rows.nth(0)).toHaveAttribute("aria-current", "page");
  await expect(rows.nth(1).locator(".row-time")).toHaveText("Focus");
  await expect(rows.nth(3).locator(".row-preview")).toHaveText("Nothing prepared yet");
  await expect(rows.nth(4).locator(".row-preview")).toHaveText("Needs retry");
  // TARS stays at the front desk: the mini desk in the list and the full desk in the right pane.
  await expect(nav.locator(".desk-mini")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "TARS at the front desk" }).locator(".desk")).toBeInViewport();
  // Today is one thread: what the brief read (real counts), then the numbered list whose first item is the one
  // recommended start, with its reason and exactly one navy action on the screen.
  const thread = page.getByRole("list", { name: "Today with TARS" });
  await expect(thread.locator(".results").first().getByRole("listitem")).toHaveText([
    "Read→today's meeting",
    "Read→4 new emails",
    "Checked→1 Canvas deadline",
    "Went through→6 open commitments",
  ]);
  const items = thread.getByRole("list", { name: "Today's brief" }).getByRole("listitem");
  await expect(items).toHaveCount(5);
  await expect(items.first()).toContainText("Recommended start");
  await expect(items.first()).toContainText("AI Guides");
  await expect(thread).toContainText("Why this one: You chose this last time; nothing due sooner is backed by your sources.");
  await expect(page.locator(".primary")).toHaveCount(1);
  await expect(items.first().getByRole("button", { name: "Help me start" })).toHaveClass(/primary/);
  await expect(items.first().getByRole("button", { name: "Improve content first" })).toBeVisible();
  // The tradeoff asks with three equal choices and says nothing moves.
  await expect(thread).toContainText("Your choice is recorded once. Nothing is moved, rescheduled or sent.");

  // Looking at another project does not change focus; only an explicit pick does.
  await rows.nth(2).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("AVT");
  // Showing the brief is its delivery (panel channel, never a notification); nothing else happened.
  const shown = ["markDelivered", "morning:2026-11-14", "panel"];
  expect(await calls(page)).toEqual([shown]);
  await page.getByRole("button", { name: "Work on this now" }).click();
  expect(await calls(page)).toEqual([shown, ["switchProject", { targetProjectId: "avt", userInitiated: true }]]);
  await expect(page.getByText("Your focus")).toBeVisible();
  await page.close();
});

test("list_adds_projects_and_more_reaches_schedule_and_tars_calendar", async () => {
  const page = await scene("today");
  const nav = page.getByRole("navigation", { name: "TARS" });
  // "+" opens adding a project inline at the top of the list.
  await expect(page.getByLabel("Add a project")).toHaveCount(0);
  await nav.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Add a project").fill("Band website");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  expect((await calls(page)).at(-1)).toEqual(["createProject", "Band website"]);
  // Schedule, TARS's calendar, Connections and What I remember stay under "More".
  await nav.getByRole("button", { name: "More", expanded: false }).click();
  for (const name of ["Schedule", "TARS's calendar", "Connections", "What I remember"]) await expect(nav.getByRole("button", { name })).toBeVisible();
  // The user's schedule: meetings and real due dates by day, each with its source; never suggestions.
  await nav.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Schedule");
  await expect(page.getByRole("region", { name: "Today" })).toContainText("Venue walk-through with the AV lead");
  await expect(page.getByRole("region", { name: "Today" })).toContainText("from Outlook calendar");
  await expect(page.getByText("Suggestions are not deadlines and never appear here.")).toBeVisible();
  await expect(page.getByText("Send the final slide order to the co-presenter")).toHaveCount(0);
  // TARS's own calendar: what is scheduled, what it did, what needs a look.
  await nav.getByRole("button", { name: "TARS's calendar" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("TARS's calendar");
  await expect(page.getByRole("region", { name: "Coming up" })).toContainText("Morning brief");
  await expect(page.getByRole("region", { name: "Done on its own" })).toContainText("Prepared AI Guides");
  await expect(page.getByRole("region", { name: "Needs a look" })).toContainText("Could not prepare Coursework");
  await page.close();
  // With nothing scheduled, it says what is true instead of inventing times.
  const empty = await scene("calendar-empty");
  await expect(empty.getByRole("region", { name: "Coming up" })).toContainText("No brief is scheduled yet.");
  await expect(empty.getByRole("region", { name: "Done on its own" })).toContainText(/Nothing yet\s*Briefs, source checks and preparations appear here/);
  await empty.close();
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
    await page.getByRole("navigation", { name: "TARS" }).getByRole("button", { name: "Connections" }).click();
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
    const petButton = pet.getByRole("button", { name: /^Open companion panel\. (Idle|Working|Done)\.$/ });
    const panelVisible = async () => (await windowState("#panel"))?.visible;
    const appFocused = (await windowState(""))?.focused;

    // Resting the pointer on TARS shows the panel beside it; the app in front keeps keyboard focus.
    await petButton.hover();
    const panel = await windowFor(app, "#panel");
    await expect.poll(panelVisible).toBe(true);
    expect((await windowState("#panel"))?.focused).toBe(false);
    expect((await windowState(""))?.focused).toBe(appFocused);
    expect((await log()).focus).not.toContain("#panel");
    await expect(panel.getByRole("button", { name: "Open app" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Stop for now" })).toBeVisible();
    await expect(panel.getByRole("heading", { level: 1 })).toHaveText("Where you left off");
    await expect(panel.getByText("Not signed in")).toBeVisible();

    // Moving from the pet into the panel keeps it open; leaving both closes it a moment later.
    await pet.mouse.move(-40, -40);
    await panel.getByRole("button", { name: "Open app" }).hover();
    await panel.waitForTimeout(800);
    expect(await panelVisible()).toBe(true);
    await panel.mouse.move(-40, -40);
    await expect.poll(panelVisible).toBe(false);

    // A click pins it: it stays open after the pointer leaves, until Escape closes it.
    await petButton.click();
    await expect.poll(panelVisible).toBe(true);
    await pet.mouse.move(-40, -40);
    await pet.waitForTimeout(800);
    expect(await panelVisible()).toBe(true);
    await panel.keyboard.press("Escape");
    await expect.poll(panelVisible).toBe(false);

    // Enter on the pet opens it the same way; "Open app" brings the full app forward, only because the user asked.
    await petButton.press("Enter");
    await expect.poll(panelVisible).toBe(true);
    await panel.getByRole("button", { name: "Open app" }).click();
    await expect.poll(panelVisible).toBe(false);
    await expect.poll(async () => (await windowState(""))?.visible).toBe(true);

    const { focus, notifications } = await log();
    expect(notifications).toBe(0);
    expect(focus).not.toContain("#pet");
    await app.close();
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("pet_drags_and_its_spot_survives_a_relaunch", async () => {
  const userData = freshProfile();
  const bounds = (app: ElectronApplication, hash: string) =>
    app.evaluate(({ BrowserWindow }, hash) => {
      const win = BrowserWindow.getAllWindows().find((w) => new URL(w.webContents.getURL()).hash === hash);
      return win && { ...win.getBounds(), visible: win.isVisible() };
    }, hash);
  const spot = async (app: ElectronApplication) => {
    const b = await bounds(app, "#pet");
    return b && { x: b.x, y: b.y };
  };
  try {
    let app = await launch(userData);
    const pet = await windowFor(app, "#pet");
    await expect.poll(async () => (await bounds(app, "#pet"))?.visible).toBe(true);
    const start = (await spot(app))!;
    const button = pet.getByRole("button", { name: /^Open companion panel/ });
    const box = (await button.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await pet.mouse.move(x, y);
    await pet.mouse.down();
    await pet.mouse.move(x - 120, y - 80, { steps: 12 });
    await pet.mouse.up();
    await expect.poll(async () => {
      const at = (await spot(app))!;
      return at.x < start.x - 50 && at.y < start.y - 30;
    }).toBe(true);
    // The drag ends in a click event; it never opens the panel, nor does resting where it was dropped.
    await pet.waitForTimeout(800);
    expect((await bounds(app, "#panel"))?.visible ?? false).toBe(false);

    // Arrow keys move it too; Shift takes a bigger step.
    const dropped = (await spot(app))!;
    await button.press("ArrowRight");
    await expect.poll(() => spot(app)).toEqual({ x: dropped.x + 10, y: dropped.y });
    await button.press("Shift+ArrowDown");
    await expect.poll(() => spot(app)).toEqual({ x: dropped.x + 10, y: dropped.y + 50 });
    const saved = (await spot(app))!;
    await app.close();

    // Relaunch: TARS is where the user left it.
    app = await launch(userData);
    await windowFor(app, "#pet");
    await expect.poll(() => spot(app)).toEqual(saved);
    const corner = await app.evaluate(({ screen }) => {
      const { workArea: w } = screen.getPrimaryDisplay();
      return { x: w.x + w.width - 184 - 24, y: w.y + w.height - 212 - 24 };
    });
    await app.close();

    // A spot on a display that is no longer connected falls back to the default corner.
    const prefs = join(userData, "prefs.json");
    writeFileSync(prefs, JSON.stringify({ ...JSON.parse(readFileSync(prefs, "utf8")), petPosition: { x: -90000, y: -90000 } }));
    app = await launch(userData);
    await windowFor(app, "#pet");
    await expect.poll(() => spot(app)).toEqual(corner);
    await app.close();
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

/** Visibility and focus of each TARS window by its hash ("" is the full app), in the packaged app. */
const windowStates = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    Object.fromEntries(
      BrowserWindow.getAllWindows()
        .filter((w) => URL.canParse(w.webContents.getURL())) // a window still loading has no URL yet
        .map((w) => [new URL(w.webContents.getURL()).hash, { visible: w.isVisible(), focused: w.isFocused(), bounds: w.getBounds() }]),
    ),
  );

test("pet_drag_with_the_mouse_never_opens_the_panel_or_the_app", async () => {
  const userData = freshProfile();
  try {
    const app = await launch(userData);
    await windowFor(app, "");
    const pet = await windowFor(app, "#pet");
    await expect.poll(async () => (await windowStates(app))["#pet"]?.visible).toBe(true);
    await expect.poll(async () => (await windowStates(app))[""]?.visible).toBe(true);
    // From here on, count every time a window is shown or focused.
    await app.evaluate(({ app, BrowserWindow }) => {
      const g = globalThis as unknown as { __events: string[] };
      g.__events = [];
      const name = (w: Electron.BrowserWindow) => (URL.canParse(w.webContents.getURL()) ? new URL(w.webContents.getURL()).hash || "app" : "loading");
      app.on("browser-window-focus", (_e, w) => g.__events.push(`focus ${name(w)}`));
      for (const w of BrowserWindow.getAllWindows()) w.on("show", () => g.__events.push(`show ${name(w)}`));
      app.on("browser-window-created", (_e, w) => w.on("show", () => g.__events.push(`show ${name(w)}`)));
    });
    const events = () => app.evaluate(() => (globalThis as unknown as { __events: string[] }).__events);
    const panelVisible = async () => (await windowStates(app))["#panel"]?.visible ?? false;

    const figure = pet.getByRole("button", { name: /^Open companion panel/ });
    const box = (await figure.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    // The pointer rests on TARS first (as it does before a real press): the hover panel opens.
    await pet.mouse.move(x, y);
    await expect.poll(panelVisible).toBe(true);
    // Button down: the hover-opened panel closes at once, and a pause before moving opens nothing.
    await pet.mouse.down();
    await expect.poll(panelVisible).toBe(false);
    await pet.waitForTimeout(700);
    expect(await panelVisible()).toBe(false);
    const start = (await windowStates(app))["#pet"]!.bounds;
    for (let i = 1; i <= 8; i++) {
      await pet.mouse.move(x - 10 * i, y - 6 * i, { steps: 3 });
      if (i === 4) await pet.waitForTimeout(450); // a pause mid-drag, longer than the hover intent
      expect(await panelVisible()).toBe(false);
    }
    await pet.mouse.up();
    // Dropped with the pointer still on TARS: nothing opens, not even after the intent delay.
    await pet.waitForTimeout(900);
    expect(await panelVisible()).toBe(false);
    const end = (await windowStates(app))["#pet"]!.bounds;
    expect(end.x).toBeLessThan(start.x - 30);
    // The only window shown since the pointer arrived is the panel, once, by the hover before the press.
    // The full app was never shown or focused, and nothing took focus.
    expect(await events()).toEqual(["show #panel"]);
    // Leaving TARS and coming back is a fresh hover: the panel opens again.
    await pet.mouse.move(-40, -40);
    const back = (await figure.boundingBox())!;
    await pet.mouse.move(back.x + back.width / 2, back.y + back.height / 2);
    await expect.poll(panelVisible).toBe(true);
    await app.close();
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("pill_compose_opens_capture_pinned_and_a_transcript_lands_unsaved", async () => {
  const userData = await signedInProfile();
  try {
    const app = await launch(userData);
    await windowFor(app, "");
    const pet = await windowFor(app, "#pet");
    await expect.poll(async () => (await windowStates(app))["#pet"]?.visible).toBe(true);
    // The window grew downward for the pill; the figure keeps its 184x136 at the top.
    const petBounds = (await windowStates(app))["#pet"]!.bounds;
    expect([petBounds.width, petBounds.height]).toEqual([184, 212]);
    const compose = pet.getByRole("button", { name: "Capture an idea" });
    const voice = pet.getByRole("button", { name: "Hold to talk" });
    await expect(compose).toBeVisible();
    await expect(voice).toBeVisible();
    await expect(voice).toHaveAccessibleDescription(/Press and hold to talk.*Right Option \(⌥\)/);
    for (const b of [compose, voice]) {
      const r = (await b.boundingBox())!;
      expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(28);
      // The pill sits wholly below the figure.
      expect(r.y).toBeGreaterThanOrEqual(136);
    }
    const panelVisible = async () => (await windowStates(app))["#panel"]?.visible ?? false;

    // Compose: the panel opens pinned with the capture box focused, ready to type.
    await compose.click();
    const panel = await windowFor(app, "#panel");
    await expect.poll(panelVisible).toBe(true);
    const box = panel.getByLabel("Capture an idea");
    await expect.poll(() => box.evaluate((el) => el === el.ownerDocument.activeElement)).toBe(true);
    await pet.mouse.move(-40, -40);
    await panel.waitForTimeout(800);
    expect(await panelVisible()).toBe(true);
    await panel.keyboard.press("Escape");
    await expect.poll(panelVisible).toBe(false);

    // A finished hold to talk hands its transcript over: it lands in the editable box, caret at the end, unsaved.
    const text = "Book the venue walk-through for Thursday";
    await pet.evaluate((text) => (globalThis as unknown as { companion: { openCapture(t: object): Promise<void> } }).companion.openCapture({ text, recoveryId: "rec_e2e_0001" }), text);
    await expect.poll(panelVisible).toBe(true);
    await expect(box).toHaveValue(text);
    await expect.poll(() => box.evaluate((el) => { const t = el as unknown as { selectionStart: number; selectionEnd: number }; return [el === el.ownerDocument.activeElement, t.selectionStart, t.selectionEnd]; })).toEqual([true, text.length, text.length]);
    await expect(panel.getByRole("status").filter({ hasText: "Transcript" })).toHaveText("Transcript added. Edit it, then Save.");
    expect(await pet.evaluate(() => (globalThis as unknown as { companion: { loadPending(): Promise<unknown[]> } }).companion.loadPending())).toEqual([]);
    await app.close();
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("pet_hover_reacts_and_reduced_motion_keeps_it_still", async () => {
  const page = await scene("pet-idle", { size: { width: 184, height: 212 } });
  const figure = page.getByRole("button", { name: /^Open companion panel/ });
  await expect(figure).toHaveAttribute("data-hover", "off");
  const box = (await figure.boundingBox())!;
  // The pointer comes in at the top right: TARS turns its eyes that way and says hello.
  await page.mouse.move(box.x + box.width - 6, box.y + 6);
  await expect(figure).toHaveAttribute("data-hover", "on");
  await expect.poll(() => figure.evaluate((el) => Number(el.style.getPropertyValue("--gx")))).toBeGreaterThan(0.8);
  expect(await style(page, ".pet .head-eyes", "transform")).not.toBe("none");
  expect(await style(page, ".pet-wave[data-side='l']", "animationName")).toBe("hello-l");
  // Leaving settles it back to rest, and the frame loop stops there.
  await page.mouse.move(-40, -40);
  await expect(figure).toHaveAttribute("data-hover", "off");
  await expect.poll(() => figure.evaluate((el) => el.style.getPropertyValue("--gx"))).toBe("0.000");
  // The pill is not the figure: resting on it reports no hover, so it never opens the panel.
  const voice = page.getByRole("button", { name: "Hold to talk" });
  await voice.hover();
  await page.waitForTimeout(400);
  expect((await calls(page)).filter((c) => c[0] === "hover")).toEqual([["hover", true], ["hover", false]]);
  await page.close();

  const still = await scene("pet-idle", { size: { width: 184, height: 212 }, reducedMotion: "reduce" });
  const f = still.getByRole("button", { name: /^Open companion panel/ });
  const b = (await f.boundingBox())!;
  await still.mouse.move(b.x + b.width - 6, b.y + 6);
  await expect(f).toHaveAttribute("data-hover", "on");
  await still.waitForTimeout(300);
  // No movement: no gaze loop, no slab motion; the face on the screen opens wider instead.
  expect(await f.evaluate((el) => el.style.getPropertyValue("--gx"))).toBe("");
  for (const s of [".pet .head-eyes", ".pet-wave[data-side='l']", ".pet-wave[data-side='r']"]) expect(await style(still, s, "transform")).toBe("none");
  expect(await style(still, ".pet .pet-mark", "transform")).toMatch(/^matrix\(1\.18, 0, 0, 1\.18/);
  await still.close();
});

test("voice_hold_listens_transcribes_and_fills_capture_unsaved", async () => {
  const page = await scene("pet-idle-recording", { size: { width: 184, height: 212 } });
  const voice = page.getByRole("button", { name: "Hold to talk" });
  const status = page.locator(".pill-word");
  const r = (await voice.boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await expect(page.locator(".pet-controls")).toHaveAttribute("data-talk", "listening");
  await expect(page.getByRole("status")).toHaveText("Listening");
  await expect(voice).toHaveAccessibleName("Hold to talk");
  await page.waitForTimeout(600);
  await page.mouse.up();
  await expect(status).toHaveText("Transcribing…");
  await expect.poll(async () => (await calls(page)).some((c) => c[0] === "dictation.finish")).toBe(true);
  await page.evaluate(() => (globalThis as unknown as { __finishTranscription(): void }).__finishTranscription());
  await expect(page.locator(".pet-controls")).toHaveAttribute("data-talk", "ready");
  const made = await calls(page);
  expect(made.filter((c) => ["dictation.begin", "dictation.finish", "openCapture", "saveCapture"].includes(c[0] as string))).toEqual([
    ["dictation.begin"],
    ["dictation.finish", "audio"],
    ["openCapture", { text: "Ask the AV lead for a second wireless mic", recoveryId: "rec_illustrative" }],
  ]);
  // The voice button is not the figure: holding it neither dragged TARS nor reported a press or hover.
  expect(made.filter((c) => ["dragPet", "petPress", "hover", "openPanel"].includes(c[0] as string))).toEqual([]);
  await page.close();

  // A tap records nothing and says how to use it.
  const tap = await scene("pet-idle-recording", { size: { width: 184, height: 212 } });
  const v = tap.getByRole("button", { name: "Hold to talk" });
  await v.click();
  await expect(tap.locator(".pill-word")).toHaveText("Hold to talk");
  await tap.waitForTimeout(400);
  expect((await calls(tap)).filter((c) => c[0] === "dictation.finish" || c[0] === "openCapture")).toEqual([]);
  await tap.close();

  // The panel it opens: the transcript in the editable box, caret at the end, nothing saved.
  const panel = await scene("panel-transcript", { size: { width: 360, height: 420 } });
  const box = panel.getByLabel("Capture an idea");
  await expect(box).toHaveValue("Ask the AV lead for a second wireless mic");
  expect(await box.evaluate((el) => [el === el.ownerDocument.activeElement, (el as unknown as { selectionStart: number }).selectionStart])).toEqual([true, 41]);
  await expect(panel.getByRole("status").filter({ hasText: "Transcript" })).toHaveText("Transcript added. Edit it, then Save.");
  // Opened for capture, the whole card is in view: the box, Save and the status line.
  await expect(panel.getByRole("button", { name: "Save" })).toBeInViewport({ ratio: 1 });
  expect((await calls(panel)).filter((c) => c[0] === "saveCapture")).toEqual([]);
  await panel.close();
});

test("panel_glance_left_off_then_today_then_actions", async () => {
  const panel = await scene("panel", { size: { width: 360, height: 420 } });
  const leftOff = panel.getByRole("region", { name: "Where you left off" });
  await expect(leftOff).toContainText("AI Guides");
  await expect(leftOff).toContainText("Presenter run-through for the co-presentation");
  await expect(leftOff).toContainText("Next: Open slides 9–18 and time the demo section against 25 minutes.");
  await expect(leftOff).toContainText(/Last here \w+/);
  const today = panel.getByRole("region", { name: "Today" });
  await expect(today).toContainText("2 meetings and due dates today. Next: Rehearsal call with the co-presenter at 11:59 PM.");
  await expect(today).toContainText("Start with: Send the final slide order to the co-presenter");
  const open = panel.getByRole("button", { name: "Open app" });
  // Both actions sit above the fold of the 420px panel.
  await expect(open).toBeInViewport({ ratio: 1 });
  const stop = panel.getByRole("button", { name: "Stop for now" });
  // In this order: where you left off, today, the two actions, then quick capture.
  const tops = await Promise.all([leftOff, today, open, panel.getByLabel("Capture an idea")].map(async (l) => (await l.boundingBox())!.y));
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
  // "Open app" is the one primary action; "Stop for now" is the same size beside it.
  await expect(panel.locator(".primary")).toHaveCount(1);
  const [a, b] = [(await open.boundingBox())!, (await stop.boundingBox())!];
  expect(Math.abs(a.width - b.width)).toBeLessThan(1);
  expect(Math.abs(a.height - b.height)).toBeLessThan(1);
  await panel.close();
  // Empty states say plainly what is true.
  const empty = await scene("panel-empty", { size: { width: 360, height: 420 } });
  await expect(empty.getByRole("region", { name: "Where you left off" })).toContainText("Nothing from yesterday");
  await expect(empty.getByRole("region", { name: "Today" })).toContainText("No brief yet; the next one is at 9:00 AM");
  await empty.close();
});

test("keyboard-only main path with visible focus", async () => {
  const page = await scene("today");
  await page.locator("body").focus();
  await tabTo(page, "Help me start");
  expect(await style(page, "*:focus", "outlineStyle")).toBe("solid");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("AI Guides");
  // The project is its chat: TARS's first message is in the thread, the composer is one Tab path away.
  const thread = page.getByRole("list", { name: "Conversation with TARS" });
  await expect(thread).toContainText("Tell me what to change, or send it.");
  await tabTo(page, "Message TARS");
  await page.keyboard.type("Make the demo shorter");
  await page.keyboard.press("Enter"); // Return sends
  await expect(thread.getByRole("listitem").filter({ hasText: "Make the demo shorter" })).toHaveCount(1);
  // Help me start is the user's explicit session start; nothing else ran besides what they asked.
  expect(await calls(page)).toEqual([
    ["markDelivered", "morning:2026-11-14", "panel"],
    ["session", "start"],
    ["sendMessage", "Make the demo shorter"],
  ]);
  await page.close();
});

test("keyboard-only approval: the suggested recipient, Tab to Send it, the send followed to its receipt", async () => {
  const page = await scene("project-approval");
  const approval = page.getByRole("region", { name: "Before it goes out" });
  // Exactly what will happen is on screen before anything leaves; the recipient is a suggestion he can change.
  await expect(approval).toContainText("A Word document of “Presenter run-through for the co-presentation”, revision 3, sent as a link by email.");
  const to = approval.getByLabel("To");
  await expect(to).toHaveValue("copresenter@example.com");
  await expect(approval).toContainText("Co-presenter, who asked");
  await expect(approval).toContainText("Re: Slide order for the 20 November session");
  await to.focus();
  expect(await style(page, "*:focus", "outlineStyle")).toBe("solid");
  // An empty field cannot be sent; it says why, in words.
  await to.fill("");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(approval).toContainText("Add the address to send it to.");
  expect((await calls(page)).filter((c) => c[0] === "approve")).toEqual([]);
  await to.fill("copresenter@example.com");
  // ⌘↵ is the primary action's shortcut; it never fires from a composer with words in it.
  await page.keyboard.press("Meta+Enter");
  expect((await calls(page)).filter((c) => c[0] === "approve")).toEqual([
    ["approve", { projectId: "guides", artifactId: "art1", revision: "3", commitmentKey: "guides:send the final slide order to the co-presenter", recipient: "copresenter@example.com" }],
  ]);
  await expect(page.getByRole("status").filter({ hasText: "Checked: it arrived" })).toBeVisible();
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
    const pet = await scene(`pet-${state}`, { reducedMotion: "reduce", size: { width: 184, height: 212 } });
    await expect(pet.getByRole("button", { name: /^Open companion panel/ })).toHaveAccessibleName(`Open companion panel. ${{ idle: "Idle", working: "Working", done: "Done" }[state]}.`);
    const marks = await pet.locator(".pet-mark > *").count();
    expect(marks).toBe(state === "working" ? 3 : 1);
    await pet.close();
  }
});

// ---- T11 (harness: the brief, re-entry and session data come from Convex, which no test can sign in to).

test("morning_brief_separates_deadlines_from_suggestions", async () => {
  const page = await scene("today");
  const hard = page.getByRole("region", { name: "Meetings and deadlines" });
  await expect(hard.getByRole("listitem")).toHaveCount(3);
  await expect(hard).toContainText("Venue walk-through with the AV lead · meeting");
  // A stale source is labelled with when it was last checked, never shown as current.
  await expect(hard.getByRole("listitem").filter({ hasText: "Reading response 4" })).toContainText(/Stale.*last checked .*; may have changed/);
  await expect(page.getByRole("region", { name: "Suggested work" })).toContainText("Suggestions, not deadlines.");
  await expect(page.getByRole("region", { name: "May be out of date" })).toContainText("Canvas: last checked");
  // One tradeoff flag; the user's choice ends it and changes nothing else.
  const flag = page.getByRole("region", { name: "A new commitment competes" });
  await flag.getByRole("button", { name: "Defer the new one" }).click();
  expect((await calls(page)).at(-1)).toEqual(["resolveTradeoff", "c9", "defer"]);
  await page.close();
});

test("evening_recap_is_panel_only", async () => {
  // In the panel: shown because the user opened it, recorded as panel delivery, never an alert.
  const panel = await scene("panel-evening", { size: { width: 360, height: 420 } });
  const recap = panel.getByRole("region", { name: "Evening recap" });
  await expect(recap.getByRole("listitem")).toHaveText([
    "Done (verified): Send the final slide order to the co-presenter",
    "Done (you reported): Confirm the equipment list with the venue",
    "Parked: Run through the AI Studio demo for the co-presentation",
    "Parked: Reading response 4",
  ]);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(await calls(panel)).toEqual([["markDelivered", "evening:2026-11-14", "panel"]]);
  await panel.close();
  // In the app: the recap replaces the start; no recommended work is pushed in the evening.
  const page = await scene("today-evening");
  await expect(page.getByRole("region", { name: "Evening recap" })).toContainText("Parked: Reading response 4");
  await expect(page.getByRole("button", { name: "Help me start" })).toHaveCount(0);
  expect(await calls(page)).toEqual([["markDelivered", "evening:2026-11-14", "panel"]]);
  await page.close();
});

test("reentry_shows_one_action_and_full_backlog", async () => {
  const page = await scene("today-reentry");
  await expect(page.getByText(/^Welcome back\. Since .*Nothing was moved, deleted or sent while you were away\.$/)).toBeVisible();
  const start = page.getByRole("region", { name: "One way back in" });
  await expect(start.locator(".start-step")).toHaveText("Venue walk-through with the AV lead");
  await expect(start).toContainText("Why this one: Due today at 15:00.");
  // Exactly one manageable action.
  await expect(page.getByRole("button", { name: "Help me start" })).toHaveCount(1);
  await expect(page.locator(".primary")).toHaveCount(1);
  await expect(page.getByRole("region", { name: /What changed/ })).toContainText("and 5 more in your sources");
  await expect(page.getByRole("region", { name: "Genuinely urgent" })).toContainText("Venue walk-through with the AV lead");
  // The full backlog stays reachable: every open item in every project.
  await page.getByText("All open work").click();
  await expect(page.locator(".backlog summary .count")).toHaveText("6");
  for (const name of ["AI Guides", "AVT", "Coursework"]) await expect(page.getByRole("region", { name: `Open work in ${name}` })).toBeVisible();
  // Coming back starts nothing and does not mark the morning brief as seen.
  expect(await calls(page)).toEqual([]);
  await page.close();
});

test("the composer is docked under the thread: the last message ends above it", async () => {
  for (const [name, size] of [
    ["project-long", { width: 1200, height: 800 }],
    ["project-long", { width: 960, height: 640 }],
    ["today-sorted", { width: 1200, height: 800 }],
    ["today-sorted", { width: 960, height: 640 }],
  ] as const) {
    const page = await scene(name, { size });
    const last = await page.locator(".thread > .msg").last().boundingBox();
    const composer = await page.locator(".composer-pill").boundingBox();
    expect(last && composer && last.y + last.height <= composer.y + 0.5, `${name} ${size.width}x${size.height}`).toBe(true);
    // The recording strip appears only while recording.
    await expect(page.locator(".composer-pill .tape-window")).toBeHidden();
    await page.close();
  }
});

test("the window never scrolls: only the thread does, after a new message and at either end", async () => {
  for (const size of [
    { width: 1200, height: 800 },
    { width: 960, height: 640 },
  ]) {
    for (const name of ["today-dump", "project-long"]) {
      const page = await scene(name, { size });
      const frameHolds = async (when: string) => {
        const at = await page.evaluate(() => {
          const head = document.querySelector(".head")!.getBoundingClientRect();
          const composer = document.querySelector(".composer-pill")!.getBoundingClientRect();
          return { scroll: document.scrollingElement!.scrollTop, app: document.querySelector(".app3")!.scrollTop, headTop: head.top, composerBottom: composer.bottom, height: innerHeight };
        });
        const where = `${name} ${size.width}x${size.height} ${when}`;
        expect(at.scroll, where).toBe(0);
        expect(at.app, where).toBe(0);
        expect(at.headTop, where).toBeGreaterThanOrEqual(0);
        expect(at.headTop, where).toBeLessThan(20);
        expect(at.composerBottom, where).toBeLessThanOrEqual(at.height);
      };
      await page.locator(".composer-pill textarea").fill("Call the venue about the second mic tomorrow");
      await page.keyboard.press("Enter");
      await expect(page.locator(".thread > .msg").last()).toBeVisible();
      await frameHolds("after a new message");
      await page.locator(".chat-scroll").evaluate((el) => el.scrollTo({ top: 0 }));
      await frameHolds("thread at the top");
      await page.locator(".chat-scroll").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await frameHolds("thread at the bottom");
      await page.close();
    }
  }
});

test("stop_for_now_starts_nothing", async () => {
  const page = await scene("today");
  const session = page.getByRole("group", { name: "Work session" });
  await session.getByRole("button", { name: "Start working" }).click();
  await expect(session).toContainText("Working");
  await session.getByRole("button", { name: "Take a break" }).click();
  await session.getByRole("button", { name: "Back from break" }).click();
  const before = (await calls(page)).length;
  await session.getByRole("button", { name: "Stop for now" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stopped for now.");
  expect((await calls(page)).slice(before)).toEqual([["session", "stop"]]);
  // Coming back shows your place; it starts no session and no work.
  await page.getByRole("button", { name: "Come back" }).click();
  await expect(page.getByRole("group", { name: "Work session" }).getByRole("button", { name: "Start working" })).toBeVisible();
  expect((await calls(page)).slice(before)).toEqual([["session", "stop"]]);
  await page.close();
});

// ---- Sending from the chat (harness: thread.send and delivery.status are Convex; no test triggers a real send).

test("completion_shows_the_receipt_and_stop_equally_clear", async () => {
  const page = await scene("project-approval");
  let dialogs = 0;
  page.on("dialog", () => void dialogs++);
  const approval = page.getByRole("region", { name: "Before it goes out" });
  await approval.getByRole("button", { name: /^Send it/ }).click();
  // The send is followed in the thread to a checked receipt: who, what, the document as a link, when, checked.
  const receipt = page.getByRole("status").filter({ hasText: "Checked: it arrived" });
  await expect(receipt).toContainText("Sent to copresenter@example.com: “Re: Slide order for the 20 November session”");
  await expect(receipt.getByRole("link", { name: "AI Guides.docx" })).toHaveAttribute("href", /\/d\//);
  await expect(page.getByRole("region", { name: "Approved" })).toBeVisible();
  // The receipt and the way to stop are both on screen at once, neither behind the other.
  const stop = page.getByRole("button", { name: "Stop for now" });
  await expect(receipt).toBeInViewport();
  await expect(stop).toBeInViewport();
  expect(dialogs).toBe(0);
  // Nothing started on its own: one approval, nothing sent twice.
  expect((await calls(page)).map((c) => c[0])).toEqual(["approve"]);
  await stop.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stopped for now.");
  expect((await calls(page)).at(-1)).toEqual(["session", "stop"]);
  await page.close();
});

test("unknown_send_offers_check_again_never_a_resend", async () => {
  const page = await scene("project-unknown");
  const work = page.getByRole("region", { name: /^Not confirmed after/ });
  await expect(work).toContainText("We could not confirm this was sent. Nothing has been repeated. Check again in the app.");
  await expect(work.getByRole("button", { name: /Send/ })).toHaveCount(0);
  await work.getByRole("button", { name: "Check again" }).click();
  expect((await calls(page)).map((c) => c[0])).toEqual(["reconcileAction"]);
  await page.close();
});

test("cloud_connections_start_off_and_need_consent", async () => {
  const page = await scene("connections-fresh");
  const source = (name: string) => page.locator(".source").filter({ has: page.locator(".source-name", { hasText: new RegExp(`^${name}$`) }) });
  expect(new Set(await page.locator(".source-state").allTextContents())).toEqual(new Set(["Off"]));
  // Slack: the consent wording comes with the form, before anything is recorded.
  await source("Slack").getByRole("button", { name: "Connect Slack" }).click();
  const form = page.getByRole("form", { name: "Connect Slack" });
  await expect(form).toContainText("Only the items you select from Slack are read.");
  await expect(form).not.toContainText("Delete");
  expect(await calls(page)).toEqual([]);
  // Slack and Gmail connect through Composio's hosted sign-in: no token typed here.
  await expect(form.getByRole("textbox")).toHaveCount(1);
  await expect(form).toContainText("Composio holds your Slack sign-in for TARS");
  await form.getByLabel("Channel IDs to read, separated by commas").fill("C0123, C0456");
  await form.getByRole("button", { name: "Continue to Composio sign-in" }).click();
  expect(await calls(page)).toEqual([["connect", "slack", { projectId: "guides", selectors: ["C0123", "C0456"], writeTargets: [] }]]);
  await source("Gmail").getByRole("button", { name: "Connect Gmail" }).click();
  const gmail = page.getByRole("form", { name: "Connect Gmail" });
  await expect(gmail).toContainText("Only the items you select from Gmail are read.");
  await expect(gmail).toContainText("Composio's sign-in page opens in your browser. Composio holds your Gmail sign-in for TARS");
  // Gmail reads the inbox unless labels are chosen; choosing labels and naming none cannot continue.
  await expect(gmail.getByRole("textbox")).toHaveCount(0);
  await expect(gmail.getByRole("radio", { name: "Inbox" })).toBeChecked();
  await gmail.getByRole("radio", { name: "Only these labels" }).check();
  await expect(gmail.getByRole("button", { name: "Continue to Composio sign-in" })).toBeDisabled();
  await expect(gmail.getByRole("alert")).toContainText("Add at least one label ID");
  await gmail.getByLabel("Label IDs to read, separated by commas").fill("Label_42");
  await gmail.getByRole("button", { name: "Continue to Composio sign-in" }).click();
  expect((await calls(page)).at(-1)).toEqual(["connect", "gmail", { projectId: "guides", selectors: ["Label_42"], writeTargets: [] }]);
  await expect(source("Gmail")).toContainText("Finish in your browser. Gmail turns on here when Composio confirms it.");
  await expect(source("Gmail").locator(".source-state")).toHaveText("Off");
  // Canvas asks for one thing: its calendar feed link, and says that the link itself grants reading.
  await source("Canvas").getByRole("button", { name: "Connect Canvas" }).click();
  const canvasForm = page.getByRole("form", { name: "Connect Canvas" });
  await expect(canvasForm.getByLabel("Canvas calendar feed link")).toBeVisible();
  await expect(canvasForm).toContainText("Anyone with this link can read your Canvas calendar.");
  // Selected-app reading: off, named apps only, consent first.
  const before = (await calls(page)).length;
  await source("Selected apps").getByRole("button", { name: "Turn on Selected apps" }).click();
  const observe = page.getByRole("form", { name: "Turn on Selected apps" });
  await expect(observe).toContainText("No screenshots and no keystrokes.");
  expect((await calls(page)).length).toBe(before);
  await observe.getByLabel("Apps and sites to read, separated by commas").fill("com.apple.Notes");
  await observe.getByRole("button", { name: "Start reading these" }).click();
  expect((await calls(page)).at(-1)).toEqual(["observation.start", ["com.apple.Notes"], "guides"]);
  await page.close();
});

test("connected_sources_show_status_refresh_and_notion_webhook", async () => {
  const page = await scene("connections");
  const canvas = page.locator(".source").filter({ has: page.locator(".source-name", { hasText: /^Canvas$/ }) });
  await expect(canvas).toContainText(/Stale.*last good/);
  await canvas.getByRole("button", { name: "Refresh Canvas" }).click();
  // Pause is real now: the stored grant state changes on the backend, so it survives a reload.
  await canvas.getByRole("button", { name: "Pause" }).click();
  const notion = page.getByRole("group", { name: "Notion updates" });
  await expect(notion).toContainText("https://illustrative-deployment.convex.site/notion/events?source=notion-illustrative");
  await notion.getByRole("button", { name: "Show verification token" }).click();
  await expect(notion).toContainText("secret_illustrative_verification_token");
  // Accessibility permission missing: said plainly; System Settings opens only on the user's click.
  const observed = page.locator(".source").filter({ has: page.locator(".source-name", { hasText: /^Selected apps: Notes$/ }) });
  await expect(observed).toContainText("Missing access");
  await observed.getByRole("button", { name: "Open Accessibility settings" }).click();
  // The shortcut's conflict is reported with a way out.
  await expect(page.getByRole("region", { name: "Capture shortcut" })).toContainText("is not working: another app already uses it. Choose another.");
  expect(await calls(page)).toEqual([
    ["refresh", "canvas-illustrative"],
    ["pauseCloud", "canvas-illustrative"],
    ["revealNotionToken", "notion-illustrative"],
    ["observation.openAccessibilitySettings"],
  ]);
  await page.close();
});

test("ui_shots", async () => {
  mkdirSync(SHOTS, { recursive: true });
  // Harness renders (ILLUSTRATIVE props), at the real window sizes.
  for (const name of ["today", "project", "memory", "connections"]) {
    const page = await scene(name);
    await typed(page);
    await page.screenshot({ path: join(SHOTS, `harness-${name}-1200x800.png`) });
    await page.close();
  }
  for (const name of ["panel", "panel-done"]) {
    const page = await scene(name, { size: { width: 360, height: 420 } });
    await page.screenshot({ path: join(SHOTS, `harness-${name}-360x420.png`) });
    await page.close();
  }
  {
    const page = await scene("panel-evening", { size: { width: 360, height: 420 } });
    await page.screenshot({ path: join(SHOTS, "harness-panel-evening-360x420.png") });
    await page.close();
  }
  // T10/T11 states.
  for (const [name, file] of [
    ["today", "morning-brief"],
    ["today-reentry", "reentry"],
  ] as const) {
    const page = await scene(name, { size: { width: 1200, height: 1300 } });
    await typed(page);
    await page.screenshot({ path: join(SHOTS, `harness-${file}-1200x1300.png`) });
    await page.close();
  }
  for (const name of ["verified", "unknown"]) {
    const page = await scene(`project-${name}`);
    await page.screenshot({ path: join(SHOTS, `harness-send-${name}-1200x800.png`) });
    await page.close();
  }
  {
    const page = await scene("connections-fresh", { size: { width: 1200, height: 1700 } });
    await page.locator(".source").filter({ has: page.locator(".source-name", { hasText: /^Slack$/ }) }).getByRole("button", { name: "Connect Slack" }).click();
    await page.screenshot({ path: join(SHOTS, "harness-connections-forms-1200x1700.png") });
    await page.close();
  }
  for (const state of ["idle", "working", "done"]) {
    // Stand-in desktops behind the transparent window: light, mid and dark wallpaper.
    for (const [ground, tone] of [["#ecebe8", "light"], ["#7d8187", "mid"], ["#1d2024", "dark"]]) {
      const page = await scene(`pet-${state}`, { size: { width: 184, height: 136 } });
      await page.addStyleTag({ content: `html { background: ${ground} !important }` });
      await page.screenshot({ path: join(SHOTS, `harness-pet-${state}-${tone}-184x136.png`) });
      await page.close();
    }
  }
  // The pill under TARS: idle, hovered, listening and transcribing, over light, mid and dark stand-in desktops.
  for (const [ground, tone] of [["#ecebe8", "light"], ["#7d8187", "mid"], ["#1d2024", "dark"]]) {
    const page = await scene("pet-idle-recording", { size: { width: 184, height: 212 } });
    await page.addStyleTag({ content: `html { background: ${ground} !important }` });
    const shot = (name: string) => page.screenshot({ path: join(SHOTS, `pill-pet-${name}-${tone}.png`) });
    await shot("idle");
    const figure = page.getByRole("button", { name: /^Open companion panel/ });
    const f = (await figure.boundingBox())!;
    await page.mouse.move(f.x + f.width - 20, f.y + 20);
    await expect.poll(() => figure.evaluate((el) => el.style.getPropertyValue("--gx"))).not.toBe("");
    await page.waitForTimeout(500); // the hello has played; the gaze has settled
    await shot("hover");
    const voice = page.getByRole("button", { name: "Hold to talk" });
    const v = (await voice.boundingBox())!;
    await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
    await page.mouse.down();
    await expect(page.getByRole("status")).toHaveText("Listening");
    await page.waitForTimeout(2200);
    await shot("listening");
    await page.mouse.up();
    await expect(page.locator(".pill-word")).toHaveText("Transcribing…");
    await shot("transcribing");
    await page.close();
  }
  {
    const page = await scene("panel-transcript", { size: { width: 360, height: 420 } });
    await page.screenshot({ path: join(SHOTS, "pill-panel-transcript.png") });
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
