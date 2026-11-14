// @vitest-environment edge-runtime
// Fixture-only: every provider response here is an illustrative stub of `fetch`.
// These tests prove adapter logic, never live provider access.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProjectId, SourceKind } from "@companion/domain";
import { api } from "../../convex/_generated/api";
import { consumeOAuthState, issueOAuthState } from "../../convex/lib/providerAuth";
import schema from "../../convex/schema";
import { makeOwners, makeProjects } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");

const SLACK_SECRET = "illustrative-slack-signing-secret";
const SLACK_TOKEN = "xoxb-illustrative-bot-token";
const NOTION_TOKEN = "ntn_illustrative_integration_token";
const NOTION_VERIFICATION = "secret_illustrative_verification_token";
const CANVAS_TOKEN = "illustrative-canvas-user-token";
const CANVAS_BASE = "https://canvas.illustrative.edu";
const TEAM = "T0ILLUSTRATIVE";
const CHANNEL = "C0SELECTED";
const PAGE = "1f2e3d4c-5b6a-4789-8abc-def012345678";
const LOG_PAGE = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";

beforeEach(() => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", btoa(String.fromCharCode(...key)));
  vi.stubEnv("SLACK_SIGNING_SECRET", SLACK_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Stub = (url: URL) => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stubs global fetch; `routes` keys are matched as URL prefixes. Records each requested URL. */
function stubFetch(routes: Record<string, Stub>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(url.toString());
    const match = Object.keys(routes).find((prefix) => url.toString().startsWith(prefix));
    if (match === undefined) throw new Error(`Unexpected fetch ${url.toString()}`);
    return routes[match]!(url);
  });
  return calls;
}

const slackOk: Record<string, Stub> = {
  "https://slack.com/api/auth.test": () => json({ ok: true, team_id: TEAM }),
  "https://slack.com/api/conversations.history": () => json({ ok: true, messages: [] }),
};

