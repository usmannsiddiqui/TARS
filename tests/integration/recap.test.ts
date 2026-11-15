// @vitest-environment edge-runtime
// "Stop for now" -> the closing recap: Done / Parked / Left for that owner only, from stored records.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { makeOwners } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");
const NY = "America/New_York";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T17:30:00Z")); // Sunday 12:30 in New York
});
afterEach(() => vi.useRealTimers());

test("stop_then_recap_lists_done_parked_left_for_that_owner_only", async () => {
  const t = convexTest(schema, modules);
  const { alice, bob } = makeOwners();
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const asBob = t.withIdentity({ tokenIdentifier: bob.ownerId, subject: "bob" });
  const guides = await asAlice.mutation(api.projects.createProject, { name: "AI Guides" });
  const plan = await asAlice.mutation(api.projects.createProject, { name: "Q3 plan" });
  const bobs = await asBob.mutation(api.projects.createProject, { name: "Bob's project" });

  const ids = await t.run(async (ctx) => {
    const work = (ownerId: string, projectId: string, title: string) =>
      ctx.db.insert("preparedWork", {
        ownerId,
        projectId,
        work: { projectId, title, body: "Illustrative.", evidenceIds: ["e1"], gaps: [], nextAction: "Read it.", state: "ready" },
        factKeys: [],
        status: "ready",
        updatedAt: "2026-11-15T05:00:00.000Z",
      });
    const artifact = (ownerId: string, projectId: string) =>
      ctx.db.insert("artifacts", { ownerId, projectId, revision: "r1", text: "Illustrative draft text.", userEdited: false, evidenceIds: ["e1"] });
    const sent = (ownerId: string, projectId: string, artifactId: string) =>
      ctx.db.insert("actions", {
        ownerId,
        projectId,
        kind: "send-mail",
        destination: "dana@example.com",
        artifactId,
        revision: "r1",
        contentHash: "h",
        instructionId: `i-${projectId}`,
        sourceId: "s1",
        provider: "gmail",
        body: "Illustrative draft text.",
        state: "succeeded",
        verifiedAt: "2026-11-15T05:41:00.000Z",
        logState: "not-due",
      });
    await work(alice.ownerId, guides, "AI Guides report");
    await work(alice.ownerId, plan, "Q3 plan outline");
    await work(bob.ownerId, bobs, "Bob's report");
    await sent(alice.ownerId, guides, await artifact(alice.ownerId, guides));
    await artifact(alice.ownerId, plan); // started, never sent
    await sent(bob.ownerId, bobs, await artifact(bob.ownerId, bobs));
    const commitment = (ownerId: string, projectId: string, text: string, dueAt?: string) =>
      ctx.db.insert("commitments", { ownerId, projectId, text, ownership: "user", state: "open", evidenceIds: [], ...(dueAt ? { dueAt } : {}) });
    const booked = await commitment(alice.ownerId, guides, "Book the room");
    await commitment(alice.ownerId, plan, "Send the Q3 numbers", "2026-11-16T22:00:00.000Z");
    await commitment(alice.ownerId, guides, "Rehearse the demo", "2026-11-15T22:00:00.000Z");
    await commitment(bob.ownerId, bobs, "Bob's task", "2026-11-15T20:00:00.000Z");
    const nudge = await ctx.db.insert("nudges", {
      ownerId: alice.ownerId,
      projectId: plan,
      key: `${plan}:send the q3 numbers`,
      dueAt: "2026-11-16T22:00:00.000Z",
      offer: { key: "nudge:x@1", startedForYou: true },
    });
    return { booked, nudge };
  });

  await asAlice.mutation(api.actions.reportDone, { taskId: ids.booked });
  await asAlice.mutation(api.briefs.respondToNudge, { nudgeId: ids.nudge, choice: "not-now" });
  await asAlice.mutation(api.briefs.recordSessionEvent, { kind: "stop" });

  expect(await asAlice.query(api.recap.getClosingRecap, { timezone: NY })).toEqual({
    done: { items: ["Sent AI Guides report, 12:41 AM", "Book the room, marked done 12:30 PM"], more: 0 },
    parked: { items: ["Send the Q3 numbers", "Q3 plan outline (draft, not sent)"], more: 0 },
    left: { items: ["Rehearse the demo, due Sun 5:00 PM"], more: 0 },
  });
  const theirs = await asBob.query(api.recap.getClosingRecap, { timezone: NY });
  expect(theirs.done.items).toEqual(["Sent Bob's report, 12:41 AM"]);
  expect(theirs.parked.items).toEqual([]);
  expect(theirs.left.items).toEqual(["Bob's task, due Sun 3:00 PM"]);
  await expect(asAlice.query(api.recap.getClosingRecap, { timezone: "Not/AZone" })).rejects.toThrow(/timezone/i);
  await expect(t.query(api.recap.getClosingRecap, { timezone: NY })).rejects.toThrow();
});
