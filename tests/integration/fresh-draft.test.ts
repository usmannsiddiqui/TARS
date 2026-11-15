// @vitest-environment edge-runtime
// A second request in a project that already has a draft gets its own fresh draft from its run, as the
// next revision (an edited or sent one stays in the versions, so Undo brings it back). Nothing is sent.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProjectIdSchema, type Evidence, type ProjectId } from "@companion/domain";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { tokenHash } from "../../convex/lib/sharePage";
import { makeEvidence, makeOwners } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");
const NOW = "2026-11-14T15:00:00.000Z"; // Saturday 10:00 in New York
const FIRST_BODY = "Budget for Dana\n\n## Summary\n- The budget Dana asked for.";
const SECOND_BODY = "Q3 summary for Dana\n\n## Summary\n[Needs from you: Q3 numbers]";
const SECOND_SAY = "Dana asked for the Q3 summary by 5 PM. I drafted it as a new revision; tell me what to change.";
const TOKEN = "A".repeat(43);

let callSeq = 0;
const call = (name: string, args: unknown) => ({ type: "function_call", call_id: `call-${++callSeq}`, name, arguments: JSON.stringify(args) });
const says = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });
let fetchMock: ReturnType<typeof vi.fn>;
/** Model turns answer in order; each is the list of output items of one response. The last repeats. */
function stubModel(turns: unknown[][]) {
  let n = 0;
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "completed", output: turns[Math.min(n++, turns.length - 1)] }), { status: 200 }));
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
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(5);
      await t.finishInProgressScheduledFunctions();
    }
  };
  const mail = async (text: string) => {
    const record = makeEvidence(alice.ownerId, [projectId], { text, ...(sourceId ? { sourceId: sourceId as Evidence["sourceId"] } : {}) });
    if (sourceId === undefined) {
      sourceId = record.sourceId;
      await asAlice.mutation(api.evidence.setGrant, { id: sourceId, kind: "gmail", selectors: ["illustrative-label"], projectIds: [projectId], read: true, writeTargets: [], cloudProcessing: true, version: 1, state: "active" });
    }
    expect(await t.mutation(internal.evidence.ingest, { ownerId: alice.ownerId, sourceId, record })).toBe("accepted");
    await settle();
    return record;
  };
  /** The run's steps for one request: record it, draft it, then speak. */
  const request = (text: string, title: string, body: string, say: string) => [
    [call("start_request", { projectId, request: text, dueLocal: "2026-11-14T17:00" })],
    [call("write_draft", { title, form: "document", text: body, changeSummary: `Started for: ${text}` })],
    [says(say)],
  ];
  const opening = async () => {
    stubModel(request("Send the budget to Dana", "Budget for Dana", FIRST_BODY, "Dana asked for the budget by 5 PM. I drafted it; tell me what to change."));
    return mail("Alice, please send the budget to Dana by 5pm today.");
  };
  const secondRequest = async () => {
    stubModel(request("Send Dana the Q3 summary", "Q3 summary for Dana", SECOND_BODY, SECOND_SAY));
    return mail("Alice, please send me the Q3 summary by 5pm today.");
  };
  const artifact = async () => (await asAlice.query(api.artifacts.getArtifact, { projectId }))!;
  const thread = () => asAlice.query(api.thread.listThread, { projectId });
  const all = <T extends keyof typeof schema.tables>(table: T) => t.run((ctx) => ctx.db.query(table).collect());
  const say = (message: { blocks: { type: string; props: unknown }[] }) => (message.blocks.find((b) => b.type === "say")?.props as { text: string }).text;
  return { t, alice, asAlice, projectId, mail, opening, secondRequest, artifact, thread, all, say };
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
  expect(document).toMatchObject({ artifactId: now.id, revision: "2", title: "Q3 summary for Dana", undoRevision: "1" });
  expect(s.say(messages[1]!)).toBe(SECOND_SAY); // the run's own words, no fixed sentence
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

test("a_user_edited_unsent_draft_gets_the_new_request_as_the_next_revision_and_undo_restores_his_words", async () => {
  const s = await setup();
  await s.opening();
  const before = await s.artifact();
  await s.asAlice.mutation(api.artifacts.saveEdit, { artifactId: before.id, baseRevision: "1", text: "My own words." });

  await s.secondRequest();

  const now = await s.artifact();
  expect(now).toMatchObject({ revision: "3", text: SECOND_BODY, userEdited: false });
  expect(await s.all("artifactSuggestions")).toEqual([]);
  expect(await s.all("actions")).toEqual([]);
  const undone = await s.asAlice.mutation(api.artifacts.undoRevision, { artifactId: now.id, expectedCurrent: "3", undoRevision: "2" });
  expect(undone.artifact.text).toBe("My own words.");
});

test("the_same_message_run_again_changes_nothing", async () => {
  const s = await setup();
  await s.opening();
  const record = await s.secondRequest();
  const [artifact, messages, commitments] = [await s.artifact(), await s.thread(), await s.all("commitments")];

  // The model tries to start the same request again and write over the draft.
  stubModel([
    [call("start_request", { projectId: s.projectId, request: "Send Dana the Q3 summary", dueLocal: "2026-11-14T17:00" })],
    [call("write_draft", { title: "Q3 summary for Dana", form: "document", text: "A third body that must not land.", changeSummary: "Again." })],
    [says("Done again.")],
  ]);
  await s.t.action(internal.runs.onMessage, { ownerId: s.alice.ownerId, evidenceId: record.id });

  expect(await s.artifact()).toMatchObject({ revision: artifact.revision, text: artifact.text });
  expect(await s.thread()).toEqual(messages);
  expect(await s.all("commitments")).toEqual(commitments);
  expect(await s.asAlice.query(api.briefs.listNudgeOffers, {})).toHaveLength(1);
});