function notionPage(lastEdited: string, inTrash = false): Record<string, Stub> {
  return {
    "https://api.notion.com/v1/users/me": () => json({ object: "user", id: "bot-1", type: "bot" }),
    "https://api.notion.com/v1/pages/": () =>
      json({
        object: "page",
        id: PAGE,
        last_edited_time: lastEdited,
        url: "https://www.notion.so/Illustrative-AVT-plan",
        in_trash: inTrash,
        properties: { title: { type: "title", title: [{ plain_text: "AVT plan" }] } },
      }),
    "https://api.notion.com/v1/blocks/": () =>
      json({
        object: "list",
        results: [
          { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Illustrative: send pitch outline." }] } },
        ],
        has_more: false,
        next_cursor: null,
      }),
  };
}

async function setup(kind: SourceKind, overrides: { selectors?: string[]; writeTargets?: string[] } = {}) {
  const t = convexTest(schema, modules);
  const { alice, bob } = makeOwners();
  const { avt } = makeProjects(alice.ownerId);
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const asBob = t.withIdentity({ tokenIdentifier: bob.ownerId, subject: "bob" });
  const sourceId = `source-${kind}-${crypto.randomUUID()}`;
  const defaults: Record<string, string[]> = { slack: [CHANNEL], notion: [PAGE], canvas: ["42"] };
  await asAlice.mutation(api.evidence.setGrant, {
    id: sourceId,
    kind,
    selectors: overrides.selectors ?? defaults[kind] ?? [],
    projectIds: [avt.id as ProjectId],
    read: true,
    writeTargets: overrides.writeTargets ?? [],
    cloudProcessing: true,
    version: 1,
    state: "active",
  });
  const evidence = () => t.run((ctx) => ctx.db.query("evidence").collect());
  const scheduled = () => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  const connection = () => asAlice.query(api.connections.listConnections, {}).then((rows) => rows[0]);
  return { t, alice, bob, avt, asAlice, asBob, sourceId, evidence, scheduled, connection };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

// ---- Slack delivery helpers
async function connectSlack(ctx: Ctx) {
  stubFetch(slackOk);
  await ctx.asAlice.action(api.connectors.slack.connect, { sourceId: ctx.sourceId, botToken: SLACK_TOKEN });
}

function slackMessage(channel: string, ts = "1763150400.000100") {
  return {
    type: "event_callback",
    team_id: TEAM,
    api_app_id: "A0ILLUSTRATIVE",
    event_id: `Ev-${ts}`,
    event_time: Math.floor(Date.now() / 1000),
    event: { type: "message", channel, user: "U0ALICE", text: "Illustrative: I'll send the deck Friday.", ts },
  };
}

async function postSlack(ctx: Ctx, payload: unknown, opts: { timestamp?: number; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = `v0=${await hmacHex(opts.secret ?? SLACK_SECRET, `v0:${timestamp}:${body}`)}`;
  return ctx.t.fetch("/slack/events", {
    method: "POST",
    body,
    headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
  });
}

// ---- Notion delivery helpers
async function connectNotion(ctx: Ctx) {
  // Initial bounded read finds the selected page in the trash, so it stores nothing.
  stubFetch(notionPage("2026-11-14T10:00:00.000Z", true));
  await ctx.asAlice.action(api.connectors.notion.connect, { sourceId: ctx.sourceId, token: NOTION_TOKEN });
  const handshake = await ctx.t.fetch(`/notion/events?source=${encodeURIComponent(ctx.sourceId)}`, {
    method: "POST",
    body: JSON.stringify({ verification_token: NOTION_VERIFICATION }),
  });
  expect(handshake.status).toBe(200);
}

function notionEvent(pageId: string, id = crypto.randomUUID()) {
  return {
    id,
    timestamp: "2026-11-14T12:00:00.000Z",
    workspace_id: "ws-illustrative",
    subscription_id: "sub-illustrative",
    integration_id: "int-illustrative",
    type: "page.content_updated",
    authors: [{ id: "user-1", type: "person" }],
    attempt_number: 1,
    entity: { id: pageId, type: "page" },
    data: {},
  };
}

async function postNotion(ctx: Ctx, payload: unknown, secret = NOTION_VERIFICATION) {
  const body = JSON.stringify(payload);
  return ctx.t.fetch(`/notion/events?source=${encodeURIComponent(ctx.sourceId)}`, {
    method: "POST",
    body,
    headers: { "x-notion-signature": `sha256=${await hmacHex(secret, body)}` },
  });
}

// ---- Canvas helpers
function canvasRoutes(planner: Stub): Record<string, Stub> {
  return {
    [`${CANVAS_BASE}/api/v1/users/self`]: () => json({ id: 7, name: "Illustrative Student" }),
    [`${CANVAS_BASE}/api/v1/planner/items`]: planner,
  };
}

const plannerItem = {
  plannable_id: 501,
  plannable_type: "assignment",
  plannable_date: "2026-11-21T04:59:00Z",
  course_id: 42,
  context_type: "Course",
  html_url: "/courses/42/assignments/501",
  plannable: {
    id: 501,
    title: "Illustrative problem set 3",
    due_at: "2026-11-20T23:59:00-05:00",
    updated_at: "2026-11-10T15:00:00Z",
  },
};

describe("webhook routes", () => {
  test.each([
    {
      provider: "slack" as const,
      deliver: async (ctx: Ctx) => {
        await connectSlack(ctx);
        return postSlack(ctx, slackMessage(CHANNEL), { secret: "wrong-secret" });
      },
    },
    {
      provider: "notion" as const,
      deliver: async (ctx: Ctx) => {
        await connectNotion(ctx);
        return postNotion(ctx, notionEvent(PAGE), "secret_wrong");
      },
    },
  ])("rejects_invalid_webhook_signature ($provider)", async ({ provider, deliver }) => {
    const ctx = await setup(provider);
    const response = await deliver(ctx);
    expect(response.status).toBe(401);
    expect(await ctx.evidence()).toEqual([]);
  });

  test.each([
    {
      provider: "slack" as const,
      deliver: async (ctx: Ctx) => {
        await connectSlack(ctx);
        return postSlack(ctx, slackMessage("C0NOTSELECTED"));
      },
    },
    {
      provider: "notion" as const,
      deliver: async (ctx: Ctx) => {
        await connectNotion(ctx);
        return postNotion(ctx, notionEvent("99999999-9999-4999-8999-999999999999"));
      },
    },
  ])("ignores_unselected_resource ($provider)", async ({ provider, deliver }) => {
    const ctx = await setup(provider);
    const response = await deliver(ctx);
    expect(response.status).toBe(200); // valid but ignored: the provider must not retry it
    expect(await ctx.evidence()).toEqual([]);
  });

  test.each([
    {
      provider: "slack" as const,
      deliverTwice: async (ctx: Ctx) => {
        await connectSlack(ctx);
        const first = await postSlack(ctx, slackMessage(CHANNEL));
        const retry = await postSlack(ctx, slackMessage(CHANNEL));
        return [first, retry];
      },
    },
    {
      provider: "notion" as const,
      deliverTwice: async (ctx: Ctx) => {
        await connectNotion(ctx);
        stubFetch(notionPage("2026-11-14T12:00:00.000Z"));
        const event = notionEvent(PAGE);
        return [await postNotion(ctx, event), await postNotion(ctx, { ...event, attempt_number: 2 })];
      },
    },
  ])("retries_delivery_without_duplicate ($provider)", async ({ provider, deliverTwice }) => {
    const ctx = await setup(provider);
    const responses = await deliverTwice(ctx);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const rows = await ctx.evidence();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: ctx.alice.ownerId, sourceId: ctx.sourceId, origin: "live" });
  });

  test("slack_rejects_stale_timestamp_replay", async () => {
    const ctx = await setup("slack");
    await connectSlack(ctx);
    const sixMinutesAgo = Math.floor(Date.now() / 1000) - 6 * 60;
    const response = await postSlack(ctx, slackMessage(CHANNEL), { timestamp: sixMinutesAgo });
    expect(response.status).toBe(401);
    expect(await ctx.evidence()).toEqual([]);
  });

  test("slack_url_verification_answers_challenge_only_when_signed", async () => {
    const ctx = await setup("slack");
    const challenge = { type: "url_verification", token: "deprecated", challenge: "illustrative-challenge" };
    const signed = await postSlack(ctx, challenge);
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ challenge: "illustrative-challenge" });
    expect((await postSlack(ctx, challenge, { secret: "wrong" })).status).toBe(401);
  });

  test("slack_message_maps_to_live_evidence", async () => {
    const ctx = await setup("slack");
    await connectSlack(ctx);
    await postSlack(ctx, slackMessage(CHANNEL, "1763150400.000100"));
    const [row] = await ctx.evidence();
    expect(row).toMatchObject({
      externalId: `${CHANNEL}:1763150400.000100`,
      version: "1763150400.000100",
      occurredAt: "2025-11-14T20:00:00.000Z",
      text: "Illustrative: I'll send the deck Friday.",
      projectIds: [ctx.avt.id],
      grantVersion: 1,
      origin: "live",
    });
  });

  test("notion_log_page_not_ingested", async () => {
    const ctx = await setup("notion", { selectors: [PAGE, LOG_PAGE], writeTargets: [LOG_PAGE] });
    await connectNotion(ctx);
    const calls = stubFetch(notionPage("2026-11-14T12:00:00.000Z"));
    const response = await postNotion(ctx, notionEvent(LOG_PAGE));
    expect(response.status).toBe(200);
    expect(calls).toEqual([]); // not even fetched
    expect(await ctx.evidence()).toEqual([]);
  });

  test("notion_verification_token_is_owner_only_and_set_once", async () => {
    const ctx = await setup("notion");
    await connectNotion(ctx);
    expect(
      await ctx.asAlice.action(api.connectors.notion.revealVerificationToken, { sourceId: ctx.sourceId }),
    ).toBe(NOTION_VERIFICATION);
    await expect(
      ctx.asBob.action(api.connectors.notion.revealVerificationToken, { sourceId: ctx.sourceId }),
    ).rejects.toThrow(/not available/i);
    // A second unsigned handshake cannot replace the stored signing secret.
    const again = await ctx.t.fetch(`/notion/events?source=${encodeURIComponent(ctx.sourceId)}`, {
      method: "POST",
      body: JSON.stringify({ verification_token: "secret_attacker" }),
    });
    expect(again.status).toBe(401);
    expect(
      await ctx.asAlice.action(api.connectors.notion.revealVerificationToken, { sourceId: ctx.sourceId }),
    ).toBe(NOTION_VERIFICATION);
  });
});

