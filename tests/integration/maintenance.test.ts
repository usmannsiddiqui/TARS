// @vitest-environment edge-runtime
// Internal demo reset: one owner's one project loses its derived data; grants, connections, memory,
// succeeded sends, other evidence kinds, other projects and other owners stay.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { MutationCtx } from "../../convex/_generated/server";
import schema from "../../convex/schema";
import { makeOwners } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");
const NOW = "2026-11-14T15:00:00.000Z";
const DUE = "2026-11-15T22:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

const EXPECTED = {
  commitments: 1,
  nudges: 1,
  threadMessages: 1,
  artifacts: 1,
  artifactVersions: 1,
  artifactSuggestions: 1,
  artifactShares: 1,
  artifactDocuments: 1,
  preparedWork: 1,
  preparationRuns: 1,
  captureItems: 1,
  dismissedInvitations: 1,
  deliveryReceipts: 2,
  actions: 1,
  telegramOutbox: 1,
  evidence: 1,
  tradeoffFlags: 1,
};
const ZEROS = Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, 0]));

/** One row in every per-project table, plus rows that must survive. */
async function seed(ctx: MutationCtx, ownerId: string, projectName: string) {
  const projectId: string = await ctx.db.insert("projects", { ownerId, name: projectName });
  const key = `${projectId}:send the budget`;
  const commitmentId = await ctx.db.insert("commitments", { ownerId, projectId, text: "Send the budget", ownership: "user", state: "open", dueAt: DUE, evidenceIds: [] });
  await ctx.db.insert("captureItems", { ownerId, captureId: `cap-${projectId}`, projectId, kind: "todo", text: "Send the budget", createdAt: 1, commitmentId });
  const dueJob = await ctx.scheduler.runAt(Date.parse(DUE) - 3_600_000, internal.briefs.nudgeDueSoon, { ownerId, key, dueAt: DUE });
  const nudgeId = await ctx.db.insert("nudges", { ownerId, projectId, key, dueAt: DUE, dueJob });
  await ctx.db.insert("deliveryReceipts", { ownerId, key: `nudge:${nudgeId}@1`, channel: "panel", at: 1 });
  await ctx.db.insert("deliveryReceipts", { ownerId, key: `task:${projectId}@${NOW}`, channel: "panel", at: 1 });
  await ctx.db.insert("dismissedInvitations", { ownerId, key: `task:${projectId}@${NOW}`, at: 1 });
  await ctx.db.insert("telegramOutbox", { ownerId, key: `nudge:${key}`, state: "sent", at: 1 });
  await ctx.db.insert("tradeoffFlags", { ownerId, key, state: "none" });
  await ctx.db.insert("threadMessages", { ownerId, projectId, role: "user", text: "hi", blocks: [], createdAt: 1 });
  const art = { ownerId, projectId, revision: "r2", text: "Draft", userEdited: false, evidenceIds: [] };
  const artifactId = await ctx.db.insert("artifacts", art);
  await ctx.db.insert("artifactVersions", { artifactId, ...art, revision: "r1" });
  await ctx.db.insert("artifactSuggestions", { ownerId, artifactId, kind: "source", text: "x", changeSummary: "x", baseRevision: "r2", evidenceIds: [] });
  await ctx.db.insert("artifactShares", { ownerId, artifactId, tokenHash: `h-${projectId}`, sealedToken: "s", revision: "r2", title: "t", text: "x", sharedAt: 1 });
  const storageId = await ctx.storage.store(new Blob(["old draft"]));
  const doc = { ownerId, artifactId, revision: "r1", contentHash: "c", filename: "Draft.docx", sealedToken: "s", createdAt: 1 };
  await ctx.db.insert("artifactDocuments", { ...doc, storageId, tokenHash: `d1-${projectId}` });
  const sentDocumentId = await ctx.db.insert("artifactDocuments", { ...doc, revision: "r2", tokenHash: `d2-${projectId}` });
  await ctx.db.insert("preparedWork", { ownerId, projectId, factKeys: [], status: "empty", updatedAt: NOW });
  await ctx.db.insert("preparationRuns", { ownerId, projectId, state: "failed", followUp: false });
  const action = {
    ownerId,
    projectId,
    kind: "send-document" as const,
    destination: "dana@example.com",
    artifactId,
    revision: "r2",
    contentHash: "c",
    sourceId: `gmail-${projectId}`,
    provider: "gmail",
    body: "x",
    logState: "not-due" as const,
  };
  await ctx.db.insert("actions", { ...action, instructionId: `i1-${projectId}`, state: "failed" });
  const sentActionId = await ctx.db.insert("actions", { ...action, instructionId: `i2-${projectId}`, state: "succeeded", documentId: sentDocumentId, verifiedAt: NOW });
  for (const kind of ["gmail", "slack"]) {
    const sourceId = `${kind}-${projectId}`;
    await ctx.db.insert("grants", { id: sourceId, kind, selectors: [], projectIds: [projectId], read: true, writeTargets: [], cloudProcessing: true, version: 1, state: "active", ownerId });
    await ctx.db.insert("evidence", {
      id: `ev-${sourceId}`,
      ownerId,
      sourceId,
      externalId: "m1",
      version: "1",
      text: "Illustrative mail.",
      occurredAt: NOW,
      receivedAt: NOW,
      projectIds: [projectId],
      grantVersion: 1,
      freshness: "current",
      origin: "provider",
      isCurrent: true,
    });
  }
  await ctx.db.insert("memoryFacts", { ownerId, projectId, key: "k", value: "v", evidenceIds: [], scope: "project", revision: 1 });
  return { projectId, dueJob, storageId, sentActionId, sentDocumentId };
}

