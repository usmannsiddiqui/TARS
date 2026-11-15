// @vitest-environment edge-runtime
// T12 acceptance: privacy (revoke, disconnect, forget) and recovery, driven end to end through the
// real Convex functions. Only the outside world is stubbed: provider HTTP and the model, via `fetch`.
// Fixture-only: every provider and model response is illustrative.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProjectIdSchema, SourceIdSchema, type Evidence, type ProjectId, type SourceKind } from "@companion/domain";
import { contentHash } from "../../packages/domain/src/actions";
import type { PreparationOutput } from "../../packages/domain/src/prepare";
import { api, internal } from "../../convex/_generated/api";
import { encryptSecret } from "../../convex/lib/crypto";
import { sealCredential } from "../../convex/lib/providerAuth";
import schema from "../../convex/schema";
import { makeEvidence, makeOwners } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL_KEY = "sk-illustrative-model-key";
const SLACK_SECRET = "illustrative-slack-signing-secret";
const NOTION_TOKEN = "ntn_illustrative_integration_token";
const NOTION_VERIFICATION = "secret_illustrative_verification_token";
const CANVAS_TOKEN = "illustrative-canvas-user-token";
const GOOGLE_REFRESH = "1//illustrative-google-refresh-token";
const PAGE = "1f2e3d4c5b6a47898abcdef012345678";
const LOG_PAGE = "1f0aaaaabbbbccccddddeeeeffff0001";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const NOTION = "https://api.notion.com/v1";
const BOB = "bob@illustrative.example";

