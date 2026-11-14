// @vitest-environment edge-runtime
// Fixture-only: every Google and Microsoft response here is an illustrative stub of `fetch`.
// These tests prove adapter logic, never live provider access.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProjectId, SourceKind } from "@companion/domain";
import { api, internal } from "../../convex/_generated/api";
import { issueOAuthState, takeOAuthState } from "../../convex/lib/providerAuth";
import schema from "../../convex/schema";
import { makeOwners, makeProjects } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");

const SITE = "https://illustrative.convex.site";
const PUSH_ACCOUNT = "gmail-push@illustrative-project.iam.gserviceaccount.com";
const GOOGLE_REFRESH = "1//illustrative-google-refresh-token";
const GOOGLE_ACCESS = "ya29.illustrative-google-access-token";
const MS_REFRESH = "M.illustrative-microsoft-refresh-token";
const MS_ACCESS = "EwB-illustrative-microsoft-access-token";
const EMAIL = "alice@illustrative.example";
const LABEL = "Label_avt";
const FOLDER = "AAMkFolderAVT";
const CALENDAR = "AAMkCalendarWork";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-14T09:00:00Z");

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const key = crypto.getRandomValues(new Uint8Array(32));
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", btoa(String.fromCharCode(...key)));
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("GOOGLE_CLIENT_ID", "illustrative-google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "illustrative-google-client-secret");
  vi.stubEnv("GMAIL_PUBSUB_TOPIC", "projects/illustrative-project/topics/gmail");
  vi.stubEnv("GMAIL_PUSH_SERVICE_ACCOUNT", PUSH_ACCOUNT);
  vi.stubEnv("MICROSOFT_CLIENT_ID", "illustrative-microsoft-client-id");
  vi.stubEnv("MICROSOFT_CLIENT_SECRET", "illustrative-microsoft-client-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---- fetch stub: longest matching URL prefix wins; records method, URL and body.
type Call = { method: string; url: string; body: string };
type Stub = (call: Call) => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(routes: Record<string, Stub>): Call[] {
  const calls: Call[] = [];
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const call = { method: init.method ?? "GET", url: decodeURIComponent(url), body: String(init.body ?? "") };
    calls.push(call);
    const match = prefixes.find((prefix) => call.url.startsWith(prefix));
    if (match === undefined) throw new Error(`Unexpected fetch ${call.method} ${call.url}`);
    return routes[match]!(call);
  });
  return calls;
}

async function setup(kind: SourceKind, selectors: string[]) {
  const t = convexTest(schema, modules);
  const { alice, bob } = makeOwners();
  const { avt } = makeProjects(alice.ownerId);
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const sourceId = `source-${kind}-${crypto.randomUUID()}`;
  const grant = {
    id: sourceId,
    kind,
    selectors,
    projectIds: [avt.id as ProjectId],
    read: true,
    writeTargets: [],
    cloudProcessing: true,
    version: 1,
    state: "active",
  };
  await asAlice.mutation(api.evidence.setGrant, grant);
  const evidence = () => t.run((ctx) => ctx.db.query("evidence").collect());
  const scheduled = () =>
    t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()).then((rows) =>
      rows.filter((row) => row.state.kind === "pending"),
    );
  const connection = () => asAlice.query(api.connections.listConnections, {}).then((rows) => rows[0]);
  const stored = () => t.run((ctx) => ctx.db.query("connections").first());
  const revoke = () => asAlice.mutation(api.evidence.setGrant, { ...grant, version: 2, state: "revoked" });
  return { t, alice, bob, avt, asAlice, sourceId, evidence, scheduled, connection, stored, revoke };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const stateOf = (authorizeUrl: string) => new URL(authorizeUrl).searchParams.get("state")!;

// ---- Google fixtures
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (text: string) => b64url(new TextEncoder().encode(text));

const googleKeys = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const googleJwk = { ...(await crypto.subtle.exportKey("jwk", googleKeys.publicKey)), kid: "kid-1", alg: "RS256", use: "sig" };
const otherKeys = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);

