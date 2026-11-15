// @vitest-environment edge-runtime
// Visible helpers: every preparation (user-started or automatic) records the stages it really passes
// through on its run row, the owner's active runs are one query, and a failed run never stays "running".
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProjectIdSchema, type Evidence, type ProjectId } from "@companion/domain";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import type { PreparationOutput } from "../../packages/domain/src/prepare";
import { makeEvidence, makeOwners } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");

// The run row after each write to it, in order: claim/start, each stage, finish. Wrapping the handlers
// of the run mutations is the only way to see stages that last less than one action step.
type Snapshot = { state: string; stage?: string; sources?: { kind: string; count: number }[] } | null;
const writes: Snapshot[] = [];
type Registered = { _handler: (ctx: { db: never }, args: { ownerId: string; projectId: string }) => Promise<unknown> };
const prepareModule = (await modules["../../convex/prepare.ts"]!()) as Record<string, Registered>;
for (const name of ["claimRun", "startAutomatic", "recordStage", "finishRun"]) {
  const fn = prepareModule[name]!;
  const inner = fn._handler;
  fn._handler = async (ctx, args) => {
    const out = await inner(ctx, args);
    const db = (ctx as unknown as { db: { query(t: string): { collect(): Promise<Record<string, unknown>[]> } } }).db;
    const row = (await db.query("preparationRuns").collect()).find((r) => r["ownerId"] === args.ownerId && r["projectId"] === args.projectId);
    writes.push(row ? { state: row["state"] as string, ...(row["stage"] ? { stage: row["stage"] as string } : {}), ...(row["sources"] ? { sources: row["sources"] as never } : {}) } : null);
    return out;
  };
}

const completed = (output: unknown) => ({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
});
const prepared = (evidenceIds: string[]): PreparationOutput => ({
  title: "Presenter run-through",
  body: "Illustrative run-through.",
  evidenceIds,
  gaps: [],
  nextAction: "Read the first section of the run-through.",
  commitments: [],
  facts: [],
});

let fetchMock: ReturnType<typeof vi.fn>;
/** Each model call runs `during()` (while the call is in flight), then waits for `gate`, then answers. */
function stubModel(reply: () => Response, opts: { during?: () => Promise<void>; gate?: Promise<void> } = {}) {
  fetchMock = vi.fn(async () => {
    await opts.during?.();
    if (opts.gate) await opts.gate;
    return reply();
  });
  vi.stubGlobal("fetch", fetchMock);
}
const ok = (ids: () => string[]) => () => new Response(JSON.stringify(completed(prepared(ids()))), { status: 200 });

