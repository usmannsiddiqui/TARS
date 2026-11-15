// @vitest-environment edge-runtime
// T12 provider-failure matrix over the five connectors (Slack, Notion, Canvas, Gmail, Outlook).
// The shared helpers in convex/lib/providerAuth.ts are exercised directly; each connector's own
// failure handling through its user-triggered read, on convex-test with only `fetch` stubbed.
// Fixture-only: every provider response is illustrative, never a live provider.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProjectId, SourceKind } from "@companion/domain";
import { outcomeForFailure } from "../../packages/domain/src/actions";
import { api, internal } from "../../convex/_generated/api";
import { encryptSecret } from "../../convex/lib/crypto";
import {
  consumeOAuthState,
  issueOAuthState,
  ProviderError,
  providerJson,
  sealCredential,
  verifyHmacSha256Hex,
} from "../../convex/lib/providerAuth";
import schema from "../../convex/schema";
import { makeOwners, makeProjects } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");

const SITE = "https://illustrative.convex.site";
const SLACK_SECRET = "illustrative-slack-signing-secret";
const NOTION_VERIFICATION = "secret_illustrative_verification_token";
const CANVAS_FEED = "https://illustrative.instructure.com/feeds/calendars/user_IllustrativeAliceFeedToken.ics";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";
const CHECKED = "2026-11-14T08:00:00.000Z"; // the last good read before each failure
// Secrets and personal text that must never reach an error message or status shown to the client.
const TOKENS = {
  slack: "xoxb-illustrative-bot-token",
  notion: "ntn_illustrative_integration_token",
  canvas: "user_IllustrativeAliceFeedToken",
  gmail: "1//illustrative-google-refresh-token",
  outlook: "M.illustrative-microsoft-refresh-token",
  access: "illustrative-access-token",
};
const PERSONAL = "Alice's private note about the AVT budget";

beforeEach(() => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", btoa(String.fromCharCode(...key)));
  vi.stubEnv("SLACK_SIGNING_SECRET", SLACK_SECRET);
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("GOOGLE_CLIENT_ID", "illustrative-google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "illustrative-google-client-secret");
  vi.stubEnv("GMAIL_PUSH_SERVICE_ACCOUNT", "gmail-push@illustrative-project.iam.gserviceaccount.com");
  vi.stubEnv("GMAIL_PUBSUB_TOPIC", "projects/illustrative-project/topics/gmail");
  vi.stubEnv("MICROSOFT_CLIENT_ID", "illustrative-microsoft-client-id");
  vi.stubEnv("MICROSOFT_CLIENT_SECRET", "illustrative-microsoft-client-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---- fetch stub: longest matching URL prefix wins; every call is recorded.
type Stub = (url: string) => Response | Promise<Response>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const timeout = (): never => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};
let calls: string[] = [];
function stubFetch(routes: Record<string, Stub>) {
  calls = [];
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = decodeURIComponent(input instanceof Request ? input.url : input.toString());
    calls.push(url);
    const match = prefixes.find((prefix) => url.startsWith(prefix));
    if (match === undefined) throw new Error(`Unexpected fetch ${url}`);
    return routes[match]!(url);
  });
}

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- One connected source per connector: grant, sealed credential, a last good read at CHECKED.
type Name = "slack" | "notion" | "canvas" | "gmail" | "outlook";
const KIND: Record<Name, SourceKind> = { slack: "slack", notion: "notion", canvas: "canvas", gmail: "gmail", outlook: "outlook-mail" };
const SECRETS: Record<Name, Record<string, string>> = {
  slack: { botToken: TOKENS.slack },
  notion: { token: TOKENS.notion },
  canvas: { feedUrl: CANVAS_FEED },
  gmail: { refreshToken: TOKENS.gmail },
  outlook: { refreshToken: TOKENS.outlook, clientState: "illustrative-client-state", subscriptions: JSON.stringify({ "sub-1": "AAMkFolderAVT" }) },
};