async function pushJwt(overrides: Record<string, unknown> = {}, key: CryptoKey = googleKeys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://accounts.google.com",
    aud: `${SITE}/gmail/push`,
    email: PUSH_ACCOUNT,
    email_verified: true,
    iat: now,
    exp: now + 3600,
    sub: "1234567890",
    ...overrides,
  };
  const input = `${b64urlText(JSON.stringify({ alg: "RS256", kid: "kid-1", typ: "JWT" }))}.${b64urlText(JSON.stringify(claims))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  return `${input}.${b64url(signature)}`;
}

function gmailMessage(id: string, labelIds = [LABEL]) {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds,
    snippet: "Illustrative snippet",
    historyId: "5100",
    internalDate: String(Date.parse("2026-11-14T08:30:00Z")),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Bob Illustrative <bob@illustrative.example>" },
        { name: "Subject", value: "AVT deck" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64urlText("Illustrative: can you send the AVT deck by Friday?") } },
        { mimeType: "text/html", body: { data: b64urlText("<p>ignored</p>") } },
      ],
    },
  };
}

type HistoryStub = Stub;
function googleRoutes(history: HistoryStub = () => json({ historyId: "5200" }), extra: Record<string, Stub> = {}) {
  return {
    [GOOGLE_TOKEN]: () => json({ access_token: GOOGLE_ACCESS, refresh_token: GOOGLE_REFRESH, expires_in: 3599 }),
    [GOOGLE_CERTS]: () => json({ keys: [googleJwk] }),
    [`${GMAIL}/profile`]: () => json({ emailAddress: EMAIL, historyId: "5000" }),
    [`${GMAIL}/watch`]: () => json({ historyId: "5000", expiration: String(Date.now() + 7 * DAY) }),
    [`${GMAIL}/history`]: history,
    [`${GMAIL}/messages?`]: () => json({ messages: [] }),
    [`${GMAIL}/messages/`]: (call: Call) => json(gmailMessage(call.url.split("/messages/")[1]!.split("?")[0]!)),
    ...extra,
  };
}

async function connectGmail(ctx: Ctx, routes: Record<string, Stub> = googleRoutes()) {
  const calls = stubFetch(routes);
  const url = await ctx.asAlice.mutation(api.connectors.gmail.startConnect, { sourceId: ctx.sourceId });
  const response = await ctx.t.fetch(`/oauth/google/callback?code=illustrative-code&state=${stateOf(url)}`);
  expect(response.status).toBe(200);
  expect(await response.text()).toMatch(/return to the app/i);
  return calls;
}

async function postPush(ctx: Ctx, opts: { jwt?: string | null; historyId?: string } = {}) {
  const data = btoa(JSON.stringify({ emailAddress: EMAIL, historyId: opts.historyId ?? "5100" }));
  const jwt = opts.jwt === undefined ? await pushJwt() : opts.jwt;
  return ctx.t.fetch("/gmail/push", {
    method: "POST",
    headers: jwt === null ? {} : { authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      message: { data, messageId: "2070443601311540", publishTime: NOW.toISOString() },
      subscription: "projects/illustrative-project/subscriptions/gmail-push",
    }),
  });
}

const historyWith = (labelIds: string[], id = "msg-1") => () =>
  json({
    history: [{ id: "5050", messagesAdded: [{ message: { id, threadId: `thread-${id}`, labelIds } }] }],
    historyId: "5100",
  });

// ---- Microsoft fixtures
function graphEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    subject: "AVT sync",
    isCancelled: false,
    lastModifiedDateTime: "2026-11-14T08:00:00Z",
    start: { dateTime: "2026-11-20T15:00:00.0000000", timeZone: "Eastern Standard Time" },
    end: { dateTime: "2026-11-20T15:30:00.0000000", timeZone: "Eastern Standard Time" },
    webLink: "https://outlook.office365.com/owa/?itemid=evt-1",
    calendar: { id: CALENDAR },
    ...overrides,
  };
}

const graphMessage = {
  id: "mail-1",
  subject: "OVPCC follow-up",
  from: { emailAddress: { name: "Carol Illustrative", address: "carol@illustrative.example" } },
  receivedDateTime: "2026-11-14T08:15:00Z",
  body: { contentType: "text", content: "Illustrative: please confirm the pitch slot." },
  webLink: "https://outlook.office365.com/owa/?itemid=mail-1",
};

function microsoftRoutes(extra: Record<string, Stub> = {}) {
  let subscriptionCount = 0;
  return {
    [MS_TOKEN]: () => json({ access_token: MS_ACCESS, refresh_token: MS_REFRESH, expires_in: 3599 }),
    [`${GRAPH}/me?`]: () => json({ id: "ms-user-1" }),
    [`${GRAPH}/subscriptions`]: (call: Call) => {
      if (call.method === "POST" && !call.url.endsWith("/reauthorize")) {
        const body = JSON.parse(call.body) as { expirationDateTime: string };
        return json({ id: `sub-${++subscriptionCount}`, expirationDateTime: body.expirationDateTime }, 201);
      }
      if (call.method === "PATCH") return json(JSON.parse(call.body));
      return new Response(null, { status: 204 });
    },
    [`${GRAPH}/me/mailFolders/`]: () => json({ value: [] }),
    [`${GRAPH}/me/calendars/`]: () => json({ value: [] }),
    [`${GRAPH}/me/messages/`]: () => json(graphMessage),
    [`${GRAPH}/me/events/`]: () => json(graphEvent()),
    ...extra,
  };
}

async function connectOutlook(ctx: Ctx, routes: Record<string, Stub> = microsoftRoutes()) {
  const calls = stubFetch(routes);
  const url = await ctx.asAlice.mutation(api.connectors.outlook.startConnect, { sourceId: ctx.sourceId });
  const response = await ctx.t.fetch(`/oauth/microsoft/callback?code=illustrative-code&state=${stateOf(url)}`);
  expect(response.status).toBe(200);
  const created = calls.filter((call) => call.method === "POST" && call.url === `${GRAPH}/subscriptions`);
  const clientState = (JSON.parse(created[0]!.body) as { clientState: string }).clientState;
  return { calls, clientState };
}

async function postGraph(ctx: Ctx, value: unknown[]) {
  return ctx.t.fetch(`/outlook/notifications?source=${encodeURIComponent(ctx.sourceId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

const change = (clientState: string, subscriptionId = "sub-1", id = "mail-1", type = "Message") => ({
  subscriptionId,
  clientState,
  changeType: "created",
  resource: `Users/ms-user-1/${type}s/${id}`,
  resourceData: { "@odata.type": `#Microsoft.Graph.${type}`, id },
  tenantId: "tenant-illustrative",
});

// ======================================================================

describe("gmail push", () => {
  test.each([
    { name: "missing token", jwt: async () => null },
    { name: "bad signature", jwt: () => pushJwt({}, otherKeys.privateKey) },
    { name: "expired", jwt: () => pushJwt({ exp: Math.floor(NOW.getTime() / 1000) - 60 }) },
    { name: "wrong audience", jwt: () => pushJwt({ aud: "https://attacker.example/gmail/push" }) },
    { name: "wrong service account", jwt: () => pushJwt({ email: "someone@attacker.example" }) },
    { name: "unverified email", jwt: () => pushJwt({ email_verified: false }) },
    { name: "wrong issuer", jwt: () => pushJwt({ iss: "https://attacker.example" }) },
  ])("rejects_invalid_webhook_signature (gmail: $name)", async ({ jwt }) => {
    const ctx = await setup("gmail", [LABEL]);
    await connectGmail(ctx);
    const calls = stubFetch(googleRoutes(historyWith([LABEL])));
    const response = await postPush(ctx, { jwt: await jwt() });
    expect(response.status).toBe(401);
    expect(calls.filter((call) => !call.url.startsWith(GOOGLE_CERTS))).toEqual([]); // nothing read
    expect(await ctx.evidence()).toEqual([]);
  });

  test("ignores_unselected_resource (gmail)", async () => {
    const ctx = await setup("gmail", [LABEL]);
    await connectGmail(ctx);
    const calls = stubFetch(googleRoutes(historyWith(["Label_personal"])));
    expect((await postPush(ctx)).status).toBe(200);
    expect(calls.some((call) => call.url.includes("/messages/"))).toBe(false); // not even fetched
    expect(await ctx.evidence()).toEqual([]);
  });

  test("retries_delivery_without_duplicate (gmail)", async () => {
    const ctx = await setup("gmail", [LABEL]);
    await connectGmail(ctx);
    stubFetch(googleRoutes(historyWith([LABEL])));
    const responses = [await postPush(ctx), await postPush(ctx)];
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const rows = await ctx.evidence();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: "msg-1",
      version: String(Date.parse("2026-11-14T08:30:00Z")),
      occurredAt: "2026-11-14T08:30:00.000Z",
      origin: "live",
    });
    expect(rows[0]!.text).toContain("Subject: AVT deck");
    expect(rows[0]!.text).toContain("From: Bob Illustrative <bob@illustrative.example>");
    expect(rows[0]!.text).toContain("send the AVT deck by Friday");
    expect(rows[0]!.text).not.toContain("ignored");
    expect((await ctx.stored())!.cursor).toBe("5100");
  });

  test("expired_cursor_is_stale_until_event_or_user_refresh (gmail)", async () => {
    const ctx = await setup("gmail", [LABEL]);
    await connectGmail(ctx);
    const expired = () => json({ error: { code: 404, message: "Requested entity was not found." } }, 404);

    let calls = stubFetch(googleRoutes(expired));
    expect((await postPush(ctx)).status).toBe(200);
    expect(await ctx.connection()).toMatchObject({ availability: "stale", lastError: "history_expired" });
    expect(calls.some((call) => call.url.startsWith(`${GMAIL}/messages`))).toBe(false); // no full mailbox read
    expect(await ctx.evidence()).toEqual([]);

    // The next provider event repairs with one bounded read of the selected labels.
    const list = { [`${GMAIL}/messages?`]: () => json({ messages: [{ id: "msg-1", threadId: "thread-msg-1" }] }) };
    calls = stubFetch(googleRoutes(expired, list));
    expect((await postPush(ctx, { historyId: "5300" })).status).toBe(200);
    const listCall = calls.find((call) => call.url.startsWith(`${GMAIL}/messages?`))!;
    expect(listCall.url).toContain(`labelIds=${LABEL}`);
    expect(listCall.url).toMatch(/maxResults=\d+/);
    expect(calls.some((call) => call.url.startsWith(`${GMAIL}/history`))).toBe(false);
    expect(await ctx.connection()).toMatchObject({ availability: "connected" });
    expect((await ctx.stored())!.cursor).toBe("5300");
    expect(await ctx.evidence()).toHaveLength(1);

    // Stale again; this time the user's Refresh repairs it.
    stubFetch(googleRoutes(expired));
    await postPush(ctx);
    expect(await ctx.connection()).toMatchObject({ availability: "stale" });
    stubFetch(googleRoutes(expired, list));
    await ctx.asAlice.action(api.connectors.gmail.refresh, { sourceId: ctx.sourceId });
    expect(await ctx.connection()).toMatchObject({ availability: "connected" });
    expect((await ctx.stored())!.cursor).toBe("5000"); // profile historyId read before the bounded list
    expect(await ctx.evidence()).toHaveLength(1);
  });

  test("gmail_watch_uses_selected_labels_only", async () => {
    const ctx = await setup("gmail", [LABEL]);
    const calls = await connectGmail(ctx);
    const watch = calls.find((call) => call.url === `${GMAIL}/watch`)!;
    expect(JSON.parse(watch.body)).toEqual({
      topicName: "projects/illustrative-project/topics/gmail",
      labelIds: [LABEL],
      labelFilterBehavior: "INCLUDE",
    });
    const authorize = calls.find((call) => call.url.startsWith(GOOGLE_TOKEN))!;
    expect(authorize.body).toContain("grant_type=authorization_code");
  });
});

