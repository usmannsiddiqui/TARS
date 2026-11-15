// @vitest-environment edge-runtime
// Sharing one artifact revision by link: only the owner's three explicit mutations create, move or
// stop a share; the public page shows one fixed revision and every bad link gets the same 404.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProjectIdSchema, type Evidence, type ProjectId } from "@companion/domain";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { FIRST_REVISION } from "../../packages/domain/src/artifacts";
import { makeEvidence, makeOwners } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");
const SITE = "https://illustrative.convex.site";
const DRAFT = "Illustrative pitch outline.\n\nSecond paragraph of the outline.";

beforeEach(() => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", btoa(String.fromCharCode(...key)));
  vi.stubEnv("CONVEX_SITE_URL", SITE);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  const t = convexTest(schema, modules);
  const { alice, bob } = makeOwners();
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice", name: "Alice" });
  const asBob = t.withIdentity({ tokenIdentifier: bob.ownerId, subject: "bob", name: "Bob" });
  const project = async (name = "AVT pitch"): Promise<ProjectId> =>
    ProjectIdSchema.parse(await asAlice.mutation(api.projects.createProject, { name }));
  const artifact = async (projectId: ProjectId, text = DRAFT) =>
    (await t.run((ctx) =>
      ctx.db.insert("artifacts", { ownerId: alice.ownerId, projectId, revision: FIRST_REVISION, text, userEdited: false, evidenceIds: [] }),
    )) as string;
  const current = async (projectId: ProjectId) => (await asAlice.query(api.artifacts.getArtifact, { projectId }))!;
  /** The path part of a share link, for t.fetch. */
  const path = (link: string) => {
    expect(link.startsWith(`${SITE}/p/`)).toBe(true);
    return link.slice(SITE.length);
  };
  const page = async (link: string) => {
    const response = await t.fetch(path(link), { method: "GET" });
    return { status: response.status, body: await response.text(), headers: response.headers };
  };
  const all = <T extends keyof typeof schema.tables>(table: T) => t.run((ctx) => ctx.db.query(table).collect());
  return { t, alice, asAlice, asBob, project, artifact, current, page, all };
}