describe("canvas explicit refresh", () => {
  test("canvas_deadline_retains_last_checked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T09:00:00Z"));
    const ctx = await setup("canvas");
    stubFetch(canvasRoutes(() => json([plannerItem])));
    await ctx.asAlice.action(api.connectors.canvas.connect, {
      sourceId: ctx.sourceId,
      baseUrl: CANVAS_BASE,
      token: CANVAS_TOKEN,
    });
    const checked = await ctx.connection();
    expect(checked).toMatchObject({ availability: "connected", lastCheckedAt: "2026-11-14T09:00:00.000Z" });
    const [deadline] = await ctx.evidence();
    // Due date kept verbatim with its offset; never silently converted.
    expect(deadline?.text).toContain("2026-11-20T23:59:00-05:00");
    expect(deadline?.sourceUrl).toBe(`${CANVAS_BASE}/courses/42/assignments/501`);

    vi.setSystemTime(new Date("2026-11-14T15:00:00Z"));
    stubFetch(canvasRoutes(() => json({ errors: [{ message: "unauthorized" }] }, 401)));
    await expect(
      ctx.asAlice.action(api.connectors.canvas.refreshByUser, { sourceId: ctx.sourceId }),
    ).rejects.toThrow(/missing-access/);

    expect(await ctx.connection()).toMatchObject({
      availability: "missing-access",
      lastCheckedAt: "2026-11-14T09:00:00.000Z",
      lastError: "http_401",
    });
    expect(await ctx.evidence()).toHaveLength(1); // previous deadline kept, not "no deadlines"
  });

  test("canvas_refresh_is_owner_only", async () => {
    const ctx = await setup("canvas");
    stubFetch(canvasRoutes(() => json([])));
    await ctx.asAlice.action(api.connectors.canvas.connect, {
      sourceId: ctx.sourceId,
      baseUrl: CANVAS_BASE,
      token: CANVAS_TOKEN,
    });
    await expect(
      ctx.asBob.action(api.connectors.canvas.refreshByUser, { sourceId: ctx.sourceId }),
    ).rejects.toThrow(/not available/i);
  });
});