async function setup(name: Name, selectors = name === "notion" ? ["1f2e3d4c5b6a47898abcdef012345678"] : ["sel-1"]) {
  const t = convexTest(schema, modules);
  const { alice } = makeOwners();
  const { avt } = makeProjects(alice.ownerId);
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const sourceId = `source-${name}-${crypto.randomUUID()}`;
  await asAlice.mutation(api.evidence.setGrant, {
    id: sourceId,
    kind: KIND[name],
    selectors,
    projectIds: [avt.id as ProjectId],
    read: true,
    writeTargets: [],
    cloudProcessing: true,
    version: 1,
    state: "active",
  });
  await t.mutation(internal.connections.save, {
    ownerId: alice.ownerId,
    sourceId,
    provider: KIND[name],
    accountKey: name === "slack" ? "T0ILLUSTRATIVE" : name === "gmail" ? "alice@illustrative.example" : sourceId,
    credential: await sealCredential(SECRETS[name]),
  });
  await t.mutation(internal.connections.setStatus, { sourceId, availability: "connected", checkedAt: CHECKED });
  if (name === "notion") {
    await t.mutation(internal.connections.setWebhookSecret, { sourceId, webhookSecret: await encryptSecret(NOTION_VERIFICATION) });
  }
  const status = () => asAlice.query(api.connections.listConnections, {}).then((rows) => rows[0]!);
  const evidence = () => t.run((ctx) => ctx.db.query("evidence").collect());
  const scheduled = () => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return { t, alice, asAlice, sourceId, status, evidence, scheduled };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/**
 * Each connector's user-triggered read: the routes that succeed before the failing call, the URL
 * prefix of the read that fails, and the action. Slack and Notion re-read on connect; Canvas on Refresh.
 */
const CONNECTORS: { name: Name; ok: Record<string, Stub>; read: string; run: (ctx: Ctx) => Promise<unknown> }[] = [
  {
    name: "slack",
    ok: { "https://slack.com/api/auth.test": () => json({ ok: true, team_id: "T0ILLUSTRATIVE" }) },
    read: "https://slack.com/api/conversations.history",
    run: (c) => c.asAlice.action(api.connectors.slack.connect, { sourceId: c.sourceId, botToken: TOKENS.slack }),
  },
  {
    name: "notion",
    ok: { "https://api.notion.com/v1/users/me": () => json({ object: "user", id: "bot-1" }) },
    read: "https://api.notion.com/v1/pages/",
    run: (c) => c.asAlice.action(api.connectors.notion.connect, { sourceId: c.sourceId, token: TOKENS.notion }),
  },
  {
    name: "canvas",
    ok: {},
    read: CANVAS_FEED,
    run: (c) => c.asAlice.action(api.connectors.canvas.refreshByUser, { sourceId: c.sourceId }),
  },
  {
    name: "gmail",
    ok: { [GOOGLE_TOKEN]: () => json({ access_token: TOKENS.access }) },
    read: `${GMAIL}/profile`,
    run: (c) => c.asAlice.action(api.connectors.gmail.refresh, { sourceId: c.sourceId }),
  },
  {
    name: "outlook",
    ok: { [MS_TOKEN]: () => json({ access_token: TOKENS.access }) },
    read: `${GRAPH}/me/mailFolders/`,
    run: (c) => c.asAlice.action(api.connectors.outlook.refresh, { sourceId: c.sourceId, kind: "outlook-mail" }),
  },
];

type Expected = { availability: "missing-access" | "needs-retry"; code: string };
/** Failure → (connector → provider response, expected status). Slack reports most failures as 200 ok:false. */
const FAILURES: { failure: string; respond: (name: Name) => Response; expect: (name: Name) => Expected }[] = [
  {
    failure: "401 → needs reconnect",
    respond: (name) => (name === "slack" ? json({ ok: false, error: "invalid_auth" }) : json({ error: "unauthorized" }, 401)),
    expect: (name) => ({ availability: "missing-access", code: name === "slack" ? "slack_invalid_auth" : "http_401" }),
  },
  {
    // Named only where the provider says which permission is missing: Slack's `needed`, and the
    // RFC 6750 insufficient_scope challenge Google sends. Graph, Notion and Canvas name none.
    failure: "403 insufficient scope → names the missing permission",
    respond: (name) =>
      name === "slack"
        ? json({ ok: false, error: "missing_scope", needed: "channels:history", provided: "chat:write" })
        : name === "gmail"
          ? json({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403, {
              "www-authenticate": 'Bearer realm="https://accounts.google.com/", error="insufficient_scope", scope="https://www.googleapis.com/auth/gmail.readonly"',
            })
          : json({ error: { code: "ErrorAccessDenied" } }, 403),
    expect: (name) => ({
      availability: "missing-access",
      code:
        name === "slack"
          ? "slack_missing_scope:channels:history"
          : name === "gmail"
            ? "missing_scope:https://www.googleapis.com/auth/gmail.readonly"
            : "http_403",
    }),
  },
  {
    failure: "429 → keeps the provider's retry hint, no timer",
    respond: () => json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "30" }),
    expect: () => ({ availability: "needs-retry", code: "http_429_retry_after_30s" }),
  },
  {
    failure: "5xx → retryable",
    respond: () => json({ error: `upstream echo ${TOKENS.access} ${PERSONAL}` }, 503),
    expect: () => ({ availability: "needs-retry", code: "http_503" }),
  },
  {
    failure: "timeout → retryable",
    respond: timeout,
    expect: () => ({ availability: "needs-retry", code: "timeout" }),
  },
  {
    failure: "malformed payload → rejected",
    respond: () => new Response(`<html>${PERSONAL}</html>`, { status: 200 }),
    expect: () => ({ availability: "needs-retry", code: "unexpected_response" }),
  },
];