describe("outlook notifications", () => {
  test("graph_validation_handshake_echoes_token_as_plain_text", async () => {
    const ctx = await setup("outlook-mail", [FOLDER]);
    const response = await ctx.t.fetch(
      `/outlook/notifications?source=${ctx.sourceId}&validationToken=${encodeURIComponent("Validation: Testing <client> 1+2")}`,
      { method: "POST", headers: { "content-type": "text/plain; charset=utf-8" } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await response.text()).toBe("Validation: Testing <client> 1+2");
  });

  test("rejects_invalid_webhook_signature (outlook: wrong clientState)", async () => {
    const ctx = await setup("outlook-mail", [FOLDER]);
    await connectOutlook(ctx);
    const calls = stubFetch(microsoftRoutes());
    const response = await postGraph(ctx, [change("forged-client-state")]);
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
    expect(await ctx.evidence()).toEqual([]);
  });

  test("ignores_unselected_resource (outlook)", async () => {
    const ctx = await setup("outlook-calendar", [CALENDAR]);
    const { clientState } = await connectOutlook(ctx);
    // Unknown subscription: not fetched. Known subscription, event in an unselected calendar: not stored.
    let calls = stubFetch(microsoftRoutes());
    expect((await postGraph(ctx, [change(clientState, "sub-unknown", "evt-1", "Event")])).status).toBe(202);
    expect(calls).toEqual([]);
    calls = stubFetch(microsoftRoutes({ [`${GRAPH}/me/events/`]: () => json(graphEvent({ calendar: { id: "AAMkOther" } })) }));
    expect((await postGraph(ctx, [change(clientState, "sub-1", "evt-1", "Event")])).status).toBe(202);
    expect(await ctx.evidence()).toEqual([]);
  });

  test("retries_delivery_without_duplicate (outlook)", async () => {
    const ctx = await setup("outlook-mail", [FOLDER]);
    const { clientState } = await connectOutlook(ctx);
    const calls = stubFetch(microsoftRoutes());
    const note = change(clientState);
    const responses = [await postGraph(ctx, [note]), await postGraph(ctx, [note])];
    expect(responses.map((r) => r.status)).toEqual([202, 202]);
    const rows = await ctx.evidence();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: "mail-1", occurredAt: "2026-11-14T08:15:00.000Z", origin: "live" });
    expect(rows[0]!.text).toContain("Subject: OVPCC follow-up");
    expect(rows[0]!.text).toContain("please confirm the pitch slot");
    expect(calls.filter((call) => call.url.startsWith(`${GRAPH}/me/messages/mail-1`))).toHaveLength(2);
  });

  test("calendar_event_keeps_timezone_and_cancelled_state", async () => {
    const ctx = await setup("outlook-calendar", [CALENDAR]);
    const { clientState } = await connectOutlook(ctx);
    stubFetch(
      microsoftRoutes({
        [`${GRAPH}/me/events/`]: () => json(graphEvent({ isCancelled: true, lastModifiedDateTime: "2026-11-14T08:45:00Z" })),
      }),
    );
    expect((await postGraph(ctx, [change(clientState, "sub-1", "evt-1", "Event")])).status).toBe(202);
    const [row] = await ctx.evidence();
    expect(row!.text).toContain("2026-11-20T15:00:00.0000000 Eastern Standard Time");
    expect(row!.text).toContain("2026-11-20T15:30:00.0000000 Eastern Standard Time");
    expect(row!.text).toMatch(/cancelled/i);
  });

  test("calendar_permission_failure_is_not_empty_calendar", async () => {
    const ctx = await setup("outlook-calendar", [CALENDAR]);
    await connectOutlook(ctx, microsoftRoutes({ [`${GRAPH}/me/calendars/`]: () => json({ value: [graphEvent()] }) }));
    expect(await ctx.connection()).toMatchObject({ availability: "connected", lastCheckedAt: NOW.toISOString() });
    expect(await ctx.evidence()).toHaveLength(1);

    vi.setSystemTime(new Date(NOW.getTime() + 6 * 60 * 60 * 1000));
    stubFetch(
      microsoftRoutes({
        [`${GRAPH}/me/calendars/`]: () => json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, 403),
      }),
    );
    await expect(
      ctx.asAlice.action(api.connectors.outlook.refresh, { sourceId: ctx.sourceId, kind: "outlook-calendar" }),
    ).rejects.toThrow(/missing-access/);
    expect(await ctx.connection()).toMatchObject({
      availability: "missing-access",
      lastError: "http_403",
      lastCheckedAt: NOW.toISOString(), // the old check time, not "checked now and empty"
    });
    expect(await ctx.evidence()).toHaveLength(1);
  });

  test("expired_cursor_is_stale_until_event_or_user_refresh (outlook: missed)", async () => {
    const ctx = await setup("outlook-mail", [FOLDER]);
    const { clientState } = await connectOutlook(ctx);
    const lifecycle = (event: string) => ({
      subscriptionId: "sub-1",
      clientState,
      lifecycleEvent: event,
      subscriptionExpirationDateTime: "2026-11-21T09:00:00Z",
      tenantId: "tenant-illustrative",
    });
    let calls = stubFetch(microsoftRoutes());
    expect((await postGraph(ctx, [lifecycle("missed")])).status).toBe(202);
    expect(await ctx.connection()).toMatchObject({ availability: "stale", lastError: "notifications_missed" });
    expect(calls).toEqual([]); // no resync until an event or the user asks

    // Next provider event while stale: one bounded read of the selected folder.
    calls = stubFetch(microsoftRoutes({ [`${GRAPH}/me/mailFolders/`]: () => json({ value: [graphMessage] }) }));
    expect((await postGraph(ctx, [change(clientState)])).status).toBe(202);
    const folderRead = calls.find((call) => call.url.startsWith(`${GRAPH}/me/mailFolders/${FOLDER}/messages`))!;
    expect(folderRead.url).toMatch(/\$top=\d+/);
    expect(await ctx.connection()).toMatchObject({ availability: "connected" });

    // Stale again, repaired by the user's Refresh.
    stubFetch(microsoftRoutes());
    await postGraph(ctx, [lifecycle("missed")]);
    expect(await ctx.connection()).toMatchObject({ availability: "stale" });
    stubFetch(microsoftRoutes({ [`${GRAPH}/me/mailFolders/`]: () => json({ value: [graphMessage] }) }));
    await ctx.asAlice.action(api.connectors.outlook.refresh, { sourceId: ctx.sourceId, kind: "outlook-mail" });
    expect(await ctx.connection()).toMatchObject({ availability: "connected" });
    expect(await ctx.evidence()).toHaveLength(1);
  });

  test("lifecycle_reauthorization_and_removal_keep_the_subscription", async () => {
    const ctx = await setup("outlook-mail", [FOLDER]);
    const { clientState } = await connectOutlook(ctx);
    const calls = stubFetch(microsoftRoutes());
    const lifecycle = (event: string) => ({ subscriptionId: "sub-1", clientState, lifecycleEvent: event });
    expect((await postGraph(ctx, [lifecycle("reauthorizationRequired")])).status).toBe(202);
    expect(calls.some((call) => call.method === "POST" && call.url === `${GRAPH}/subscriptions/sub-1/reauthorize`)).toBe(true);
    expect((await postGraph(ctx, [lifecycle("subscriptionRemoved")])).status).toBe(202);
    const recreated = calls.filter((call) => call.method === "POST" && call.url === `${GRAPH}/subscriptions`);
    expect(recreated).toHaveLength(1);
    expect(JSON.parse(recreated[0]!.body)).toMatchObject({ resource: `me/mailFolders('${FOLDER}')/messages`, clientState });
    // Removal means changes may have been lost while it was gone: stale until event or Refresh.
    expect(await ctx.connection()).toMatchObject({ availability: "stale", lastError: "subscription_removed" });
    expect(calls.some((call) => call.url.includes("/messages"))).toBe(false);
  });

  test("outlook_subscriptions_cover_selected_resources_with_client_state", async () => {
    const ctx = await setup("outlook-mail", [FOLDER]);
    const { calls } = await connectOutlook(ctx);
    const [created] = calls.filter((call) => call.method === "POST" && call.url === `${GRAPH}/subscriptions`);
    const body = JSON.parse(created!.body) as Record<string, string>;
    expect(body).toMatchObject({
      changeType: "created",
      resource: `me/mailFolders('${FOLDER}')/messages`,
      notificationUrl: `${SITE}/outlook/notifications?source=${ctx.sourceId}`,
      lifecycleNotificationUrl: `${SITE}/outlook/notifications?source=${ctx.sourceId}`,
    });
    expect(body.clientState).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const lifetime = Date.parse(body.expirationDateTime!) - NOW.getTime();
    expect(lifetime).toBeLessThanOrEqual(10_080 * 60 * 1000); // Graph's Outlook maximum
    expect(lifetime).toBeGreaterThan(6 * DAY);
  });
});