beforeEach(() => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", btoa(String.fromCharCode(...key)));
  vi.stubEnv("OPENAI_API_KEY", MODEL_KEY);
  vi.stubEnv("OPENAI_MODEL", "test-model");
  vi.stubEnv("SLACK_SIGNING_SECRET", SLACK_SECRET);
  vi.stubEnv("GOOGLE_CLIENT_ID", "illustrative-google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "illustrative-google-client-secret");
  // Until a test stubs the outside world, nothing (an automatic preparation included) reaches it.
  vi.stubGlobal("fetch", async () => {
    throw new Error("unexpected fetch");
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---- fetch stub: longest matching URL prefix wins; every call is recorded.
type Call = { method: string; url: string; body: string };
type Stub = (call: Call) => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let calls: Call[] = [];
function stubFetch(routes: Record<string, Stub>) {
  calls = [];
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const call = { method: init.method ?? "GET", url: decodeURIComponent(url), body: String(init.body ?? "") };
    calls.push(call);
    const match = prefixes.find((prefix) => call.url.startsWith(prefix));
    if (match === undefined) throw new Error(`Unexpected fetch ${call.method} ${call.url}`);
    return routes[match]!(call);
  });
}

// ---- Model stub: the Responses API envelope carrying what the "model" says.
const completed = (output: PreparationOutput) =>
  json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
const prepared = (overrides: Partial<PreparationOutput>): PreparationOutput => ({
  title: "AVT budget follow-up",
  body: "Illustrative summary.",
  evidenceIds: [],
  gaps: [],
  nextAction: "Open the budget note.",
  commitments: [],
  facts: [],
  ...overrides,
});
/** The JSON document sent to the model on model call `n`. */
function modelInput(n = 0): { evidence: { id: string; text: string }[]; memory: { key: string; value: string }[]; forgottenKeys: string[] } {
  const call = calls.filter((c) => c.url === RESPONSES_URL)[n]!;
  return JSON.parse((JSON.parse(call.body) as { input: string }).input);
}

const grantFor = (id: string, kind: SourceKind, projectId: ProjectId, overrides: Record<string, unknown> = {}) => ({
  id,
  kind,
  selectors: kind === "notion" ? [PAGE] : kind === "obsidian" ? [] : ["illustrative-selector"],
  projectIds: [projectId],
  read: true,
  writeTargets: [],
  cloudProcessing: true,
  version: 1,
  state: "active",
  ...overrides,
});

async function setup() {
  const t = convexTest(schema, modules);
  const { alice } = makeOwners();
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const projectId = ProjectIdSchema.parse(await asAlice.mutation(api.projects.createProject, { name: "AVT" }));
  /** A cloud source with one ingested record, through the provider-webhook intake path. */
  const cloudEvidence = async (text: string, kind: SourceKind = "slack", grant: Record<string, unknown> = {}): Promise<Evidence> => {
    const record = makeEvidence(alice.ownerId, [projectId], { text });
    await asAlice.mutation(api.evidence.setGrant, grantFor(record.sourceId, kind, projectId, grant));
    expect(await t.mutation(internal.evidence.ingest, { ownerId: alice.ownerId, sourceId: record.sourceId, record })).toBe("accepted");
    return record;
  };
  const prepare = () => asAlice.action(api.prepare.prepareProject, { projectId });
  const work = () => asAlice.query(api.prepare.getPreparedWork, { projectId });
  const commitments = () => asAlice.query(api.prepare.listCommitments, { projectId });
  const memory = () => asAlice.query(api.memory.listMemory, { projectId });
  const withheld = () => asAlice.query(api.memory.listWithheld, { projectId });
  const evidenceRows = () => t.run((ctx) => ctx.db.query("evidence").collect());
  const scheduled = () => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return { t, alice, asAlice, projectId, cloudEvidence, prepare, work, commitments, memory, withheld, evidenceRows, scheduled };
}

// ======================================================================

describe("revoke", () => {
  test("revoke_invalidates_queued_model_and_observer_output", async () => {
    const s = await setup();
    // A local (desktop-observed) source, admitted under grant version 1 through the desktop hand-off.
    const local = makeEvidence(s.alice.ownerId, [s.projectId], {
      text: "Observed note: Alice will email the AVT budget to Dana by Friday.",
    });
    const localGrant = grantFor(local.sourceId, "obsidian", s.projectId);
    await s.asAlice.mutation(api.evidence.setGrant, localGrant);
    expect(await s.asAlice.mutation(api.localEvidence.submit, { record: local })).toBe("accepted");
    // A second, untouched source in the same project.
    const kept = await s.cloudEvidence("Illustrative Slack note: the AVT pitch is on Tuesday.");
    // The automatic preparation the new evidence scheduled runs now (and fails: no model yet), not mid-scenario.
    await s.t.finishAllScheduledFunctions(() => {});

    const output = prepared({
      body: "Alice will email the AVT budget to Dana by Friday; the pitch is Tuesday.",
      evidenceIds: [local.id, kept.id],
      commitments: [
        {
          text: "Email the AVT budget to Dana",
          holder: "user",
          holderName: null,
          explicit: true,
          quote: "Alice will email the AVT budget to Dana by Friday",
          dueAt: null,
          evidenceIds: [local.id],
        },
      ],
      facts: [{ key: "budget_recipient", value: "Dana", evidenceIds: [local.id] }],
    });

    // The model call is held open until the revoke has landed.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let modelCalled!: () => void;
    const modelStarted = new Promise<void>((resolve) => (modelCalled = resolve));
    stubFetch({
      [RESPONSES_URL]: async () => {
        modelCalled();
        await held;
        return completed(output);
      },
    });
    const inFlight = s.prepare();
    await modelStarted;
    expect(modelInput().evidence.map((e) => e.id).sort()).toEqual([local.id, kept.id].sort());

    // The user revokes the local source: the desktop mirrors the next grant version, state revoked.
    await s.asAlice.mutation(api.evidence.setGrant, { ...localGrant, version: 2, state: "revoked" });

    // Observer output queued (or already in flight) under version 1 is denied at intake,
    // and so is anything stamped with the revoked version.
    const queued = makeEvidence(s.alice.ownerId, [s.projectId], {
      sourceId: local.sourceId,
      text: "Observed note: budget draft v2 is in the shared folder.",
    });
    expect(await s.asAlice.mutation(api.localEvidence.submit, { record: queued })).toBe("denied");
    expect(await s.asAlice.mutation(api.localEvidence.submit, { record: { ...queued, grantVersion: 2 } })).toBe("denied");
    expect((await s.evidenceRows()).map((row) => row.id).sort()).toEqual([local.id, kept.id].sort());

    // The model answers now: its result was built from revoked evidence and is not stored or surfaced.
    release();
    expect(await inFlight).toEqual({ status: "needs-retry", code: "sources_changed" });
    const row = await s.work();
    expect(row).toMatchObject({ status: "needs-retry", lastError: "sources_changed" });
    expect(row?.work).toBeUndefined();
    expect(await s.commitments()).toEqual([]);
    expect(await s.memory()).toEqual([]);
    expect(await s.withheld()).toEqual([]);

    // Afterwards: the next preparation sees only the source still granted, and a model that
    // cites the revoked record anyway cannot bring it back.
    stubFetch({ [RESPONSES_URL]: () => completed(output) });
    expect(await s.prepare()).toEqual({ status: "ready" });
    expect(modelInput().evidence.map((e) => e.id)).toEqual([kept.id]);
    expect((await s.work())?.work?.evidenceIds).toEqual([kept.id]);
    const surfaced = JSON.stringify([await s.work(), await s.commitments(), await s.memory(), await s.withheld()]);
    expect(surfaced).not.toContain(local.id);
    expect(surfaced).not.toMatch(/budget_recipient|Email the AVT budget/);
  });

  // Build contract: revoke stops future reads and drops queued and in-flight results. It is not deletion.
  // What was prepared earlier stays until the user forgets or deletes it; the product never claims otherwise.
  test("revoke_is_not_deletion_of_earlier_output", async () => {
    const s = await setup();
    const local = makeEvidence(s.alice.ownerId, [s.projectId], {
      text: "Observed note: Alice will email the AVT budget to Dana by Friday.",
    });
    const localGrant = grantFor(local.sourceId, "obsidian", s.projectId);
    await s.asAlice.mutation(api.evidence.setGrant, localGrant);
    expect(await s.asAlice.mutation(api.localEvidence.submit, { record: local })).toBe("accepted");
    stubFetch({
      [RESPONSES_URL]: () =>
        completed(
          prepared({
            body: "Alice will email the AVT budget to Dana by Friday.",
            evidenceIds: [local.id],
            commitments: [
              { text: "Email the AVT budget to Dana", holder: "user", holderName: null, explicit: true, quote: "Alice will email the AVT budget to Dana by Friday", dueAt: null, evidenceIds: [local.id] },
            ],
            facts: [{ key: "budget_recipient", value: "Dana", evidenceIds: [local.id] }],
          }),
        ),
    });
    expect(await s.prepare()).toEqual({ status: "ready" });

    await s.asAlice.mutation(api.evidence.setGrant, { ...localGrant, version: 2, state: "revoked" });

    expect((await s.work())?.work?.evidenceIds).toEqual([local.id]);
    expect(await s.commitments()).toHaveLength(1);
    expect(JSON.stringify(await s.memory())).toContain("budget_recipient");
    // The revoked source itself admits nothing further.
    const late = makeEvidence(s.alice.ownerId, [s.projectId], { text: "Arrived after the revoke." });
    expect(await s.asAlice.mutation(api.localEvidence.submit, { record: { ...late, sourceId: local.sourceId } })).not.toBe("accepted");
  });
});

// ======================================================================

describe("disconnect", () => {
  type Source = { kind: SourceKind; sourceId: string };
  /** Seed a connected source with a sealed credential, as its connect flow leaves it. */
  async function connected(s: Awaited<ReturnType<typeof setup>>, kind: "notion" | "canvas" | "gmail"): Promise<Source> {
    const sourceId = `source-${kind}-${crypto.randomUUID()}`;
    await s.asAlice.mutation(api.evidence.setGrant, grantFor(sourceId, kind, s.projectId));
    const secrets: Record<string, Record<string, string>> = {
      notion: { token: NOTION_TOKEN },
      canvas: { baseUrl: "https://canvas.illustrative.edu", token: CANVAS_TOKEN },
      gmail: { refreshToken: GOOGLE_REFRESH },
    };
    await s.t.mutation(internal.connections.save, {
      ownerId: s.alice.ownerId,
      sourceId,
      provider: kind,
      accountKey: kind === "gmail" ? "alice@illustrative.example" : sourceId,
      credential: await sealCredential(secrets[kind]!),
    });
    if (kind === "notion") {
      await s.t.mutation(internal.connections.setWebhookSecret, { sourceId, webhookSecret: await encryptSecret(NOTION_VERIFICATION) });
    }
    return { kind, sourceId };
  }

  async function notionEvent(s: Awaited<ReturnType<typeof setup>>, sourceId: string) {
    const body = JSON.stringify({ id: crypto.randomUUID(), type: "page.content_updated", entity: { id: PAGE, type: "page" } });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(NOTION_VERIFICATION), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    const signature = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
    return s.t.fetch(`/notion/events?source=${encodeURIComponent(sourceId)}`, {
      method: "POST",
      body,
      headers: { "x-notion-signature": `sha256=${signature}` },
    });
  }

  test("disconnect_does_not_claim_deletion", async () => {
    const s = await setup();
    const sources = [await connected(s, "notion"), await connected(s, "canvas"), await connected(s, "gmail")];
    const earlier = await s.cloudEvidence("Illustrative note already read before disconnecting.", "slack");
    const sourcesBefore = await s.t.run((ctx) => ctx.db.query("connections").collect());

    // Any provider call from here on would mean the stored credential is still being used.
    stubFetch({});
    for (const { sourceId } of sources) {
      // What the client gets back for Disconnect: nothing that claims anything was deleted.
      expect(await s.asAlice.mutation(api.evidence.setGrantState, { sourceId, state: "revoked" })).toBeNull();
    }
    await s.asAlice.mutation(api.evidence.setGrantState, { sourceId: earlier.sourceId, state: "revoked" });
    // Gmail's one scheduled cleanup (users.stop) is a watch stop, not deletion; let it run against no network.
    await s.t.finishAllScheduledFunctions(() => {});
    calls = [];

    // Status shown to the client: disconnected, and no wording that claims deletion anywhere.
    const status = await s.asAlice.query(api.connections.listConnections, {});
    expect(status.map((row) => row.state)).toEqual(["revoked", "revoked", "revoked"]);
    expect(JSON.stringify(status)).not.toMatch(/delet|eras|purg|wip|remov/i);

    // Intake stops: a validly signed provider event is acknowledged but nothing is fetched or stored,
    // and a record mapped to the old grant version is denied.
    expect((await notionEvent(s, sources[0]!.sourceId)).status).toBe(200);
    const late = makeEvidence(s.alice.ownerId, [s.projectId], { sourceId: SourceIdSchema.parse(sources[0]!.sourceId), text: "Illustrative late page." });
    expect(await s.t.mutation(internal.evidence.ingest, { ownerId: s.alice.ownerId, sourceId: late.sourceId, record: late })).toBe("denied");

    // The stored credential is no longer usable from any user-triggered path.
    await expect(s.asAlice.action(api.connectors.canvas.refreshByUser, { sourceId: sources[1]!.sourceId })).rejects.toThrow(/disconnected/i);
    await expect(s.asAlice.action(api.connectors.gmail.refresh, { sourceId: sources[2]!.sourceId })).rejects.toThrow(/disconnected/i);
    await expect(
      s.asAlice.action(api.connectors.notion.connect, { sourceId: sources[0]!.sourceId, token: NOTION_TOKEN }),
    ).rejects.toThrow(/disconnected/i);
    expect(calls).toEqual([]);

    // The truth the wording must not contradict: Disconnect deletes nothing. Already-read evidence and
    // the sealed connection rows stay stored (out of scope, never used); provider-side data is untouched.
    expect((await s.evidenceRows()).map((row) => row.id)).toEqual([earlier.id]);
    const sourcesAfter = await s.t.run((ctx) => ctx.db.query("connections").collect());
    expect(sourcesAfter.map((row) => [row.sourceId, row.credential])).toEqual(sourcesBefore.map((row) => [row.sourceId, row.credential]));
    // And it is out of scope: preparation finds nothing to read.
    expect(await s.prepare()).toEqual({ status: "empty", code: "no_evidence" });
  });
});

// ======================================================================

describe("forget", () => {
  test("forget_invalidates_cached_summary", async () => {
    const s = await setup();
    const note = await s.cloudEvidence("Illustrative note: Alice wants the AVT deck in a playful tone.");
    await s.asAlice.mutation(api.memory.remember, {
      projectId: s.projectId,
      key: "deck_tone",
      value: "playful",
      evidenceIds: [note.id],
      scope: "project",
      explicitUserInstruction: true,
    });
    stubFetch({ [RESPONSES_URL]: () => completed(prepared({ body: "Draft the deck in a playful tone.", evidenceIds: [note.id] })) });
    await s.prepare();
    expect(modelInput().memory).toEqual([{ key: "deck_tone", value: "playful" }]);
    const summary = await s.work();
    expect(summary).toMatchObject({ status: "ready", factKeys: ["deck_tone"] });
    expect(summary?.work?.body).toMatch(/playful/);

    await s.asAlice.mutation(api.memory.forget, { projectId: s.projectId, key: "deck_tone" });

    // The cached summary that used the fact is gone, not merely flagged.
    const invalidated = await s.work();
    expect(invalidated?.status).toBe("invalidated");
    expect(invalidated?.work).toBeUndefined();
    expect(await s.memory()).toEqual([]);

    // Regenerated without it: the fact is not sent to the model, only named as forgotten. The same fact
    // arriving again from a new source is not silently relearned; a different key from the forgotten
    // evidence is withheld for the user to review.
    const again = await s.cloudEvidence("Illustrative note: keep the AVT deck playful.");
    stubFetch({
      [RESPONSES_URL]: () =>
        completed(
          prepared({
            body: "Draft the deck.",
            evidenceIds: [note.id, again.id],
            facts: [
              { key: "deck_tone", value: "playful", evidenceIds: [again.id] },
              { key: "slide_mood", value: "light-hearted", evidenceIds: [note.id] },
            ],
          }),
        ),
    });
    expect(await s.prepare()).toEqual({ status: "ready" });
    expect(modelInput().memory).toEqual([]);
    expect(modelInput().forgottenKeys).toEqual(["deck_tone"]);
    expect(await s.memory()).toEqual([]);
    expect((await s.work())?.factKeys).not.toContain("deck_tone");
    expect((await s.withheld()).map((w) => [w.key, w.value])).toEqual([["slide_mood", "light-hearted"]]);
    // The user path refuses it too, until relearning is allowed.
    const rememberAgain = () =>
      s.asAlice.mutation(api.memory.remember, {
        projectId: s.projectId,
        key: "deck_tone",
        value: "playful",
        evidenceIds: [again.id],
        scope: "project",
        explicitUserInstruction: true,
      });
    await expect(rememberAgain()).rejects.toThrow(/allow relearning/);

    await s.asAlice.mutation(api.memory.allowRelearning, { projectId: s.projectId, key: "deck_tone" });
    stubFetch({
      [RESPONSES_URL]: () =>
        completed(prepared({ evidenceIds: [again.id], facts: [{ key: "deck_tone", value: "playful", evidenceIds: [again.id] }] })),
    });
    await s.prepare();
    expect((await s.memory()).map((f) => [f.key, f.value])).toEqual([["deck_tone", "playful"]]);
    expect((await s.work())?.factKeys).toContain("deck_tone");
  });
});

// ======================================================================

describe("recovery", () => {
  test("duplicate_provider_delivery_stores_one_record", async () => {
    const s = await setup();
    const sourceId = `source-slack-${crypto.randomUUID()}`;
    await s.asAlice.mutation(api.evidence.setGrant, { ...grantFor(sourceId, "slack", s.projectId), selectors: ["C0SELECTED"] });
    stubFetch({
      "https://slack.com/api/auth.test": () => json({ ok: true, team_id: "T0ILLUSTRATIVE" }),
      "https://slack.com/api/conversations.history": () => json({ ok: true, messages: [] }),
    });
    await s.asAlice.action(api.connectors.slack.connect, { sourceId, botToken: "xoxb-illustrative-bot-token" });
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T0ILLUSTRATIVE",
      event_id: "Ev-1",
      event: { type: "message", channel: "C0SELECTED", user: "U0ALICE", text: "Illustrative: I'll send the deck Friday.", ts: "1763150400.000100" },
    });
    const deliver = async () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SLACK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
      const signature = `v0=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
      return s.t.fetch("/slack/events", { method: "POST", body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } });
    };
    // Slack retries an event it thinks was not acknowledged; both deliveries are acknowledged.
    expect((await deliver()).status).toBe(200);
    expect((await deliver()).status).toBe(200);
    expect(await s.evidenceRows()).toHaveLength(1);
  });

  test("model_failure_keeps_previous_prepared_work_and_reports_honestly", async () => {
    const s = await setup();
    // No cloud-processing consent: nothing is prepared automatically, so every job here would be a retry.
    const note = await s.cloudEvidence("Illustrative note: Alice, you will run the AVT demo.", "slack", { cloudProcessing: false });
    stubFetch({
      [RESPONSES_URL]: () =>
        completed(
          prepared({
            evidenceIds: [note.id],
            commitments: [
              { text: "Run the AVT demo", holder: "user", holderName: null, explicit: true, quote: "Alice, you will run the AVT demo", dueAt: null, evidenceIds: [note.id] },
            ],
          }),
        ),
    });
    await s.prepare();
    const before = await s.work();
    const tasks = await s.commitments();
    expect(before?.status).toBe("ready");

    // The provider echoes the request (key, evidence text) in its error body: none of it may surface.
    stubFetch({ [RESPONSES_URL]: () => json({ error: `upstream failed for ${MODEL_KEY}: ${note.text}` }, 503) });
    expect(await s.prepare()).toEqual({ status: "needs-retry", code: "http_503" });
    const after = await s.work();
    expect(after?.status).toBe("needs-retry"); // not shown as freshly ready
    expect(after?.lastError).toBe("http_503");
    expect(after?.work).toEqual(before?.work);
    expect(after!.updatedAt >= before!.updatedAt).toBe(true);
    expect(await s.commitments()).toEqual(tasks);
    expect(JSON.stringify(after)).not.toContain(MODEL_KEY);
    expect(after?.lastError).not.toContain("AVT demo");
    expect(await s.scheduled()).toEqual([]); // no retry timer: the user's Retry resumes
  });

  // ---- Actions: a fake Gmail mailbox and a fake Notion log page behind the fetch stub.
  const fromB64 = (value: string) =>
    new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "")), (c) => c.charCodeAt(0)));
  const toB64url = (text: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  async function actionSetup(gmailSend: (store: () => string) => Response, notionAppend: (store: () => string) => Response) {
    const s = await setup();
    type Sent = { id: string; to: string; messageId: string; body: string };
    const mailbox: Sent[] = [];
    const logBlocks: { id: string; text: string }[] = [];
    const sentView = (m: Sent) => ({
      id: m.id,
      labelIds: ["SENT"],
      payload: { headers: [{ name: "To", value: m.to }, { name: "Message-ID", value: m.messageId }], mimeType: "text/plain", body: { data: toB64url(m.body) } },
    });
    const routes: Record<string, Stub> = {
      [GOOGLE_TOKEN]: () => json({ access_token: "illustrative-access" }),
      [`${GMAIL}/messages/send`]: (call) =>
        gmailSend(() => {
          const raw = fromB64((JSON.parse(call.body) as { raw: string }).raw);
          const [head, encoded] = raw.split("\r\n\r\n") as [string, string];
          const header = (name: string) => new RegExp(`^${name}: (.*)$`, "mi").exec(head)?.[1] ?? "";
          mailbox.push({ id: `m${mailbox.length + 1}`, to: header("To"), messageId: header("Message-ID"), body: fromB64(encoded) });
          return mailbox.at(-1)!.id;
        }),
      [`${GMAIL}/messages?q=`]: (call) => {
        const found = mailbox.filter((m) => call.url.includes(m.messageId.slice(1, -1)));
        return json(found.length === 0 ? {} : { messages: found.map((m) => ({ id: m.id })) });
      },
      [`${GMAIL}/messages/`]: (call) => {
        const found = mailbox.find((m) => call.url.includes(`/messages/${m.id}?`));
        return found === undefined ? json({}, 404) : json(sentView(found));
      },
      [`${NOTION}/blocks/`]: (call) => {
        if (call.method === "PATCH") {
          const text = (JSON.parse(call.body) as { children: { paragraph: { rich_text: { text: { content: string } }[] } }[] }).children[0]!
            .paragraph.rich_text.map((r) => r.text.content)
            .join("");
          return notionAppend(() => {
            logBlocks.push({ id: `b${logBlocks.length + 1}`, text });
            return `b${logBlocks.length}`;
          });
        }
        const view = (b: { id: string; text: string }) => ({ id: b.id, type: "paragraph", parent: { page_id: LOG_PAGE }, paragraph: { rich_text: [{ plain_text: b.text }] } });
        if (/\/children/.test(call.url)) return json({ results: logBlocks.map(view), has_more: false, next_cursor: null });
        const found = logBlocks.find((b) => call.url.endsWith(`/blocks/${b.id}`));
        return found === undefined ? json({}, 404) : json(view(found));
      },
    };
    stubFetch(routes);
    await s.t.run((ctx) =>
      ctx.db.insert("preparedWork", {
        ownerId: s.alice.ownerId,
        projectId: s.projectId,
        work: { projectId: s.projectId, title: "Follow-up", body: "AVT follow-up", evidenceIds: [], gaps: [], nextAction: "Send it.", state: "ready" },
        factKeys: [],
        status: "ready",
        updatedAt: "2026-11-14T08:00:00.000Z",
      }),
    );
    const artifactId = await s.asAlice.mutation(api.artifacts.createFromPrepared, { projectId: s.projectId });
    const artifact = await s.t.run((ctx) => ctx.db.get(ctx.db.normalizeId("artifacts", artifactId)!));
    await s.asAlice.mutation(api.evidence.setGrant, grantFor("source-gmail", "gmail", s.projectId));
    const save = { ownerId: s.alice.ownerId, sourceId: "source-gmail", provider: "gmail" };
    await s.t.mutation(internal.connections.save, { ...save, accountKey: "alice@illustrative.example", credential: await sealCredential({ refreshToken: "read-refresh" }) });
    await s.t.mutation(internal.actions.saveSendPermission, { ...save, credential: await sealCredential({ refreshToken: "send-refresh" }) });
    await s.asAlice.mutation(api.evidence.setGrant, { ...grantFor("source-notion", "notion", s.projectId), selectors: [LOG_PAGE], writeTargets: [LOG_PAGE] });
    await s.t.mutation(internal.connections.save, {
      ownerId: s.alice.ownerId,
      sourceId: "source-notion",
      provider: "notion",
      accountKey: "source-notion",
      credential: await sealCredential({ token: NOTION_TOKEN }),
    });
    await s.asAlice.mutation(api.actions.setLogDestination, { projectId: s.projectId, kind: "notion", target: LOG_PAGE });
    const intent = {
      projectId: s.projectId as string,
      kind: "send-mail" as const,
      destination: BOB,
      artifactId,
      revision: artifact!.revision,
      contentHash: await contentHash(artifact!.text),
      instructionId: `instruction-${crypto.randomUUID()}`,
    };
    const execute = async () => {
      const result = await s.asAlice.action(api.actions.executeIntent, intent);
      if (!("id" in result)) throw new Error(`expected a receipt, got ${result.reason}`);
      return result;
    };
    const sends = () => calls.filter((c) => c.url === `${GMAIL}/messages/send`).length;
    return { ...s, execute, sends, mailbox, logBlocks };
  }

  const timeout = () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  };

  test("action_timeout_after_success_is_unknown_and_never_resent", async () => {
    const s = await actionSetup(
      (store) => {
        store(); // delivered, but the response is lost
        return timeout();
      },
      () => json({}),
    );
    const first = await s.execute();
    expect(first).toMatchObject({ state: "unknown", reason: "timeout" });
    expect(first.verifiedAt).toBeUndefined();
    // Retrying the same instruction returns the outstanding receipt; nothing is sent again.
    expect(await s.execute()).toMatchObject({ id: first.id, state: "unknown" });
    expect(s.sends()).toBe(1);
    expect(s.mailbox).toHaveLength(1);
  });

  test("failed_outcome_log_retries_only_the_log", async () => {
    let failLog = true;
    const s = await actionSetup(
      (store) => json({ id: store() }),
      (store) => {
        if (failLog) {
          failLog = false;
          return json({ object: "error" }, 503);
        }
        return json({ results: [{ id: store() }] });
      },
    );
    const sent = await s.execute();
    expect(sent).toMatchObject({ state: "succeeded", logState: "failed" });
    // Retrying the same instruction does not resend; the user's log retry writes only the log.
    expect(await s.execute()).toMatchObject({ id: sent.id, state: "succeeded", logState: "failed" });
    const retried = await s.asAlice.action(api.actions.appendOutcomeLog, { actionId: sent.id });
    expect(retried).toMatchObject({ id: sent.id, state: "succeeded", logState: "written" });
    expect(s.sends()).toBe(1);
    expect(s.logBlocks).toHaveLength(1);
  });
});