describe("provider failures", () => {
  const timeout = () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
  test.each([
    {
      name: "slack 429 on initial read",
      kind: "slack" as const,
      expected: { availability: "needs-retry", lastError: "http_429" },
      run: async (ctx: Ctx) => {
        stubFetch({
          ...slackOk,
          "https://slack.com/api/conversations.history": () => json({ ok: false, error: "ratelimited" }, 429),
        });
        await expect(
          ctx.asAlice.action(api.connectors.slack.connect, { sourceId: ctx.sourceId, botToken: SLACK_TOKEN }),
        ).rejects.toThrow(/needs-retry/);
      },
    },
    {
      name: "notion 401 on event fetch",
      kind: "notion" as const,
      expected: { availability: "missing-access", lastError: "http_401" },
      run: async (ctx: Ctx) => {
        await connectNotion(ctx);
        stubFetch({ "https://api.notion.com/": () => json({ object: "error", code: "unauthorized" }, 401) });
        expect((await postNotion(ctx, notionEvent(PAGE))).status).toBe(200);
      },
    },
    {
      name: "canvas timeout on refresh",
      kind: "canvas" as const,
      expected: { availability: "needs-retry", lastError: "timeout" },
      run: async (ctx: Ctx) => {
        stubFetch({ [`${CANVAS_BASE}/api/v1/users/self`]: () => json({ id: 7 }), [`${CANVAS_BASE}/api/v1/planner/items`]: timeout });
        await expect(
          ctx.asAlice.action(api.connectors.canvas.connect, {
            sourceId: ctx.sourceId,
            baseUrl: CANVAS_BASE,
            token: CANVAS_TOKEN,
          }),
        ).rejects.toThrow(/needs-retry/);
      },
    },
  ])("provider_failure_is_visible_not_empty ($name)", async ({ kind, expected, run }) => {
    const ctx = await setup(kind);
    await run(ctx);
    expect(await ctx.connection()).toMatchObject(expected);
    expect(await ctx.evidence()).toEqual([]);
    expect(await ctx.scheduled()).toEqual([]); // no retry timer: provider retry or user Retry resumes
  });

  test("notion_transient_failure_asks_provider_to_retry", async () => {
    const ctx = await setup("notion");
    await connectNotion(ctx);
    stubFetch({ "https://api.notion.com/": () => json({ object: "error", code: "rate_limited" }, 429) });
    expect((await postNotion(ctx, notionEvent(PAGE))).status).toBe(503);
    expect(await ctx.connection()).toMatchObject({ availability: "needs-retry", lastError: "http_429" });
    expect(await ctx.scheduled()).toEqual([]);
  });
});