beforeEach(() => {
  writes.length = 0;
  vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
  vi.stubEnv("OPENAI_MODEL", "test-model");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup() {
  const t = convexTest(schema, modules);
  const { alice, bob } = makeOwners();
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const asBob = t.withIdentity({ tokenIdentifier: bob.ownerId, subject: "bob" });
  const project = async (name: string): Promise<ProjectId> => ProjectIdSchema.parse(await asAlice.mutation(api.projects.createProject, { name }));
  const sources = new Map<string, string>();
  /** One grant per (project, kind), then one illustrative record through it. */
  const evidence = async (projectId: ProjectId, kind: string, text: string, cloudProcessing = false): Promise<Evidence> => {
    const key = `${projectId}:${kind}`;
    const known = sources.get(key);
    const record = makeEvidence(alice.ownerId, [projectId], { text, ...(known ? { sourceId: known as Evidence["sourceId"] } : {}) });
    if (!known) {
      sources.set(key, record.sourceId);
      await asAlice.mutation(api.evidence.setGrant, {
        id: record.sourceId,
        kind,
        selectors: ["illustrative-label"],
        projectIds: [projectId],
        read: true,
        writeTargets: [],
        cloudProcessing,
        version: 1,
        state: "active",
      });
    }
    expect(await t.mutation(internal.evidence.ingest, { ownerId: alice.ownerId, sourceId: record.sourceId, record })).toBe("accepted");
    return record;
  };
  const runs = () => asAlice.query(api.prepare.listActiveRuns, {});
  const prepare = (projectId: ProjectId) => asAlice.action(api.prepare.prepareProject, { projectId });
  return { t, asAlice, asBob, project, evidence, runs, prepare };
}

describe("visible helpers", () => {
  test("a_user_started_preparation_passes_through_its_real_stages_in_order", async () => {
    const { project, evidence, runs, prepare } = setup();
    const guides = await project("AI Guides");
    const ids = [
      (await evidence(guides, "gmail", "Illustrative: the co-presentation is on the 20th.")).id,
      (await evidence(guides, "gmail", "Illustrative: slides 9 to 18 exist.")).id,
      (await evidence(guides, "slack", "Illustrative: demo first, then the exercise.")).id,
    ];
    let seen: unknown;
    stubModel(ok(() => ids), { during: async () => void (seen = await runs()) });

    expect(await prepare(guides)).toEqual({ status: "ready" });

    const sources = [
      { kind: "gmail", count: 2 },
      { kind: "slack", count: 1 },
    ];
    expect(writes).toEqual([
      { state: "running", stage: "reading" },
      { state: "running", stage: "drafting", sources },
      { state: "running", stage: "saving", sources },
      null, // finished: the card leaves; the prepared work shows where it always has
    ]);
    // While the model drafted, the owner's subscription saw exactly that.
    expect(seen).toEqual([{ projectId: guides, projectName: "AI Guides", state: "running", stage: "drafting", sources }]);
    expect(await runs()).toEqual([]);
  });

  test("an_automatic_preparation_records_the_same_stages", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { t, project, evidence, runs } = setup();
    const guides = await project("AI Guides");
    const ids: string[] = [];
    stubModel(ok(() => ids));
    ids.push((await evidence(guides, "notion", "Illustrative: the run-through outline.", true)).id);
    expect(await runs()).toEqual([{ projectId: guides, projectName: "AI Guides", state: "pending", sources: [] }]);

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5);
      await t.finishInProgressScheduledFunctions();
    }

    const sources = [{ kind: "notion", count: 1 }];
    expect(writes).toEqual([
      { state: "running", stage: "reading" },
      { state: "running", stage: "drafting", sources },
      { state: "running", stage: "saving", sources },
      null,
    ]);
    expect(await runs()).toEqual([]);
  });

  test("two_projects_preparing_at_once_are_two_active_runs_and_a_second_start_is_refused", async () => {
    const { project, evidence, runs, prepare } = setup();
    const guides = await project("AI Guides");
    const avt = await project("AVT pitch for the regional accelerator, second round");
    const ids = [(await evidence(guides, "gmail", "Illustrative: guides note.")).id, (await evidence(avt, "slack", "Illustrative: pitch note.")).id];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inFlight = 0;
    let bothDrafting!: () => void;
    const drafting = new Promise<void>((resolve) => (bothDrafting = resolve));
    stubModel(ok(() => ids), { during: async () => void (++inFlight === 2 && bothDrafting()), gate });

    const first = prepare(guides);
    const second = prepare(avt);
    await drafting;

    const active = await runs();
    expect(active.map((r) => [r.projectName, r.state, r.stage, r.sources])).toEqual([
      ["AI Guides", "running", "drafting", [{ kind: "gmail", count: 1 }]],
      ["AVT pitch for the regional accelerator, second round", "running", "drafting", [{ kind: "slack", count: 1 }]],
    ]);
    // One helper per project: starting the same project again while it runs is refused, not duplicated.
    await expect(prepare(guides)).rejects.toThrow(/already preparing/);

    release();
    expect(await Promise.all([first, second])).toEqual([{ status: "ready" }, { status: "ready" }]);
    expect(await runs()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a_failed_model_call_ends_failed_with_no_running_row_and_can_be_retried_or_dismissed", async () => {
    const { asAlice, project, evidence, runs, prepare } = setup();
    const guides = await project("AI Guides");
    const ids = [(await evidence(guides, "gmail", "Illustrative: guides note.")).id];
    stubModel(() => new Response("upstream", { status: 500 }));

    expect(await prepare(guides)).toEqual({ status: "needs-retry", code: "http_500" });
    expect(writes.at(-1)).toEqual({ state: "failed" });
    expect(await runs()).toEqual([{ projectId: guides, projectName: "AI Guides", state: "failed", sources: [] }]);
    expect((await asAlice.query(api.prepare.getPreparedWork, { projectId: guides }))?.status).toBe("needs-retry");

    // Try again: the same row runs again and, on success, leaves.
    stubModel(ok(() => ids));
    expect(await prepare(guides)).toEqual({ status: "ready" });
    expect(await runs()).toEqual([]);

    // Fail again, then dismiss: the card goes; the prepared work's own state still says what happened.
    stubModel(() => new Response("upstream", { status: 500 }));
    await prepare(guides);
    await asAlice.mutation(api.prepare.dismissFailedRun, { projectId: guides });
    expect(await runs()).toEqual([]);
  });

  test("another_owner_sees_and_dismisses_none_of_it", async () => {
    const { asBob, project, evidence, runs, prepare } = setup();
    const guides = await project("AI Guides");
    await evidence(guides, "gmail", "Illustrative: guides note.");
    let bobSaw: unknown;
    stubModel(() => new Response("upstream", { status: 500 }), { during: async () => void (bobSaw = await asBob.query(api.prepare.listActiveRuns, {})) });

    await prepare(guides);

    expect(bobSaw).toEqual([]);
    expect(await asBob.query(api.prepare.listActiveRuns, {})).toEqual([]);
    await expect(asBob.mutation(api.prepare.dismissFailedRun, { projectId: guides })).rejects.toThrow(/Project not found/);
    expect((await runs()).map((r) => r.state)).toEqual(["failed"]);
  });
});