describe("provider failure matrix", () => {
  const cells = CONNECTORS.flatMap((connector) => FAILURES.map((row) => ({ ...row, connector, label: `${connector.name}: ${row.failure}` })));
  test.each(cells)("$label", async ({ connector, respond, expect: expected }) => {
    const ctx = await setup(connector.name);
    const { availability, code } = expected(connector.name);
    stubFetch({ ...connector.ok, [connector.read]: () => respond(connector.name) });

    let message = "";
    await connector.run(ctx).then(
      () => expect.unreachable("the read should fail"),
      (error: Error) => (message = error.message),
    );
    expect(message).toContain(`${availability}: ${code}`);

    const status = await ctx.status();
    expect(status).toMatchObject({ availability, lastError: code });
    // Not shown as fresh: the last good read time is kept, never moved to the failed attempt.
    expect(status.lastCheckedAt).toBe(CHECKED);
    // Rejected without partial writes, and nothing queued to retry on a timer.
    expect(await ctx.evidence()).toEqual([]);
    expect(await ctx.scheduled()).toEqual([]);
    // No token or personal payload in what the client gets back.
    for (const leak of [...Object.values(TOKENS), PERSONAL, "<html>"]) {
      expect(`${message} ${JSON.stringify(status)}`).not.toContain(leak);
    }
  });

  test.each([
    {
      name: "gmail" as const,
      routes: (fail: Stub): Record<string, Stub> => ({
        [GOOGLE_TOKEN]: () => json({ access_token: TOKENS.access }),
        [`${GMAIL}/profile`]: () => json({ historyId: "5000" }),
        [`${GMAIL}/messages?`]: () => json({ messages: [{ id: "m1" }, { id: "m2" }] }),
        [`${GMAIL}/messages/m1`]: () =>
          json({ id: "m1", labelIds: ["sel-1"], internalDate: "1763110800000", payload: { headers: [], mimeType: "text/plain", body: { data: "" } } }),
        [`${GMAIL}/messages/m2`]: fail,
      }),
    },
    {
      name: "slack" as const,
      routes: (fail: Stub): Record<string, Stub> => ({
        "https://slack.com/api/auth.test": () => json({ ok: true, team_id: "T0ILLUSTRATIVE" }),
        "https://slack.com/api/conversations.history": (url) =>
          url.includes("channel=sel-1") ? json({ ok: true, messages: [{ ts: "1763150400.000100", text: "Illustrative." }] }) : fail(url),
      }),
    },
  ])("a failure midway through a multi-item read stores nothing from it ($name)", async ({ name, routes }) => {
    const ctx = await setup(name, ["sel-1", "sel-2"]);
    stubFetch(routes(() => json({ error: "unavailable" }, 500)));
    const connector = CONNECTORS.find((c) => c.name === name)!;
    await expect(connector.run(ctx)).rejects.toThrow("needs-retry: http_500");
    expect(await ctx.evidence()).toEqual([]);
  });

  test("a token endpoint rejection asks for reconnect and never echoes the token", async () => {
    const ctx = await setup("gmail");
    stubFetch({ [GOOGLE_TOKEN]: () => json({ error: "invalid_grant", error_description: `Token ${TOKENS.gmail} has been revoked` }, 400) });
    const message = await CONNECTORS.find((c) => c.name === "gmail")!.run(ctx).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(message).toContain("missing-access: token_rejected");
    const status = await ctx.status();
    expect(status).toMatchObject({ availability: "missing-access", lastError: "token_rejected", lastCheckedAt: CHECKED });
    expect(`${message} ${JSON.stringify(status)}`).not.toContain(TOKENS.gmail);
  });

  test("an accepted response that cannot be read is never treated as a failed effect", async () => {
    // A send/append whose 2xx body is unreadable may have happened: it must stay unknown, never resent.
    stubFetch({ "https://provider.illustrative/": () => new Response("<html>ok</html>", { status: 200 }) });
    const error = await providerJson("https://provider.illustrative/send").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ availability: "needs-retry", code: "unexpected_response" });
    expect(outcomeForFailure((error as ProviderError).code)).toBe("unknown");
    expect(outcomeForFailure("http_429_retry_after_30s")).toBe("failed"); // rejected: nothing happened
  });
});