async function setup() {
  const t = convexTest(schema, modules);
  const { alice, bob } = makeOwners();
  const seeded = await t.run(async (ctx) => ({
    main: await seed(ctx, alice.ownerId, "AI Guides"),
    other: await seed(ctx, alice.ownerId, "AVT"),
    bob: await seed(ctx, bob.ownerId, "AI Guides"),
  }));
  const reset = (dryRun: boolean, ownerId: string = alice.ownerId) =>
    t.mutation(internal.maintenance.resetProject, { ownerId, projectId: seeded.main.projectId, evidenceKinds: ["gmail"], dryRun });
  const total = () => t.run(async (ctx) => {
    let n = 0;
    for (const table of [...Object.keys(EXPECTED), "grants", "memoryFacts", "projects"] as const) n += (await ctx.db.query(table as "projects").collect()).length;
    return n;
  });
  return { t, alice, bob, seeded, reset, total };
}

test("dry run reports what would go and deletes nothing", async () => {
  const s = await setup();
  const before = await s.total();
  expect(await s.reset(true)).toEqual({ counts: EXPECTED, more: false });
  expect(await s.total()).toBe(before);
});

test("real run deletes exactly the project's derived rows, cancels its jobs and keeps the rest", async () => {
  const s = await setup();
  const before = await s.total();
  expect(await s.reset(false)).toEqual({ counts: EXPECTED, more: false });
  const removed = Object.values(EXPECTED).reduce((a, b) => a + b, 0);
  expect(await s.total()).toBe(before - removed);

  await s.t.run(async (ctx) => {
    const { main, other, bob } = s.seeded;
    expect((await ctx.db.system.get(main.dueJob))?.state.kind).toBe("canceled");
    expect((await ctx.db.system.get(other.dueJob))?.state.kind).toBe("pending");
    expect((await ctx.db.system.get(bob.dueJob))?.state.kind).toBe("pending");
    expect(await ctx.storage.get(main.storageId)).toBeNull();
    expect(await ctx.storage.get(other.storageId)).not.toBeNull();
    // The real send and the document its mail links to stay.
    expect(await ctx.db.get(main.sentActionId)).not.toBeNull();
    expect(await ctx.db.get(main.sentDocumentId as Id<"artifactDocuments">)).not.toBeNull();
    const evidence = await ctx.db.query("evidence").collect();
    expect(evidence.filter((e) => e.projectIds.includes(main.projectId)).map((e) => e.sourceId)).toEqual([`slack-${main.projectId}`]);
    expect(await ctx.db.query("grants").collect()).toHaveLength(6);
    expect(await ctx.db.query("memoryFacts").collect()).toHaveLength(3);
    expect(await ctx.db.query("projects").collect()).toHaveLength(3);
  });

  // Second run: nothing left.
  expect(await s.reset(false)).toEqual({ counts: ZEROS, more: false });
});

test("the wrong owner for the project throws and deletes nothing", async () => {
  const s = await setup();
  const before = await s.total();
  await expect(s.reset(false, s.bob.ownerId)).rejects.toThrow(/Project not found/);
  await expect(s.reset(true, s.bob.ownerId)).rejects.toThrow(/Project not found/);
  expect(await s.total()).toBe(before);
});

test("an empty evidence kind list removes no evidence", async () => {
  const s = await setup();
  const out = await s.t.mutation(internal.maintenance.resetProject, { ownerId: s.alice.ownerId, projectId: s.seeded.main.projectId, evidenceKinds: [], dryRun: false });
  expect(out.counts.evidence).toBe(0);
  expect(await s.t.run((ctx) => ctx.db.query("evidence").collect())).toHaveLength(6);
});
