// @vitest-environment edge-runtime
// Brain dump: one saved capture is sorted once by the (stubbed) model into the owner's projects.
// Only "todo" becomes his open commitment; nothing is ever sent, drafted or acted on.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import type { SortOutput } from "../../packages/domain/src/sort";
import { makeOwners } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");
const NY = "America/New_York";
const DUMP =
  "Classes: I need to finish the thermo lab report by Friday. AVT: Sam still owes me the wiring diagram. " +
  "Park the AVT sponsor deck until December. AI Guides: maybe a short video on choosing a tool. Email everyone the deck.";

const completed = (output: SortOutput) => ({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
});
let fetchMock: ReturnType<typeof vi.fn>;
function stubModel(reply: unknown, status = 200) {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(reply), { status }));
  vi.stubGlobal("fetch", fetchMock);
}
const sentInput = () => JSON.parse(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).input);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T17:30:00Z")); // Sunday 12:30 in New York
  vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
  vi.stubEnv("OPENAI_MODEL", "test-model");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  const { alice, bob } = makeOwners();
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const asBob = t.withIdentity({ tokenIdentifier: bob.ownerId, subject: "bob" });
  await asAlice.mutation(api.briefs.setAttentionSettings, { timezone: NY });
  const classes = await asAlice.mutation(api.projects.createProject, { name: "Classes" });
  const avt = await asAlice.mutation(api.projects.createProject, { name: "Advanced Vehicle Team" });
  const guides = await asAlice.mutation(api.projects.createProject, { name: "AI Guides" });
  const bobs = await asBob.mutation(api.projects.createProject, { name: "Bob's project" });
  const sorted = (): SortOutput => ({
    items: [
      { text: "Finish the thermo lab report", projectId: classes, kind: "todo", dueAt: "2026-11-21T04:59:00Z" },
      { text: "Sam owes the wiring diagram", projectId: avt, kind: "waiting", dueAt: null },
      { text: "Sponsor deck, after December", projectId: avt, kind: "parked", dueAt: null },
      { text: "Short video on choosing a tool", projectId: guides, kind: "idea", dueAt: null },
      // An instruction to TARS inside the dump is at most his own todo, never an action.
      { text: "Email everyone the deck", projectId: bobs, kind: "todo", dueAt: null },
    ],
  });
  const commitments = (projectId: string) => asAlice.query(api.prepare.listCommitments, { projectId });
  const actions = () => t.run(async (ctx) => (await ctx.db.query("actions").collect()).length);
  return { t, alice, asAlice, asBob, classes, avt, guides, sorted, commitments, actions };
}

