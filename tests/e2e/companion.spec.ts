// T7: one companion, the pet and its panel, progressive setup. T10/T11 UI: briefs, acting, completion.
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
  // Four project contexts side by side.
  const rail = page.getByRole("list", { name: "Projects" });
  await expect(rail.getByRole("button")).toHaveText(["AI GuidesFocus", "AVT", "Personal projects", "CourseworkNeeds retry"]);
  // Exactly one recommended start, with its reason, and exactly one amber action on the screen.
  const start = page.getByRole("region", { name: "Recommended start" });
  await expect(start).toContainText("AI Guides");
  await expect(start).toContainText("Why this one: You chose this last time; nothing due sooner is backed by your sources.");
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
  // Showing the brief is its delivery (panel channel, never a notification); nothing else happened.
  const shown = ["markDelivered", "morning:2026-11-14", "panel"];
  expect(await calls(page)).toEqual([shown]);
  await page.getByRole("button", { name: "Work on this now" }).click();
  expect(await calls(page)).toEqual([shown, ["switchProject", { targetProjectId: "avt", userInitiated: true }]]);
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
  // Help me start is the user's explicit session start; nothing else ran besides what they asked.
  expect(await calls(page)).toEqual([
    ["markDelivered", "morning:2026-11-14", "panel"],
    ["session", "start"],
    ["revise", "Make the demo shorter", "3"],
    ["undo", "4", "3"],
  ]);
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
    const pet = await scene(`pet-${state}`, { reducedMotion: "reduce", size: { width: 184, height: 136 } });
    await expect(pet.getByRole("button")).toHaveAccessibleName(`Open companion panel. ${{ idle: "Idle", working: "Working", done: "Done" }[state]}.`);
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

// ---- T10 (harness: executeIntent and receipts are Convex actions; no test triggers a real send).

async function send(page: Page) {
  const act = page.getByRole("region", { name: "Send or update" });
  await act.getByLabel("Recipient email address").fill("copresenter@example.com");
  // The destination and revision are on the button before the click; the click is the approval.
  await act.getByRole("button", { name: "Send revision 3 to copresenter@example.com" }).click();
  return act;
}

test("completion_shows_done_next_and_stop_equally", async () => {
  const page = await scene("project");
  let dialogs = 0;
  page.on("dialog", () => void dialogs++);
  const act = await send(page);
  const receipt = act.getByRole("status", { name: "What happened" });
  await expect(receipt).toContainText("Sent to copresenter@example.com, verified");
  // The win above is brought into view by focus; Tab then reaches its two equal choices.
  // (activeElement, not toBeFocused: several harness windows are open, so this one may not hold OS focus.)
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { document: { activeElement: { id: string } | null } }).document.activeElement?.id)).toBe("done-h");
  await expect(receipt).toContainText("found in your sent mail with the same recipient and text");
  // The log is its own state; retrying it never sends again.
  await expect(receipt).toContainText("Outcome log not written");
  await receipt.getByRole("button", { name: "Retry log" }).click();
  await expect(receipt).toContainText("Outcome logged.");

  const done = page.getByRole("region", { name: "Done" });
  await expect(done).toContainText("Sent to copresenter@example.com, verified.");
  const buttons = done.getByRole("button");
  await expect(buttons).toHaveText(["Optional next: Run through the AI Studio demo for the co-presentation", "Stop for now"]);
  const [next, stop] = [await buttons.nth(0).boundingBox(), await buttons.nth(1).boundingBox()];
  expect(Math.abs(next!.width - stop!.width)).toBeLessThan(1);
  expect(Math.abs(next!.height - stop!.height)).toBeLessThan(1);
  expect(await buttons.nth(0).getAttribute("class")).toBe(await buttons.nth(1).getAttribute("class"));
  expect(dialogs).toBe(0);
  // Nothing started on its own.
  expect((await calls(page)).map((c) => c[0])).toEqual(["executeIntent", "appendOutcomeLog"]);
  await buttons.nth(1).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stopped for now.");
  expect((await calls(page)).at(-1)).toEqual(["session", "stop"]);
  await page.close();
});

test("unknown_send_offers_check_not_resend", async () => {
  const page = await scene("project-unknown");
  const act = await send(page);
  const receipt = act.getByRole("status", { name: "What happened" });
  await expect(receipt).toContainText("We could not confirm this was sent. Nothing has been resent.");
  await expect(receipt.getByRole("button")).toHaveText(["Check again"]);
  await expect(act.getByRole("button", { name: /^Send revision/ })).toBeDisabled();
  await expect(act).toContainText("Check the last one first. Sending again could deliver it twice.");
  await receipt.getByRole("button", { name: "Check again" }).click();
  const names = (await calls(page)).map((c) => c[0]);
  expect(names).toEqual(["executeIntent", "reconcileAction"]);
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
  await form.getByLabel("Bot token from your Slack app").fill("illustrative-not-a-token");
  await form.getByLabel("Channel IDs to read, separated by commas").fill("C0123, C0456");
  await form.getByRole("button", { name: "Connect Slack" }).click();
  expect(await calls(page)).toEqual([["connect", "slack", { projectId: "guides", selectors: ["C0123", "C0456"], writeTargets: [] }]]);
  // Gmail: no token here; Google's own page opens in the browser after the same consent wording.
  await source("Gmail").getByRole("button", { name: "Connect Gmail" }).click();
  const gmail = page.getByRole("form", { name: "Connect Gmail" });
  await expect(gmail).toContainText("Only the items you select from Gmail are read.");
  await expect(gmail).toContainText("Google's sign-in page opens in your browser. Reading only; sending is a separate permission");
  await expect(gmail.getByRole("textbox")).toHaveCount(1);
  await gmail.getByLabel("Gmail label IDs to read, separated by commas").fill("Label_42");
  await gmail.getByRole("button", { name: "Continue to Google sign-in" }).click();
  expect((await calls(page)).at(-1)).toEqual(["connect", "gmail", { projectId: "guides", selectors: ["Label_42"], writeTargets: [] }]);
  await expect(source("Gmail")).toContainText("Finish in your browser. Gmail turns on here when Google confirms it.");
  await expect(source("Gmail").locator(".source-state")).toHaveText("Off");
  // Canvas asks for its address too.
  await source("Canvas").getByRole("button", { name: "Connect Canvas" }).click();
  await expect(page.getByRole("form", { name: "Connect Canvas" }).getByLabel("Your Canvas address (https://…)")).toBeVisible();
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
  {
    const page = await scene("project");
    const act = await send(page);
    await expect(act.getByRole("status", { name: "What happened" })).toContainText("verified");
    await page.screenshot({ path: join(SHOTS, "harness-completion-1200x800.png") });
    await act.scrollIntoViewIfNeeded();
    await act.screenshot({ path: join(SHOTS, "harness-action-verified.png") });
    await page.close();
  }
  {
    const page = await scene("project-unknown");
    const act = await send(page);
    await expect(act.getByRole("status", { name: "What happened" })).toContainText("could not confirm");
    await act.screenshot({ path: join(SHOTS, "harness-action-unknown.png") });
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