describe("oauth callbacks", () => {
  test.each([
    { provider: "google" as const, kind: "gmail" as const, selectors: [LABEL] },
    { provider: "microsoft" as const, kind: "outlook-mail" as const, selectors: [FOLDER] },
  ])("oauth_callback_with_unknown_expired_or_reused_state_stores_nothing ($provider)", async ({ provider, kind, selectors }) => {
    const ctx = await setup(kind, selectors);
    const routes = provider === "google" ? googleRoutes() : microsoftRoutes();
    const start = () =>
      provider === "google"
        ? ctx.asAlice.mutation(api.connectors.gmail.startConnect, { sourceId: ctx.sourceId })
        : ctx.asAlice.mutation(api.connectors.outlook.startConnect, { sourceId: ctx.sourceId });
    const callback = (state: string) => ctx.t.fetch(`/oauth/${provider}/callback?code=illustrative-code&state=${state}`);

    const calls = stubFetch(routes);
    expect((await callback("unknown-state")).status).toBe(400);
    expect((await callback("")).status).toBe(400);

    const expiring = stateOf(await start());
    vi.setSystemTime(new Date(NOW.getTime() + 11 * 60 * 1000));
    expect((await callback(expiring)).status).toBe(400);
    expect(calls).toEqual([]); // no code exchange for a bad state
    expect(await ctx.stored()).toBeNull();

    const state = stateOf(await start());
    expect((await callback(state)).status).toBe(200);
    const exchanges = () => calls.filter((call) => call.body.includes("grant_type=authorization_code")).length;
    expect(exchanges()).toBe(1);
    expect((await callback(state)).status).toBe(400); // single use
    expect(exchanges()).toBe(1);
  });

  test("start_connect_is_owner_only_and_requests_read_scopes", async () => {
    const gmail = await setup("gmail", [LABEL]);
    const google = new URL(await gmail.asAlice.mutation(api.connectors.gmail.startConnect, { sourceId: gmail.sourceId }));
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(google.searchParams.get("redirect_uri")).toBe(`${SITE}/oauth/google/callback`);
    expect(google.searchParams.get("access_type")).toBe("offline");
    const asBob = gmail.t.withIdentity({ tokenIdentifier: gmail.bob.ownerId, subject: "bob" });
    await expect(asBob.mutation(api.connectors.gmail.startConnect, { sourceId: gmail.sourceId })).rejects.toThrow(
      /not available/i,
    );

    const outlook = await setup("outlook-calendar", [CALENDAR]);
    const ms = new URL(await outlook.asAlice.mutation(api.connectors.outlook.startConnect, { sourceId: outlook.sourceId }));
    expect(ms.origin + ms.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(ms.searchParams.get("scope")).toBe("offline_access Calendars.Read");
    expect(ms.searchParams.get("redirect_uri")).toBe(`${SITE}/oauth/microsoft/callback`);
    await expect(
      outlook.asAlice.mutation(api.connectors.gmail.startConnect, { sourceId: outlook.sourceId }),
    ).rejects.toThrow(/not available/i); // wrong kind
  });

  test("take_oauth_state_returns_binding_once_until_expiry", async () => {
    const ctx = await setup("gmail", [LABEL]);
    const state = await ctx.t.run((db) => issueOAuthState(db, ctx.alice.ownerId, "gmail:src-1"));
    const take = (value: string) => ctx.t.run((db) => takeOAuthState(db, value));
    expect(await take(state)).toEqual({ ownerId: ctx.alice.ownerId, provider: "gmail:src-1" });
    expect(await take(state)).toBeNull();
    const expiring = await ctx.t.run((db) => issueOAuthState(db, ctx.alice.ownerId, "gmail:src-1"));
    vi.setSystemTime(new Date(NOW.getTime() + 11 * 60 * 1000));
    expect(await take(expiring)).toBeNull();
    expect(await ctx.t.run((db) => db.db.query("oauthStates").collect())).toEqual([]); // burned, not left behind
  });

  test.each([
    { kind: "gmail" as const, selectors: [LABEL], secrets: [GOOGLE_REFRESH, GOOGLE_ACCESS] },
    { kind: "outlook-mail" as const, selectors: [FOLDER], secrets: [MS_REFRESH, MS_ACCESS] },
  ])("tokens_never_returned_by_list_connections ($kind)", async ({ kind, selectors, secrets }) => {
    const ctx = await setup(kind, selectors);
    if (kind === "gmail") await connectGmail(ctx);
    else await connectOutlook(ctx);
    const rows = await ctx.asAlice.query(api.connections.listConnections, {});
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "availability",
      "lastCheckedAt",
      "provider",
      "sourceId",
      "subscriptionExpiresAt",
    ]);
    const serialized = JSON.stringify(rows);
    const stored = (await ctx.stored())!;
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
      expect(stored.credential).not.toContain(secret); // sealed at rest
    }
    expect(serialized).not.toContain(stored.credential);
  });
});