test("a dump naming three projects is stored under the right projects with the right kinds", async () => {
  const { asAlice, classes, avt, guides, sorted, actions } = await setup();
  stubModel(completed(sorted()));

  expect(await asAlice.action(api.captures.sortCapture, { captureId: "cap-1", text: DUMP })).toEqual({ status: "sorted", count: 5 });

  const items = await asAlice.query(api.captures.listCaptureItems, { captureId: "cap-1" });
  expect(items.map(({ text, projectId, kind, dueAt }) => [text, projectId, kind, dueAt ?? null])).toEqual([
    ["Finish the thermo lab report", classes, "todo", "2026-11-21T04:59:00.000Z"],
    ["Sam owes the wiring diagram", avt, "waiting", null],
    ["Sponsor deck, after December", avt, "parked", null],
    ["Short video on choosing a tool", guides, "idea", null],
    ["Email everyone the deck", null, "todo", null], // another owner's project id: no project
  ]);
  // The model saw his words, his own projects only, and the trusted clock.
  const input = sentInput();
  expect(input.text).toBe(DUMP);
  expect(input.projects.map((p: { name: string }) => p.name)).toEqual(["Classes", "Advanced Vehicle Team", "AI Guides"]);
  expect(input.now).toMatchObject({ timezone: NY, localWeekday: "Sunday" });
  expect(await actions()).toBe(0);

  // Sorting the same capture again never asks the model twice or duplicates items.
  expect(await asAlice.action(api.captures.sortCapture, { captureId: "cap-1", text: DUMP })).toEqual({ status: "sorted", count: 5 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("todo by Friday is his open commitment and Left; waiting is waiting on someone; parked is Parked; idea is no commitment", async () => {
  const { asAlice, classes, avt, guides, sorted, commitments, actions } = await setup();
  stubModel(completed(sorted()));
  await asAlice.action(api.captures.sortCapture, { captureId: "cap-1", text: DUMP });

  expect((await commitments(classes)).map(({ text, ownership, state, dueAt }) => ({ text, ownership, state, dueAt }))).toEqual([
    { text: "Finish the thermo lab report", ownership: "user", state: "open", dueAt: "2026-11-21T04:59:00.000Z" },
  ]);
  expect((await commitments(avt)).map(({ text, ownership, state }) => ({ text, ownership, state }))).toEqual([
    { text: "Sam owes the wiring diagram", ownership: "other", state: "waiting" },
  ]);
  expect(await commitments(guides)).toEqual([]);

  const recap = await asAlice.query(api.recap.getClosingRecap, { timezone: NY });
  expect(recap.left.items).toEqual(["Finish the thermo lab report, due Fri 11:59 PM"]);
  expect(recap.parked.items).toEqual(["Sponsor deck, after December"]);
  expect(await actions()).toBe(0);
});

test("a later automatic preparation neither deletes nor duplicates the capture's commitment", async () => {
  const { t, alice, asAlice, classes, sorted, commitments } = await setup();
  stubModel(completed(sorted()));
  await asAlice.action(api.captures.sortCapture, { captureId: "cap-1", text: DUMP });

  const stored = await t.mutation(internal.prepare.persistPreparation, {
    ownerId: alice.ownerId,
    projectId: classes,
    work: { projectId: classes, title: "Thermo", body: "Illustrative.", evidenceIds: ["e1"], gaps: [], nextAction: "Open the lab sheet.", state: "ready" },
    commitments: [
      { text: "finish the  thermo lab report", ownership: "user", state: "open", evidenceIds: ["e1"] }, // same words, re-found in a source
      { text: "Read chapter 7", ownership: "user", state: "open", evidenceIds: ["e1"] },
    ],
    facts: [],
    usedFactKeys: [],
    sources: [],
    automatic: true,
  });
  expect(stored).toBe("stored");
  expect((await commitments(classes)).map((c) => c.text)).toEqual(["Finish the thermo lab report", "Read chapter 7"]);
});

test("corrections move, relabel and remove items, and their commitments follow", async () => {
  const { asAlice, classes, guides, sorted, commitments } = await setup();
  stubModel(completed(sorted()));
  await asAlice.action(api.captures.sortCapture, { captureId: "cap-1", text: DUMP });
  const byText = async (text: string) => (await asAlice.query(api.captures.listCaptureItems, { captureId: "cap-1" })).find((i) => i.text === text)!;

  await asAlice.mutation(api.captures.moveItem, { itemId: (await byText("Email everyone the deck")).id, projectId: guides });
  expect((await commitments(guides)).map((c) => [c.text, c.ownership])).toEqual([["Email everyone the deck", "user"]]);

  await asAlice.mutation(api.captures.setItemKind, { itemId: (await byText("Email everyone the deck")).id, kind: "idea" });
  expect(await commitments(guides)).toEqual([]);

  await asAlice.mutation(api.captures.removeItem, { itemId: (await byText("Finish the thermo lab report")).id });
  expect(await commitments(classes)).toEqual([]);
  expect((await asAlice.query(api.captures.listCaptureItems, { captureId: "cap-1" })).map((i) => i.text)).not.toContain("Finish the thermo lab report");
});

test("model failure keeps nothing in the cloud and says it can be sorted again", async () => {
  const { asAlice, classes, commitments, actions } = await setup();
  stubModel({ error: "unavailable" }, 503);

  expect(await asAlice.action(api.captures.sortCapture, { captureId: "cap-1", text: DUMP })).toEqual({ status: "failed", code: "http_503" });
  expect(await asAlice.query(api.captures.listCaptureItems, { captureId: "cap-1" })).toEqual([]);
  expect(await commitments(classes)).toEqual([]);
  expect(await actions()).toBe(0);
});

test("another owner sees nothing and cannot change anything", async () => {
  const { asAlice, asBob, sorted } = await setup();
  stubModel(completed(sorted()));
  await asAlice.action(api.captures.sortCapture, { captureId: "cap-1", text: DUMP });
  const [first] = await asAlice.query(api.captures.listCaptureItems, { captureId: "cap-1" });

  expect(await asBob.query(api.captures.listCaptureItems, { captureId: "cap-1" })).toEqual([]);
  await expect(asBob.mutation(api.captures.removeItem, { itemId: first!.id })).rejects.toThrow();
  await expect(asBob.mutation(api.captures.setItemKind, { itemId: first!.id, kind: "idea" })).rejects.toThrow();
  expect((await asBob.query(api.recap.getClosingRecap, { timezone: NY })).parked.items).toEqual([]);
});