describe("share an artifact by link", () => {
  test("share_shows_that_revision_and_only_the_explicit_update_changes_the_page", async () => {
    const { t, alice, asAlice, project, artifact, current, page } = setup();
    const projectId = await project();
    const artifactId = await artifact(projectId);
    expect(await asAlice.query(api.shares.getShare, { artifactId })).toBeNull();

    const { link } = await asAlice.action(api.shares.share, { artifactId, revision: FIRST_REVISION });
    const shared = await page(link);
    expect(shared.status).toBe(200);
    expect(shared.body).toContain("<h1>AVT pitch</h1>");
    expect(shared.body).toContain("<p>Illustrative pitch outline.</p>");
    expect(shared.body).toContain("<p>Second paragraph of the outline.</p>");
    expect(shared.body).toContain("Shared from TARS · read-only");
    expect(await asAlice.query(api.shares.getShare, { artifactId })).toMatchObject({ link, revision: FIRST_REVISION });

    // Edit, undo, an applied suggestion: the artifact moves, the shared page stays byte-identical.
    const edited = await asAlice.mutation(api.artifacts.saveEdit, { artifactId, baseRevision: FIRST_REVISION, text: "Illustrative edited outline." });
    expect(edited.status).toBe("applied");
    expect((await page(link)).body).toBe(shared.body);
    await asAlice.mutation(api.artifacts.undoRevision, { artifactId, expectedCurrent: edited.artifact.revision, undoRevision: edited.undoRevision! });
    expect((await page(link)).body).toBe(shared.body);
    const base = (await current(projectId)).revision;
    const suggestionId = await t.run((ctx) =>
      ctx.db.insert("artifactSuggestions", {
        ownerId: alice.ownerId,
        artifactId: ctx.db.normalizeId("artifacts", artifactId)!,
        kind: "source",
        text: "Illustrative suggested outline.",
        changeSummary: "Illustrative change.",
        baseRevision: base,
        evidenceIds: [],
      }),
    );
    expect((await asAlice.mutation(api.artifacts.applySuggestion, { suggestionId, baseRevision: base })).status).toBe("applied");
    expect((await page(link)).body).toBe(shared.body);

    // The share state says a newer revision exists; only the explicit update moves the page to it.
    const now = await current(projectId);
    expect((await asAlice.query(api.shares.getShare, { artifactId }))?.revision).toBe(FIRST_REVISION);
    await asAlice.mutation(api.shares.updateShare, { artifactId, revision: now.revision });
    const updated = await page(link);
    expect(updated.status).toBe(200);
    expect(updated.body).toContain("<p>Illustrative suggested outline.</p>");
    expect(updated.body).not.toContain("Second paragraph");
    expect(await asAlice.query(api.shares.getShare, { artifactId })).toMatchObject({ link, revision: now.revision });
  });

  test("a_share_or_update_names_the_current_revision_or_nothing_changes", async () => {
    const { asAlice, project, artifact, page } = setup();
    const artifactId = await artifact(await project());
    await expect(asAlice.action(api.shares.share, { artifactId, revision: "r-not-current" })).rejects.toThrow(/changed/);
    const { link } = await asAlice.action(api.shares.share, { artifactId, revision: FIRST_REVISION });
    const before = (await page(link)).body;
    await expect(asAlice.mutation(api.shares.updateShare, { artifactId, revision: "r-not-current" })).rejects.toThrow(/changed/);
    expect((await page(link)).body).toBe(before);
    // At most one live share per artifact: sharing again keeps the same link.
    expect((await asAlice.action(api.shares.share, { artifactId, revision: FIRST_REVISION })).link).toBe(link);
  });

  test("stop_kills_the_link_for_good_and_a_re_share_makes_a_new_one", async () => {
    const { asAlice, project, artifact, page, all } = setup();
    const artifactId = await artifact(await project());
    const first = (await asAlice.action(api.shares.share, { artifactId, revision: FIRST_REVISION })).link;
    await asAlice.mutation(api.shares.stopSharing, { artifactId });
    expect(await all("artifactShares")).toEqual([]);
    expect(await asAlice.query(api.shares.getShare, { artifactId })).toBeNull();
    const stopped = await page(first);
    expect(stopped.status).toBe(404);

    const second = (await asAlice.action(api.shares.share, { artifactId, revision: FIRST_REVISION })).link;
    expect(second).not.toBe(first);
    expect((await page(second)).status).toBe(200);
    expect((await page(first)).status).toBe(404);

    // Unknown, malformed and stopped tokens are indistinguishable.
    const unknown = await page(`${SITE}/p/${"A".repeat(43)}`);
    const malformed = await page(`${SITE}/p/not a token`);
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(unknown.body).toBe(stopped.body);
    expect(malformed.body).toBe(stopped.body);
    expect(stopped.body).not.toContain("Illustrative");
  });

  test("tokens_are_stored_only_as_a_hash_and_a_sealed_copy", async () => {
    const { asAlice, project, artifact, all } = setup();
    const artifactId = await artifact(await project());
    const { link } = await asAlice.action(api.shares.share, { artifactId, revision: FIRST_REVISION });
    const token = link.split("/p/")[1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
    const [row] = await all("artifactShares");
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two_artifacts_get_different_tokens_and_a_second_share_returns_the_same_link", async () => {
    const { asAlice, project, artifact, page, all } = setup();
    const first = await artifact(await project("One"));
    const second = await artifact(await project("Two"));
    const a = (await asAlice.action(api.shares.share, { artifactId: first, revision: FIRST_REVISION })).link;
    const b = (await asAlice.action(api.shares.share, { artifactId: second, revision: FIRST_REVISION })).link;
    expect(a).not.toBe(b);
    expect((await page(a)).body).toContain("<h1>One</h1>");
    expect((await page(b)).body).toContain("<h1>Two</h1>");
    expect((await asAlice.action(api.shares.share, { artifactId: first, revision: FIRST_REVISION })).link).toBe(a);
    const rows = await all("artifactShares");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.tokenHash)).size).toBe(2);
  });

  test("another_owner_cannot_share_update_stop_or_read_state", async () => {
    const { asAlice, asBob, project, artifact, page } = setup();
    const artifactId = await artifact(await project());
    await expect(asBob.action(api.shares.share, { artifactId, revision: FIRST_REVISION })).rejects.toThrow(/not found/);
    const { link } = await asAlice.action(api.shares.share, { artifactId, revision: FIRST_REVISION });
    const before = (await page(link)).body;
    await expect(asBob.query(api.shares.getShare, { artifactId })).rejects.toThrow(/not found/);
    await expect(asBob.mutation(api.shares.updateShare, { artifactId, revision: FIRST_REVISION })).rejects.toThrow(/not found/);
    await expect(asBob.mutation(api.shares.stopSharing, { artifactId })).rejects.toThrow(/not found/);
    expect((await page(link)).body).toBe(before);
    expect((await page(link)).status).toBe(200);
  });

  test("the_page_sends_strict_headers_and_escapes_hostile_text", async () => {
    const { asAlice, project, artifact, page } = setup();
    const hostile = `<script>alert(1)</script>\n\n"><img src=x onerror=alert(1)>`;
    const artifactId = await artifact(await project(`<b>Title</b>`), hostile);
    const { link } = await asAlice.action(api.shares.share, { artifactId, revision: FIRST_REVISION });
    const { status, body, headers } = await page(link);
    expect(status).toBe(200);
    expect(body).not.toContain("<script");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<b>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(headers.get("content-security-policy")).toMatch(/^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    const missing = await page(`${SITE}/p/${"B".repeat(43)}`);
    for (const name of ["content-security-policy", "cache-control", "x-robots-tag", "referrer-policy", "x-content-type-options"]) {
      expect(missing.headers.get(name)).toBe(headers.get(name));
    }
  });
});

