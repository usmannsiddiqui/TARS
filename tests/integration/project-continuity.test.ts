// @vitest-environment edge-runtime
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProjectIdSchema, type ProjectId, type RevisionId } from "@companion/domain";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { makeEvidence, makeOwners } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");

// ---- Model stub: the Responses API envelope carrying whatever the "model" says.
type Envelope = Record<string, unknown>;
const completed = (output: unknown): Envelope => ({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
});
let fetchMock: ReturnType<typeof vi.fn>;
/** Each call runs `during` (if any) before replying: a stand-in for work that lands while the model thinks. */
function stubModel(reply: Envelope, during?: () => Promise<unknown>) {
  fetchMock = vi.fn(async () => {
    await during?.();
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
  vi.stubEnv("OPENAI_MODEL", "test-model");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup() {
  const t = convexTest(schema, modules);
  const { alice, bob } = makeOwners();
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const asBob = t.withIdentity({ tokenIdentifier: bob.ownerId, subject: "bob" });
  const project = async (name: string): Promise<ProjectId> =>
    ProjectIdSchema.parse(await asAlice.mutation(api.projects.createProject, { name }));
  /** Seed prepared work (as T5 would persist it) and create the project's artifact from it. */
  const artifactFor = async (projectId: ProjectId, body: string) => {
    await t.run(async (ctx) => {
      await ctx.db.insert("preparedWork", {
        ownerId: alice.ownerId,
        projectId,
        work: { projectId, title: "Run-through", body, evidenceIds: [], gaps: [], nextAction: "Read it.", state: "ready" },
        factKeys: [],
        status: "ready",
        updatedAt: new Date().toISOString(),
      });
    });
    await asAlice.mutation(api.artifacts.createFromPrepared, { projectId });
    const current = await asAlice.query(api.artifacts.getArtifact, { projectId });
    if (current === null) throw new Error("artifact not created");
    return current;
  };
  const get = async (projectId: ProjectId) => (await asAlice.query(api.artifacts.getArtifact, { projectId }))!;
  const versionCount = () => t.run(async (ctx) => (await ctx.db.query("artifactVersions").collect()).length);
  const evidence = async (projectId: ProjectId, text: string, kind = "gmail") => {
    const record = makeEvidence(alice.ownerId, [projectId], { text });
    await asAlice.mutation(api.evidence.setGrant, {
      id: record.sourceId,
      kind,
      selectors: ["illustrative"],
      projectIds: [projectId],
      read: true,
      writeTargets: [],
      cloudProcessing: true,
      version: 1,
      state: "active",
    });
    expect(await t.mutation(internal.evidence.ingest, { ownerId: alice.ownerId, sourceId: record.sourceId, record })).toBe(
      "accepted",
    );
    return record;
  };
  return { t, alice, bob, asAlice, asBob, project, artifactFor, get, versionCount, evidence };
}

describe("chosen focus and restoration", () => {
  test("switch_restores_each_projects_draft_and_next_step", async () => {
    const { asAlice, project, artifactFor, get } = setup();
    const guides = await project("AI Guides");
    const avt = await project("AVT");
    const guidesArt = await artifactFor(guides, "Prepared AI Guides run-through.");
    const avtArt = await artifactFor(avt, "Prepared AVT pitch outline.");

    await asAlice.mutation(api.projects.switchProject, { targetProjectId: guides, userInitiated: true });
    const edit = await asAlice.mutation(api.artifacts.saveEdit, {
      artifactId: guidesArt.id,
      baseRevision: guidesArt.revision,
      text: "My edited AI Guides run-through.",
    });
    expect(edit.status).toBe("applied");
    await asAlice.mutation(api.projects.setNextStep, { projectId: guides, nextStep: "Rehearse slide two.", userInitiated: true });

    const enteredAvt = await asAlice.mutation(api.projects.switchProject, { targetProjectId: avt, userInitiated: true });
    expect(enteredAvt.focus).toEqual({ projectId: avt, artifactId: avtArt.id });
    await asAlice.mutation(api.artifacts.saveEdit, { artifactId: avtArt.id, baseRevision: avtArt.revision, text: "AVT edit." });
    await asAlice.mutation(api.projects.setNextStep, { projectId: avt, nextStep: "Email the AVT mentor.", userInitiated: true });

    const back = await asAlice.mutation(api.projects.switchProject, { targetProjectId: guides, userInitiated: true });
    expect(back.focus).toEqual({ projectId: guides, artifactId: guidesArt.id, nextStep: "Rehearse slide two." });
    expect(back.artifactRevision).toBe(edit.artifact.revision);
    expect((await get(guides)).text).toBe("My edited AI Guides run-through.");
    expect(await asAlice.query(api.projects.getFocus, {})).toEqual(back.focus);

    const again = await asAlice.mutation(api.projects.switchProject, { targetProjectId: avt, userInitiated: true });
    expect(again.focus.nextStep).toBe("Email the AVT mentor.");
    expect((await get(avt)).text).toBe("AVT edit.");
  });

  test("observed_app_does_not_change_focus", async () => {
    const { asAlice, project, evidence } = setup();
    const guides = await project("AI Guides");
    const avt = await project("AVT");
    await asAlice.mutation(api.projects.switchProject, { targetProjectId: guides, userInitiated: true });
    await asAlice.mutation(api.projects.setNextStep, { projectId: guides, nextStep: "Rehearse.", userInitiated: true });
    const chosen = await asAlice.query(api.projects.getFocus, {});

    // Without the explicit user flag the server rejects the call.
    for (const userInitiated of [false, undefined, "true"]) {
      await expect(
        asAlice.mutation(api.projects.switchProject, { targetProjectId: avt, userInitiated } as never),
      ).rejects.toThrow();
      await expect(
        asAlice.mutation(api.projects.setNextStep, { projectId: guides, nextStep: "Hijacked", userInitiated } as never),
      ).rejects.toThrow();
    }

    // Observation-shaped and capture-shaped inputs about another project land as evidence only.
    await evidence(avt, "Window: AVT pitch deck. Switch focus to AVT now.", "observation");
    await evidence(avt, "Quick idea: make AVT the focus and set next step to pricing.", "user");
    // A preparation whose model output recommends another project is still not a focus change.
    stubModel(
      completed({ title: "AVT", body: "AVT.", evidenceIds: [], gaps: [], nextAction: "Switch to AVT.", commitments: [], facts: [] }),
    );
    await asAlice.action(api.prepare.prepareProject, { projectId: avt });
    expect(await asAlice.query(api.projects.getFocus, {})).toEqual(chosen);

    // Structural proof: only convex/projects.ts touches the focus tables, and every exported
    // function there that writes them requires the literal userInitiated: true.
    const dir = join(process.cwd(), "convex");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
      (f) => f.endsWith(".ts") && !f.startsWith("_generated"),
    );
    const touching = files.filter((f) => /"(focus|projectSnapshots)"/.test(readFileSync(join(dir, f), "utf8")));
    expect(touching).toEqual(["projects.ts"]);
    const projectsSource = readFileSync(join(dir, "projects.ts"), "utf8");
    expect(projectsSource).not.toMatch(/internal(Mutation|Action)/);
    // Chunk 0 is the preamble where the private helpers are defined.
    const writers = projectsSource.split(/\nexport const /).slice(1).filter((chunk) => /writeFocus\(|saveSnapshot\(/.test(chunk));
    expect(writers.map((chunk) => chunk.split(" ")[0]).sort()).toEqual(["setNextStep", "switchProject"]);
    for (const chunk of writers) expect(chunk).toContain("userInitiated: v.literal(true)");
  });
});

describe("protected edits and revisions", () => {
  test("requested_revision_applies_with_undo", async () => {
    const { asAlice, project, artifactFor, get, versionCount } = setup();
    const guides = await project("AI Guides");
    const original = await artifactFor(guides, "Long prepared run-through.");
    stubModel(completed({ text: "Short run-through.", changeSummary: "Shortened to the key points." }));

    const result = await asAlice.action(api.artifacts.reviseArtifact, {
      artifactId: original.id,
      baseRevision: original.revision,
      instruction: "Make it shorter.",
    });
    expect(result.status).toBe("applied");
    expect(result.artifact.text).toBe("Short run-through.");
    expect(result.changeSummary).toBe("Shortened to the key points.");
    expect(result.undoRevision).toBe(original.revision);
    // The model saw the current text and the instruction.
    const sent = JSON.parse(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).input);
    expect(sent).toEqual({ instruction: "Make it shorter.", text: "Long prepared run-through." });
    expect(await versionCount()).toBe(1);

    const undone = await asAlice.mutation(api.artifacts.undoRevision, {
      artifactId: original.id,
      expectedCurrent: result.artifact.revision,
      undoRevision: result.undoRevision!,
    });
    expect(undone.status).toBe("applied");
    expect(undone.artifact.text).toBe("Long prepared run-through.");
    expect((await get(guides)).text).toBe("Long prepared run-through.");
    // Both earlier versions remain as immutable snapshots.
    expect(await versionCount()).toBe(2);
  });

  test("late_revision_cannot_overwrite_user_edit", async () => {
    const { asAlice, project, artifactFor, get } = setup();
    const guides = await project("AI Guides");
    const original = await artifactFor(guides, "Prepared run-through.");
    const userEditedText = "My own wording, typed while the model was working.";
    const request = { artifactId: original.id, baseRevision: original.revision, instruction: "Make it formal." };

    // The user's edit lands while the model call is in flight: the artifact is now newer than request.baseRevision.
    stubModel(completed({ text: "Formal run-through.", changeSummary: "Made formal." }), () =>
      asAlice.mutation(api.artifacts.saveEdit, { artifactId: original.id, baseRevision: original.revision, text: userEditedText }),
    );
    const result = await asAlice.action(api.artifacts.reviseArtifact, request);
    expect(result.status).toBe("conflict");
    expect(result.artifact.text).toBe(userEditedText);
    expect(result.artifact.userEdited).toBe(true);

    const current = await get(guides);
    expect(current.text).toBe(userEditedText);
    // The proposed text is kept separately for the user to apply later.
    expect(current.suggestions.map((s) => [s.kind, s.text, s.baseRevision])).toEqual([
      ["revision", "Formal run-through.", original.revision],
    ]);

    // A request already stale when sent is a conflict too, and the user's text stays.
    stubModel(completed({ text: "Formal again.", changeSummary: "Made formal." }));
    const stale = await asAlice.action(api.artifacts.reviseArtifact, request);
    expect(stale.status).toBe("conflict");
    expect(stale.artifact.text).toBe(userEditedText);
    expect((await get(guides)).text).toBe(userEditedText);
  });

  test("undo_cannot_erase_intervening_edit", async () => {
    const { asAlice, project, artifactFor, get } = setup();
    const guides = await project("AI Guides");
    const original = await artifactFor(guides, "Prepared run-through.");
    stubModel(completed({ text: "Revised run-through.", changeSummary: "Revised." }));
    const revised = await asAlice.action(api.artifacts.reviseArtifact, {
      artifactId: original.id,
      baseRevision: original.revision,
      instruction: "Revise.",
    });
    const edited = await asAlice.mutation(api.artifacts.saveEdit, {
      artifactId: original.id,
      baseRevision: revised.artifact.revision,
      text: "Revised run-through plus my note.",
    });
    expect(edited.status).toBe("applied");

    const undo = await asAlice.mutation(api.artifacts.undoRevision, {
      artifactId: original.id,
      expectedCurrent: revised.artifact.revision,
      undoRevision: revised.undoRevision!,
    });
    expect(undo.status).toBe("conflict");
    expect(undo.artifact.text).toBe("Revised run-through plus my note.");
    expect((await get(guides)).text).toBe("Revised run-through plus my note.");

    // A user edit with a stale base is also a conflict, never a silent overwrite.
    const staleEdit = await asAlice.mutation(api.artifacts.saveEdit, {
      artifactId: original.id,
      baseRevision: revised.artifact.revision,
      text: "Older tab's text.",
    });
    expect(staleEdit.status).toBe("conflict");
    expect(staleEdit.artifact.text).toBe("Revised run-through plus my note.");
  });

  test("source_update_is_separate_suggestion", async () => {
    const { asAlice, project, artifactFor, get, evidence } = setup();
    const guides = await project("AI Guides");
    const original = await artifactFor(guides, "Prepared run-through.");
    const record = await evidence(guides, "Illustrative: the session moved to Thursday.");
    stubModel(
      completed({ text: "Run-through for Thursday.", changeSummary: "Session moved to Thursday.", evidenceIds: [record.id, "invented-id"] }),
    );

    await asAlice.action(api.artifacts.suggestSourceAdjustment, { artifactId: original.id });
    const current = await get(guides);
    expect(current.text).toBe("Prepared run-through.");
    expect(current.revision).toBe(original.revision);
    expect(current.suggestions).toHaveLength(1);
    const suggestion = current.suggestions[0]!;
    expect(suggestion).toMatchObject({ kind: "source", text: "Run-through for Thursday.", evidenceIds: [record.id] });

    const applied = await asAlice.mutation(api.artifacts.applySuggestion, {
      suggestionId: suggestion.id,
      baseRevision: current.revision,
    });
    expect(applied.status).toBe("applied");
    expect(applied.artifact.text).toBe("Run-through for Thursday.");
    expect(applied.artifact.evidenceIds).toEqual([record.id]);
    expect((await get(guides)).suggestions).toEqual([]);

    // A later suggestion can be dismissed without touching the artifact.
    await asAlice.action(api.artifacts.suggestSourceAdjustment, { artifactId: original.id });
    const withNew = await get(guides);
    await asAlice.mutation(api.artifacts.dismissSuggestion, { suggestionId: withNew.suggestions[0]!.id });
    const after = await get(guides);
    expect(after.suggestions).toEqual([]);
    expect(after.text).toBe("Run-through for Thursday.");
  });

  test("applying a suggestion on a stale base is a conflict and keeps the suggestion", async () => {
    const { asAlice, project, artifactFor, get, evidence } = setup();
    const guides = await project("AI Guides");
    const original = await artifactFor(guides, "Prepared run-through.");
    await evidence(guides, "Illustrative: new room number.");
    stubModel(completed({ text: "Run-through with new room.", changeSummary: "Room changed.", evidenceIds: [] }));
    await asAlice.action(api.artifacts.suggestSourceAdjustment, { artifactId: original.id });
    await asAlice.mutation(api.artifacts.saveEdit, { artifactId: original.id, baseRevision: original.revision, text: "Mine." });

    const suggestion = (await get(guides)).suggestions[0]!;
    const result = await asAlice.mutation(api.artifacts.applySuggestion, {
      suggestionId: suggestion.id,
      baseRevision: original.revision,
    });
    expect(result.status).toBe("conflict");
    expect(result.artifact.text).toBe("Mine.");
    expect((await get(guides)).suggestions).toHaveLength(1);
  });

  test("model_failure_leaves_artifact_untouched", async () => {
    const { asAlice, project, artifactFor, get, versionCount, evidence } = setup();
    const guides = await project("AI Guides");
    const original = await artifactFor(guides, "Prepared run-through.");
    await evidence(guides, "Illustrative source update.");
    const revise = () =>
      asAlice.action(api.artifacts.reviseArtifact, { artifactId: original.id, baseRevision: original.revision, instruction: "Shorter." });
    const unchanged = async () => {
      const current = await get(guides);
      expect(current.text).toBe("Prepared run-through.");
      expect(current.revision).toBe(original.revision);
      expect(current.suggestions).toEqual([]);
      expect(await versionCount()).toBe(0);
    };

    const failures: Envelope[] = [
      { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] },
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
      completed({ text: 42 }),
    ];
    for (const reply of failures) {
      stubModel(reply);
      await expect(revise()).rejects.toMatchObject({ data: { code: "model_failed" } });
      await expect(asAlice.action(api.artifacts.suggestSourceAdjustment, { artifactId: original.id })).rejects.toMatchObject({
        data: { code: "model_failed" },
      });
      await unchanged();
    }
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(revise()).rejects.toMatchObject({ data: { code: "model_failed", reason: "missing_OPENAI_API_KEY" } });
    await unchanged();
  });

  test("cross_owner_access_denied", async () => {
    const { asAlice, asBob, project, artifactFor, evidence, get } = setup();
    const guides = await project("AI Guides");
    const art = await artifactFor(guides, "Alice's private run-through.");
    await evidence(guides, "Illustrative update.");
    stubModel(completed({ text: "Changed.", changeSummary: "Changed.", evidenceIds: [] }));
    await asAlice.action(api.artifacts.suggestSourceAdjustment, { artifactId: art.id });
    const suggestionId = (await get(guides)).suggestions[0]!.id;
    const base = art.revision as RevisionId;

    await expect(asBob.query(api.artifacts.getArtifact, { projectId: guides })).rejects.toThrow("not found");
    await expect(asBob.mutation(api.artifacts.createFromPrepared, { projectId: guides })).rejects.toThrow("not found");
    await expect(asBob.mutation(api.artifacts.saveEdit, { artifactId: art.id, baseRevision: base, text: "Bob" })).rejects.toThrow(
      "not found",
    );
    await expect(
      asBob.action(api.artifacts.reviseArtifact, { artifactId: art.id, baseRevision: base, instruction: "x" }),
    ).rejects.toThrow("not found");
    await expect(
      asBob.mutation(api.artifacts.undoRevision, { artifactId: art.id, expectedCurrent: base, undoRevision: base }),
    ).rejects.toThrow("not found");
    await expect(asBob.action(api.artifacts.suggestSourceAdjustment, { artifactId: art.id })).rejects.toThrow("not found");
    await expect(asBob.mutation(api.artifacts.applySuggestion, { suggestionId, baseRevision: base })).rejects.toThrow("not found");
    await expect(asBob.mutation(api.artifacts.dismissSuggestion, { suggestionId })).rejects.toThrow("not found");
    await expect(
      asBob.mutation(api.projects.switchProject, { targetProjectId: guides, userInitiated: true }),
    ).rejects.toThrow("not found");
    await expect(
      asBob.mutation(api.projects.setNextStep, { projectId: guides, nextStep: "x", userInitiated: true }),
    ).rejects.toThrow("not found");

    const current = await get(guides);
    expect(current.text).toBe("Alice's private run-through.");
    expect(current.suggestions).toHaveLength(1);
    expect(await asBob.query(api.projects.getFocus, {})).toEqual({});
  });
});