describe("connection seam", () => {
  test("list_connections_never_returns_credentials", async () => {
    const ctx = await setup("notion");
    await connectNotion(ctx);
    const rows = await ctx.asAlice.query(api.connections.listConnections, {});
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["availability", "lastCheckedAt", "provider", "sourceId"]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(NOTION_TOKEN);
    expect(serialized).not.toContain(NOTION_VERIFICATION);
    const [stored] = await ctx.t.run((db) => db.db.query("connections").collect());
    expect(serialized).not.toContain(stored!.credential);
    expect(stored!.credential).not.toContain(NOTION_TOKEN); // sealed at rest
    expect(await ctx.asBob.query(api.connections.listConnections, {})).toEqual([]);
    await expect(ctx.t.query(api.connections.listConnections, {})).rejects.toThrow(/not authenticated/i);
  });

  test("oauth_state_is_single_use_expiring_and_owner_bound", async () => {
    const ctx = await setup("slack");
    const { alice, bob } = ctx;
    const issue = () => ctx.t.run((db) => issueOAuthState(db, alice.ownerId, "gmail"));
    const consume = (state: string, ownerId: string, provider = "gmail") =>
      ctx.t.run((db) => consumeOAuthState(db, { state, ownerId, provider }));

    const state = await issue();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await consume(state, alice.ownerId)).toBe(true);
    expect(await consume(state, alice.ownerId)).toBe(false); // single use

    const stolen = await issue();
    expect(await consume(stolen, bob.ownerId)).toBe(false); // owner-bound
    expect(await consume(stolen, alice.ownerId)).toBe(false); // and burned by the attempt

    const wrongProvider = await issue();
    expect(await consume(wrongProvider, alice.ownerId, "outlook-mail")).toBe(false);

    vi.useFakeTimers({ toFake: ["Date"] });
    const expiring = await issue();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(await consume(expiring, alice.ownerId)).toBe(false); // expired
  });
});
