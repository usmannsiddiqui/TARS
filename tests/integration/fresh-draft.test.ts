// @vitest-environment edge-runtime
// A second request in a project that already has a draft gets its own fresh draft, as the next revision,
// unless the user edited the current one and has not sent it: then it becomes a suggestion. Nothing is sent.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProjectIdSchema, type Evidence, type ProjectId } from "@companion/domain";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { tokenHash } from "../../convex/lib/sharePage";
import type { PreparationOutput } from "../../packages/domain/src/prepare";
import { makeEvidence, makeOwners } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");
const NOW = "2026-11-14T15:00:00.000Z"; // Saturday 10:00 in New York
const DUE = "2026-11-14T22:00:00.000Z";
const FIRST_BODY = "Budget for Dana\n\n## Summary\n- The budget Dana asked for.";
const SECOND_BODY = "Q3 summary for Dana\n\n## Summary\n[Needs from you: Q3 numbers]";
const TOKEN = "A".repeat(43);

const completed = (output: unknown) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
let fetchMock: ReturnType<typeof vi.fn>;
function stubModel(output: () => PreparationOutput) {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(completed(output())), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date(NOW));
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
  const { alice } = makeOwners();
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice", name: "Alice" });
  await asAlice.mutation(api.briefs.setAttentionSettings, { timezone: "America/New_York" });
  const projectId: ProjectId = ProjectIdSchema.parse(await asAlice.mutation(api.projects.createProject, { name: "Budget" }));
  let sourceId: string | undefined;
  const mails: Evidence[] = [];
  const mail = async (text: string) => {
    const record = makeEvidence(alice.ownerId, [projectId], { text, ...(sourceId ? { sourceId: sourceId as Evidence["sourceId"] } : {}) });
    if (sourceId === undefined) {
      sourceId = record.sourceId;
      await asAlice.mutation(api.evidence.setGrant, { id: sourceId, kind: "gmail", selectors: ["illustrative-label"], projectIds: [projectId], read: true, writeTargets: [], cloudProcessing: true, version: 1, state: "active" });
    }
    mails.push(record);
    expect(await t.mutation(internal.evidence.ingest, { ownerId: alice.ownerId, sourceId, record })).toBe("accepted");
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5);
      await t.finishInProgressScheduledFunctions();
    }
  };
  const ask = (text: string, quote: string) => ({ text, holder: "user" as const, holderName: null, explicit: true, quote, dueAt: DUE, evidenceIds: [mails.at(-1)!.id as string] });
  const first = () => ({
    title: "Budget for Dana",
    body: FIRST_BODY,
    evidenceIds: mails.map((m) => m.id as string),
    gaps: [],
    nextAction: "Read the draft.",
    commitments: [{ ...ask("Send the budget to Dana", "Alice, please send the budget to Dana"), evidenceIds: [mails[0]!.id as string] }],
    facts: [],
  });
  const second = () => ({
    ...first(),
    title: "Q3 summary for Dana",
    body: SECOND_BODY,
    commitments: [...first().commitments, ask("Send Dana the Q3 summary", "Alice, please send me the Q3 summary")],
  });
  const opening = async () => {
    stubModel(first);
    await mail("Alice, please send the budget to Dana by 5pm today.");
  };
  const secondRequest = async () => {
    stubModel(second);
    await mail("Alice, please send me the Q3 summary by 5pm today.");
  };
  const artifact = async () => (await asAlice.query(api.artifacts.getArtifact, { projectId }))!;
  const thread = () => asAlice.query(api.thread.listThread, { projectId });
  const all = <T extends keyof typeof schema.tables>(table: T) => t.run((ctx) => ctx.db.query(table).collect());
  const say = (message: { blocks: { type: string; props: unknown }[] }) => (message.blocks.find((b) => b.type === "say")?.props as { text: string }).text;
  return { t, alice, asAlice, projectId, mail, opening, secondRequest, artifact, thread, all, say, second };
}