// ---- The run a mail starts never shares and never moves a shared page.
const RESPONSES_URL = "https://api.openai.com/v1/responses";

describe("the run a mail starts and sharing", () => {
  test("a_run_creates_no_share_and_leaves_a_shared_page_byte_identical", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-11-14T15:00:00.000Z"));
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    vi.stubEnv("OPENAI_MODEL", "test-model");
    const { t, alice, asAlice, project, page, all } = setup();
    await asAlice.mutation(api.briefs.setAttentionSettings, { timezone: "America/New_York" }); // a due time needs the user's zone
    const budget = await project("Budget");
    // Each run records its mail's request and writes the next revision of the draft.
    const output = (n: number, body: string) => {
      const step = n % 3;
      if (step === 0) return [{ type: "function_call", call_id: `c${n}`, name: "start_request", arguments: JSON.stringify({ projectId: budget, request: "Send the budget to Dana", dueLocal: "2026-11-14T17:00" }) }];
      if (step === 1) return [{ type: "function_call", call_id: `c${n}`, name: "write_draft", arguments: JSON.stringify({ title: "Budget for Dana", form: "document", text: body, changeSummary: "Drafted." }) }];
      return [{ type: "message", content: [{ type: "output_text", text: "I drafted the budget." }] }];
    };
    let calls = 0;
    const model = vi.fn<(url: string) => Promise<Response>>(async () => {
      const n = calls++;
      return new Response(JSON.stringify({ status: "completed", output: output(n, `Illustrative draft ${Math.floor(n / 3) + 1}.`) }));
    });
    vi.stubGlobal("fetch", model);
    let sourceId: string | undefined;
    const ingest = async (text: string): Promise<Evidence> => {
      const record = makeEvidence(alice.ownerId, [budget], { text, ...(sourceId ? { sourceId: sourceId as Evidence["sourceId"] } : {}) });
      if (sourceId === undefined) {
        sourceId = record.sourceId;
        await asAlice.mutation(api.evidence.setGrant, {
          id: sourceId,
          kind: "gmail",
          selectors: ["illustrative-label"],
          projectIds: [budget],
          read: true,
          writeTargets: [],
          cloudProcessing: true,
          version: 1,
          state: "active",
        });
      }
      expect(await t.mutation(internal.evidence.ingest, { ownerId: alice.ownerId, sourceId, record })).toBe("accepted");
      return record;
    };
    const settle = async () => {
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(5);
        await t.finishInProgressScheduledFunctions();
      }
    };

    await ingest("Alice, please send the budget to Dana by 5pm today.");
    await settle();
    expect(model).toHaveBeenCalledTimes(3);
    const draft = (await asAlice.query(api.artifacts.getArtifact, { projectId: budget }))!;
    expect(draft).toMatchObject({ revision: FIRST_REVISION, text: "Illustrative draft 1." }); // the run drafted it ...
    expect(await all("artifactShares")).toEqual([]); // ... and shared nothing

    const { link } = await asAlice.action(api.shares.share, { artifactId: draft.id, revision: draft.revision });
    const before = (await page(link)).body;
    await ingest("Alice, Dana also needs the budget by 5pm.");
    await settle();
    expect(model).toHaveBeenCalledTimes(6);
    expect(await asAlice.query(api.artifacts.getArtifact, { projectId: budget })).toMatchObject({ text: "Illustrative draft 2." }); // a new revision ...
    expect(await all("artifactShares")).toHaveLength(1); // ... and the share still names the one it was made for
    expect((await page(link)).body).toBe(before);
    expect(model.mock.calls.every(([url]) => url === RESPONSES_URL)).toBe(true);
  });
});