describe("lease renewal", () => {
  test.each([
    { kind: "gmail" as const, selectors: [LABEL], fn: "gmail" as const },
    { kind: "outlook-mail" as const, selectors: [FOLDER], fn: "outlook" as const },
  ])("renewal_is_scheduled_from_lease_expiry_and_reads_no_content ($kind)", async ({ kind, selectors, fn }) => {
    const ctx = await setup(kind, selectors);
    if (kind === "gmail") await connectGmail(ctx);
    else await connectOutlook(ctx);
    const [job] = await ctx.scheduled();
    expect(await ctx.scheduled()).toHaveLength(1);
    expect(job!.name).toMatch(new RegExp(`connectors/${fn}.*renewLease`));
    expect(job!.args[0]).toEqual({ sourceId: ctx.sourceId, grantVersion: 1 });
    const expiresAt = (await ctx.connection())!.subscriptionExpiresAt!;
    expect(job!.scheduledTime).toBe(expiresAt - DAY);

    vi.setSystemTime(new Date(job!.scheduledTime));
    const calls = stubFetch(kind === "gmail" ? googleRoutes() : microsoftRoutes());
    await ctx.t.action(fn === "gmail" ? internal.connectors.gmail.renewLease : internal.connectors.outlook.renewLease, {
      sourceId: ctx.sourceId,
      grantVersion: 1,
    });
    const urls = calls.map((call) => `${call.method} ${call.url.split("?")[0]}`);
    expect(urls).toEqual(
      kind === "gmail" ? [`POST ${GOOGLE_TOKEN}`, `POST ${GMAIL}/watch`] : [`POST ${MS_TOKEN}`, `PATCH ${GRAPH}/subscriptions/sub-1`],
    );
    const renewedExpiry = (await ctx.connection())!.subscriptionExpiresAt!;
    expect(renewedExpiry).toBeGreaterThan(expiresAt);
    const pending = await ctx.scheduled();
    expect(pending.map((row) => row.scheduledTime)).toContain(renewedExpiry - DAY);
  });

  test.each([
    { kind: "gmail" as const, selectors: [LABEL], fn: "gmail" as const },
    { kind: "outlook-calendar" as const, selectors: [CALENDAR], fn: "outlook" as const },
  ])("renewal_stops_after_revoke ($kind)", async ({ kind, selectors, fn }) => {
    const ctx = await setup(kind, selectors);
    if (kind === "gmail") await connectGmail(ctx);
    else await connectOutlook(ctx);
    await ctx.revoke();
    const [job] = await ctx.scheduled();
    vi.setSystemTime(new Date(job!.scheduledTime));
    const calls = stubFetch({});
    const before = (await ctx.scheduled()).length;
    await ctx.t.action(fn === "gmail" ? internal.connectors.gmail.renewLease : internal.connectors.outlook.renewLease, {
      sourceId: ctx.sourceId,
      grantVersion: 1,
    });
    expect(calls).toEqual([]);
    expect((await ctx.scheduled()).length).toBe(before); // nothing new scheduled
  });
});