// ======================================================================

describe("webhook signatures", () => {
  test.each([
    { name: "missing", signature: "" },
    { name: "not hex", signature: "z".repeat(64) },
    { name: "wrong length", signature: "ab".repeat(16) },
    { name: "wrong secret", signature: "other-secret" },
    { name: "tampered body", signature: "tampered" },
  ])("hmac check rejects a $name signature", async ({ signature }) => {
    const message = "v0:1763150400:{}";
    const hex =
      signature === "other-secret"
        ? await hmacHex("other-secret", message)
        : signature === "tampered"
          ? await hmacHex(SLACK_SECRET, `${message} `)
          : signature;
    expect(await verifyHmacSha256Hex(SLACK_SECRET, message, hex)).toBe(false);
    expect(await verifyHmacSha256Hex(SLACK_SECRET, message, await hmacHex(SLACK_SECRET, message))).toBe(true);
  });

  // A body that is not even JSON: a 401 (not a 400) proves the signature is checked before any parsing.
  const garbage = "not json {";
  test.each([
    {
      name: "slack",
      post: (ctx: Ctx) =>
        ctx.t.fetch("/slack/events", {
          method: "POST",
          body: garbage,
          headers: { "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)), "x-slack-signature": `v0=${"0".repeat(64)}` },
        }),
    },
    {
      name: "notion",
      post: (ctx: Ctx) =>
        ctx.t.fetch(`/notion/events?source=${encodeURIComponent(ctx.sourceId)}`, {
          method: "POST",
          body: garbage,
          headers: { "x-notion-signature": `sha256=${"0".repeat(64)}` },
        }),
    },
    { name: "gmail", post: (ctx: Ctx) => ctx.t.fetch("/gmail/push", { method: "POST", body: garbage }) },
  ] as const)("invalid or missing signature is rejected before parsing ($name)", async ({ name, post }) => {
    const ctx = await setup(name);
    stubFetch({});
    expect((await post(ctx)).status).toBe(401);
    expect(calls).toEqual([]);
    expect(await ctx.evidence()).toEqual([]);
  });

  test("outlook: a wrong clientState is rejected before any fetch or queued work", async () => {
    // Graph puts its secret (clientState) inside the JSON body, so Outlook must parse first; a
    // non-JSON body is a 400 for that reason. Nothing is fetched or scheduled either way.
    const ctx = await setup("outlook");
    stubFetch({});
    const post = (body: string) =>
      ctx.t.fetch(`/outlook/notifications?source=${encodeURIComponent(ctx.sourceId)}`, { method: "POST", body, headers: { "content-type": "application/json" } });
    const forged = { value: [{ subscriptionId: "sub-1", clientState: "forged", changeType: "created", resourceData: { id: "mail-1" } }] };
    expect((await post(JSON.stringify(forged))).status).toBe(401);
    expect((await post(garbage)).status).toBe(400);
    expect(calls).toEqual([]);
    expect(await ctx.scheduled()).toEqual([]);
  });
});

// ======================================================================

describe("oauth state", () => {
  test("reused, expired, other-owner and other-provider states are rejected", async () => {
    const ctx = await setup("gmail");
    const { bob } = makeOwners();
    const issue = () => ctx.t.run((db) => issueOAuthState(db, ctx.alice.ownerId, "gmail"));
    const consume = (state: string, ownerId: string = ctx.alice.ownerId, provider = "gmail") =>
      ctx.t.run((db) => consumeOAuthState(db, { state, ownerId, provider }));

    const reused = await issue();
    expect(await consume(reused)).toBe(true);
    expect(await consume(reused)).toBe(false);
    expect(await consume(await issue(), bob.ownerId)).toBe(false);
    expect(await consume(await issue(), ctx.alice.ownerId, "outlook-mail")).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"] });
    const expiring = await issue();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(await consume(expiring)).toBe(false);
  });

  test.each([
    { name: "gmail" as const, start: api.connectors.gmail.startConnect, callback: "/oauth/google/callback", token: GOOGLE_TOKEN },
    { name: "outlook" as const, start: api.connectors.outlook.startConnect, callback: "/oauth/microsoft/callback", token: MS_TOKEN },
  ])("a used or expired state on the $name callback exchanges no code", async ({ name, start, callback, token }) => {
    const ctx = await setup(name);
    stubFetch({ [token]: () => json({ error: "invalid_grant" }, 400) });
    const stateOf = async () => new URL(await ctx.asAlice.mutation(start, { sourceId: ctx.sourceId })).searchParams.get("state")!;
    const open = (state: string) => ctx.t.fetch(`${callback}?code=illustrative-code&state=${state}`);

    const used = await stateOf();
    expect((await open(used)).status).toBe(400); // first use: exchanged once, rejected by the provider
    expect(calls).toHaveLength(1);
    const again = await open(used);
    expect(again.status).toBe(400);
    expect(await again.text()).toMatch(/expired or was already used/);

    vi.useFakeTimers({ toFake: ["Date"] });
    const expiring = await stateOf();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(await (await open(expiring)).text()).toMatch(/expired or was already used/);
    expect(calls).toHaveLength(1); // neither the reuse nor the expired state reached the token endpoint
  });
});

// ======================================================================

describe("expired subscription or lease", () => {
  test.each([
    {
      name: "gmail" as const,
      renew: internal.connectors.gmail.renewLease,
      routes: { [GOOGLE_TOKEN]: () => json({ access_token: TOKENS.access }), [`${GMAIL}/watch`]: () => json({ error: "not found" }, 404) },
    },
    {
      name: "outlook" as const,
      renew: internal.connectors.outlook.renewLease,
      // Graph answers 404 for a subscription that already expired or was removed.
      routes: { [MS_TOKEN]: () => json({ access_token: TOKENS.access }), [`${GRAPH}/subscriptions/`]: () => json({ error: { code: "ResourceNotFound" } }, 404) },
    },
  ])("a lease that cannot be renewed becomes an explicit state, with no new renewal ($name)", async ({ name, renew, routes }) => {
    const ctx = await setup(name);
    stubFetch(routes);
    await ctx.t.action(renew, { sourceId: ctx.sourceId, grantVersion: 1 });
    expect(await ctx.status()).toMatchObject({ availability: "missing-access", lastError: "http_404", lastCheckedAt: CHECKED });
    expect(await ctx.scheduled()).toEqual([]);
  });
});