test("a_tars_written_draft_gets_the_new_request_as_the_next_revision_and_undo_restores_it", async () => {
  const s = await setup();
  await s.opening();
  expect((await s.artifact()).revision).toBe("1");

  await s.secondRequest();

  const now = await s.artifact();
  expect(now).toMatchObject({ revision: "2", text: SECOND_BODY, userEdited: false });
  const messages = await s.thread();
  expect(messages).toHaveLength(2);
  const document = messages[1]!.blocks.find((b) => b.type === "document")?.props;
  expect(document).toMatchObject({ artifactId: now.id, revision: "2", title: "Q3 summary for Dana" });
  expect(s.say(messages[1]!)).toMatch(/fresh draft/i);
  expect(await s.all("actions")).toEqual([]);

  const undone = await s.asAlice.mutation(api.artifacts.undoRevision, { artifactId: now.id, expectedCurrent: "2", undoRevision: "1" });
  expect(undone.artifact.text).toBe(FIRST_BODY);
});

test("an_already_sent_revision_keeps_its_document_and_the_new_request_gets_the_next_revision", async () => {
  const s = await setup();
  await s.opening();
  const before = await s.artifact();
  const edited = await s.asAlice.mutation(api.artifacts.saveEdit, { artifactId: before.id, baseRevision: "1", text: "Edited and sent." });
  expect(edited.artifact.revision).toBe("2");
  // The send of revision 2, as delivery records it: a verified send-document action and its Word document.
  await s.t.run(async (ctx) => {
    const artifactId = ctx.db.normalizeId("artifacts", before.id)!;
    const storageId = await ctx.storage.store(new Blob(["revision 2 document"]));
    const documentId = await ctx.db.insert("artifactDocuments", { ownerId: s.alice.ownerId, artifactId, revision: "2", contentHash: "h", filename: "Budget.docx", storageId, tokenHash: await tokenHash(TOKEN), sealedToken: "sealed", createdAt: Date.now() });
    await ctx.db.insert("actions", {
      ownerId: s.alice.ownerId,
      projectId: s.projectId,
      kind: "send-document",
      destination: "dana@example.com",
      artifactId: before.id,
      documentId,
      revision: "2",
      contentHash: "h",
      instructionId: "i1",
      sourceId: "s1",
      provider: "gmail",
      body: "Edited and sent.",
      state: "succeeded",
      verifiedAt: new Date().toISOString(),
      logState: "not-due",
    });
  });

  await s.secondRequest();

  expect(await s.artifact()).toMatchObject({ revision: "3", text: SECOND_BODY, userEdited: false });
  const link = await s.t.fetch(`/d/${TOKEN}`);
  expect(link.status).toBe(200);
  expect(await link.text()).toBe("revision 2 document");
  expect(await s.all("actions")).toHaveLength(1); // only the earlier send
});

test("a_user_edited_unsent_draft_is_left_alone_and_the_new_start_is_a_suggestion", async () => {
  const s = await setup();
  await s.opening();
  const before = await s.artifact();
  await s.asAlice.mutation(api.artifacts.saveEdit, { artifactId: before.id, baseRevision: "1", text: "My own words." });

  await s.secondRequest();

  const now = await s.artifact();
  expect(now).toMatchObject({ revision: "2", text: "My own words.", userEdited: true });
  expect(now.suggestions).toEqual([expect.objectContaining({ kind: "source", text: SECOND_BODY, baseRevision: "2", changeSummary: "Started for: Send Dana the Q3 summary" })]);
  const messages = await s.thread();
  expect(messages).toHaveLength(2);
  expect(s.say(messages[1]!)).toMatch(/left your edited draft as it is/i);
  expect(await s.all("actions")).toEqual([]);
});

test("the_same_request_seen_again_changes_nothing", async () => {
  const s = await setup();
  await s.opening();
  await s.secondRequest();
  const [artifact, messages, suggestions] = [await s.artifact(), await s.thread(), await s.all("artifactSuggestions")];

  stubModel(() => ({ ...s.second(), body: "A third body that must not land." }));
  await s.mail("Reminder: the Q3 summary, please.");

  expect(await s.artifact()).toMatchObject({ revision: artifact.revision, text: artifact.text });
  expect(await s.thread()).toHaveLength(messages.length);
  expect(await s.all("artifactSuggestions")).toEqual(suggestions);
});
