// @vitest-environment edge-runtime
// Fixture-only: Composio's REST API is a small in-memory fake behind a stubbed `fetch`, with
// request/response shapes taken from docs.composio.dev. These tests prove our adapter logic,
// never live Composio access, a real connected account or a real send.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProjectIdSchema, type ProjectId } from "@companion/domain";
import { contentHash } from "../../packages/domain/src/actions";
import { api } from "../../convex/_generated/api";
import { composioUserId } from "../../convex/connectors/composio";
import schema from "../../convex/schema";
import { makeOwners } from "../fixtures";

const modules = import.meta.glob("../../convex/**/*.*s");

const API = "https://backend.composio.dev/api/v3.1";
const SITE = "https://illustrative.convex.site";
const SECRET = "illustrative-composio-webhook-secret";
const CHANNEL = "C0SELECTED";
const LABEL = "Label_avt";
const FOLDER = "AAMkFolder-avt";
const DRAFT = "AVT pitch follow-up\n\nHere is the outline we discussed.";
const BOB_MAIL = "bob@illustrative.example";

beforeEach(() => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", btoa(String.fromCharCode(...key)));
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("COMPOSIO_API_KEY", "illustrative-composio-api-key");
  vi.stubEnv("COMPOSIO_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("COMPOSIO_AUTH_CONFIG_SLACK", "ac_slack");
  vi.stubEnv("COMPOSIO_AUTH_CONFIG_GMAIL", "ac_gmail");
  vi.stubEnv("COMPOSIO_AUTH_CONFIG_OUTLOOK", "ac_outlook");
  vi.stubEnv("COMPOSIO_AUTH_CONFIG_TEAMS", "ac_teams");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---- fetch stub: longest matching URL prefix wins.
type Call = { method: string; url: string; body: string; apiKey: string | null };
type Stub = (call: Call) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const timeout = () => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};
let calls: Call[] = [];
function stubFetch(routes: Record<string, Stub>) {
  calls = [];
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const apiKey = new Headers(init.headers).get("x-api-key");
    const call = { method: init.method ?? "GET", url, body: String(init.body ?? ""), apiKey };
    calls.push(call);
    const match = prefixes.find((prefix) => url.startsWith(prefix));
    if (match === undefined) throw new Error(`Unexpected fetch ${call.method} ${url}`);
    return routes[match]!(call);
  });
}
const executed = (slug: string) => calls.filter((c) => c.url === `${API}/tools/execute/${slug}`);

/** Composio's side of one connected account; tools are answered by `tools`. */
function fakeComposio(account: { id: string; userId: () => Promise<string>; toolkit: string }, tools: Record<string, Stub> = {}) {
  return {
    [`${API}/connected_accounts/link`]: () =>
      json({ link_token: "lt_1", redirect_url: "https://connect.composio.dev/link/ln_1", expires_at: "2026-11-14T12:10:00Z", connected_account_id: account.id }, 201),
    [`${API}/connected_accounts/${account.id}`]: async (call: Call) =>
      call.method === "DELETE" ? json({ success: true }) : json({ id: account.id, status: "ACTIVE", user_id: await account.userId(), toolkit: { slug: account.toolkit } }),
    [`${API}/trigger_instances/`]: () => json({ trigger_id: "ti_1" }),
    ...Object.fromEntries(Object.entries(tools).map(([slug, stub]) => [`${API}/tools/execute/${slug}`, stub])),
  } satisfies Record<string, Stub>;
}

async function setup(kind: "slack" | "gmail" | "outlook-mail" | "teams", selectors: string[]) {
  const t = convexTest(schema, modules);
  const { alice, bob } = makeOwners();
  const asAlice = t.withIdentity({ tokenIdentifier: alice.ownerId, subject: "alice" });
  const projectId = ProjectIdSchema.parse(await asAlice.mutation(api.projects.createProject, { name: "AVT" }));
  const sourceId = `source-${kind}-${crypto.randomUUID()}`;
  const grant = { id: sourceId, kind, selectors, projectIds: [projectId as ProjectId], read: true, writeTargets: [], cloudProcessing: true, version: 1, state: "active" };
  await asAlice.mutation(api.evidence.setGrant, grant);
  const evidence = () => t.run((ctx) => ctx.db.query("evidence").collect());
  const connection = () => asAlice.query(api.connections.listConnections, {}).then((rows) => rows[0]);
  const toolkit = { slack: "slack", gmail: "gmail", "outlook-mail": "outlook", teams: "microsoft_teams" }[kind];
  const account = { id: `ca_${kind}_alice`, userId: () => composioUserId(alice.ownerId), toolkit };
  return { t, alice, bob, asAlice, projectId, sourceId, grant, evidence, connection, account };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function connect(ctx: Ctx, tools: Record<string, Stub> = {}) {
  stubFetch(fakeComposio(ctx.account, tools));
  const url = await ctx.asAlice.action(api.connectors.composio.startConnect, { sourceId: ctx.sourceId, kind: ctx.grant.kind as never });
  const link = calls.find((c) => c.url === `${API}/connected_accounts/link`)!;
  const callback = new URL(JSON.parse(link.body).callback_url as string);
  const response = await ctx.t.fetch(`${callback.pathname}${callback.search}&status=success&connected_account_id=${ctx.account.id}`);
  return { url, link, callback, response };
}

async function sign(id: string, timestamp: string, body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return btoa(String.fromCharCode(...mac));
}

async function deliver(ctx: Ctx, slug: string, data: unknown, overrides: { userId?: string; accountId?: string; secret?: string; id?: string } = {}) {
  const id = overrides.id ?? `msg_${crypto.randomUUID()}`;
  const body = JSON.stringify({
    id,
    type: "composio.trigger.message",
    metadata: {
      log_id: "log_1",
      trigger_slug: slug,
      trigger_id: "ti_1",
      connected_account_id: overrides.accountId ?? ctx.account.id,
      auth_config_id: "ac_1",
      user_id: overrides.userId ?? (await composioUserId(ctx.alice.ownerId)),
    },
    data,
    timestamp: "2026-11-14T10:30:00Z",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return ctx.t.fetch("/composio/events", {
    method: "POST",
    body,
    headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${await sign(id, timestamp, body, overrides.secret)}` },
  });
}

const slackMessage = (channel = CHANNEL, ts = "1763150400.000100") => ({
  channel,
  channel_type: "channel",
  team_id: "T0ILLUSTRATIVE",
  text: "Illustrative: I'll send the deck Friday.",
  ts,
  user: "U0ALICE",
});

describe("composio connect", () => {
  test("connect_link_is_bound_to_the_signed_in_owner_and_stores_the_connection", async () => {
    const ctx = await setup("slack", [CHANNEL]);
    const { url, link, response } = await connect(ctx);
    expect(new URL(url).origin).toBe("https://connect.composio.dev");
    const sent = JSON.parse(link.body) as Record<string, string>;
    // The Composio user id is an opaque hash: never the owner id, name or email.
    expect(sent).toMatchObject({ auth_config_id: "ac_slack", user_id: await composioUserId(ctx.alice.ownerId) });
    expect(link.body).not.toContain(ctx.alice.ownerId);
    expect(link.body).not.toMatch(/alice/i);
    expect(link.apiKey).toBe("illustrative-composio-api-key");
    expect(response.status).toBe(200);
    expect(await ctx.connection()).toMatchObject({ sourceId: ctx.sourceId, provider: "slack", availability: "connected", broker: "composio" });
    // One trigger per selected channel, pinned to this connected account.
    const upserts = calls.filter((c) => c.url.startsWith(`${API}/trigger_instances/`));
    expect(upserts.map((c) => c.url)).toEqual([`${API}/trigger_instances/SLACK_CHANNEL_MESSAGE_RECEIVED/upsert`]);
    expect(JSON.parse(upserts[0]!.body)).toMatchObject({ connected_account_id: ctx.account.id, trigger_config: { channel_id: CHANNEL } });
  });

  test("callback_state_is_single_use_and_must_name_the_same_account", async () => {
    const ctx = await setup("gmail", [LABEL]);
    stubFetch(fakeComposio(ctx.account));
    await ctx.asAlice.action(api.connectors.composio.startConnect, { sourceId: ctx.sourceId, kind: "gmail" });
    const callback = new URL(JSON.parse(calls[0]!.body).callback_url as string);
    const other = await ctx.t.fetch(`${callback.pathname}${callback.search}&status=success&connected_account_id=ca_someone_else`);
    expect(other.status).toBe(400);
    // The wrong account burned the state; the right one now fails too.
    const replay = await ctx.t.fetch(`${callback.pathname}${callback.search}&status=success&connected_account_id=${ctx.account.id}`);
    expect(replay.status).toBe(400);
    expect(await ctx.connection()).toBeUndefined();
  });

  test("an account Composio holds for another user is not stored", async () => {
    const ctx = await setup("gmail", [LABEL]);
    const { response } = await connect({ ...ctx, account: { ...ctx.account, userId: () => composioUserId(ctx.bob.ownerId) } });
    expect(response.status).toBe(400);
    expect(await ctx.connection()).toBeUndefined();
  });

  test("teams connects but has no trigger to subscribe", async () => {
    const ctx = await setup("teams", ["19:chat-avt"]);
    const { response } = await connect(ctx);
    expect(response.status).toBe(200);
    expect(await ctx.connection()).toMatchObject({ provider: "teams", broker: "composio" });
    expect(calls.filter((c) => c.url.startsWith(`${API}/trigger_instances/`))).toHaveLength(0);
  });

  test("only the owner may start a connect for a source", async () => {
    const ctx = await setup("slack", [CHANNEL]);
    stubFetch(fakeComposio(ctx.account));
    const asBob = ctx.t.withIdentity({ tokenIdentifier: ctx.bob.ownerId, subject: "bob" });
    await expect(asBob.action(api.connectors.composio.startConnect, { sourceId: ctx.sourceId, kind: "slack" })).rejects.toThrow(/not available/);
    expect(calls).toHaveLength(0);
  });
});

describe("composio events", () => {
  test("a signed slack message becomes evidence under the stored owner and grant", async () => {
    const ctx = await setup("slack", [CHANNEL]);
    await connect(ctx);
    // A payload field naming another owner is content, never authority.
    const response = await deliver(ctx, "SLACK_CHANNEL_MESSAGE_RECEIVED", { ...slackMessage(), ownerId: ctx.bob.ownerId });
    expect(response.status).toBe(200);
    const rows = await ctx.evidence();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ownerId: ctx.alice.ownerId,
      sourceId: ctx.sourceId,
      externalId: `${CHANNEL}:1763150400.000100`,
      version: "1763150400.000100",
      grantVersion: 1,
      projectIds: [ctx.projectId],
    });
  });

  test("the same event delivered twice is stored once", async () => {
    const ctx = await setup("slack", [CHANNEL]);
    await connect(ctx);
    await deliver(ctx, "SLACK_CHANNEL_MESSAGE_RECEIVED", slackMessage());
    await deliver(ctx, "SLACK_CHANNEL_MESSAGE_RECEIVED", slackMessage());
    expect(await ctx.evidence()).toHaveLength(1);
  });

  test("an unselected channel, an unknown trigger and a bad signature store nothing", async () => {
    const ctx = await setup("slack", [CHANNEL]);
    await connect(ctx);
    expect((await deliver(ctx, "SLACK_CHANNEL_MESSAGE_RECEIVED", slackMessage("C0OTHER"))).status).toBe(200);
    expect((await deliver(ctx, "SLACK_MESSAGE_REACTION_ADDED", slackMessage())).status).toBe(200);
    expect((await deliver(ctx, "SLACK_CHANNEL_MESSAGE_RECEIVED", slackMessage(), { secret: "wrong" })).status).toBe(401);
    expect(await ctx.evidence()).toHaveLength(0);
  });

  test("a payload naming another owner's user id is ignored", async () => {
    const ctx = await setup("slack", [CHANNEL]);
    await connect(ctx);
    expect((await deliver(ctx, "SLACK_CHANNEL_MESSAGE_RECEIVED", slackMessage(), { userId: await composioUserId(ctx.bob.ownerId) })).status).toBe(200);
    expect((await deliver(ctx, "SLACK_CHANNEL_MESSAGE_RECEIVED", slackMessage(), { accountId: "ca_unknown" })).status).toBe(200);
    expect(await ctx.evidence()).toHaveLength(0);
  });

  test("a revoked grant ingests nothing and its Composio account is deleted", async () => {
    const ctx = await setup("slack", [CHANNEL]);
    await connect(ctx);
    await ctx.asAlice.mutation(api.evidence.setGrantState, { sourceId: ctx.sourceId, state: "revoked" });
    await ctx.t.finishAllScheduledFunctions(() => {});
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`${API}/connected_accounts/${ctx.account.id}`]);
    expect((await deliver(ctx, "SLACK_CHANNEL_MESSAGE_RECEIVED", slackMessage())).status).toBe(200);
    expect(await ctx.evidence()).toHaveLength(0);
  });

  test("a gmail message in a selected label becomes evidence", async () => {
    const ctx = await setup("gmail", [LABEL]);
    await connect(ctx);
    const message = (id: string, labels: string[]) => ({
      id,
      message_id: id,
      thread_id: "t1",
      label_ids: labels,
      sender: "Bob <bob@illustrative.example>",
      subject: "Deck",
      message_text: "Illustrative: can you send the deck by Friday?",
      message_timestamp: "2026-11-14T10:29:00Z",
    });
    await deliver(ctx, "GMAIL_NEW_GMAIL_MESSAGE", message("18c1", [LABEL, "INBOX"]));
    await deliver(ctx, "GMAIL_NEW_GMAIL_MESSAGE", message("18c2", ["INBOX"]));
    const rows = await ctx.evidence();
    expect(rows.map((r) => r.externalId)).toEqual(["18c1"]);
    expect(rows[0]!.text).toContain("Subject: Deck");
    expect(rows[0]!.occurredAt).toBe("2026-11-14T10:29:00.000Z");
  });

  test("an outlook message id is read back through a read tool and kept only in a selected folder", async () => {
    const ctx = await setup("outlook-mail", [FOLDER]);
    const graph = (id: string, folder: string) => ({
      id,
      parentFolderId: folder,
      subject: "Venue",
      from: { emailAddress: { name: "Bob", address: BOB_MAIL } },
      body: { content: "Illustrative: venue confirmed for Tuesday." },
      receivedDateTime: "2026-11-14T10:00:00Z",
      webLink: "https://outlook.office.com/mail/id/1",
    });
    await connect(ctx, {
      OUTLOOK_GET_MESSAGE: (call) => {
        const id = (JSON.parse(call.body) as { arguments: { message_id: string } }).arguments.message_id;
        return json({ successful: true, error: null, data: graph(id, id === "AAMk-in" ? FOLDER : "AAMkFolder-other") });
      },
    });
    await deliver(ctx, "OUTLOOK_MESSAGE_TRIGGER", { event_type: "created", id: "AAMk-in" });
    await deliver(ctx, "OUTLOOK_MESSAGE_TRIGGER", { event_type: "created", id: "AAMk-out" });
    const rows = await ctx.evidence();
    expect(rows.map((r) => r.externalId)).toEqual(["AAMk-in"]);
    expect(rows[0]!.sourceUrl).toBe("https://outlook.office.com/mail/id/1");
  });
});

// ---- Sends through the existing action flow.
async function withDraft(ctx: Ctx) {
  await ctx.t.run(async (db) => {
    await db.db.insert("preparedWork", {
      ownerId: ctx.alice.ownerId,
      projectId: ctx.projectId,
      work: { projectId: ctx.projectId, title: "Follow-up", body: DRAFT, evidenceIds: [], gaps: [], nextAction: "Send it.", state: "ready" },
      factKeys: [],
      status: "ready",
      updatedAt: "2026-11-14T08:00:00.000Z",
    });
  });
  const artifactId = await ctx.asAlice.mutation(api.artifacts.createFromPrepared, { projectId: ctx.projectId });
  return async (kind: "send-mail" | "post-message", destination: string) => {
    const result = await ctx.asAlice.action(api.actions.executeIntent, {
      projectId: ctx.projectId,
      kind,
      destination,
      artifactId,
      revision: "1",
      contentHash: await contentHash(DRAFT),
      instructionId: `instruction-${crypto.randomUUID()}`,
    });
    if (!("id" in result)) throw new Error(`expected a receipt, got ${result.reason}`);
    return result;
  };
}

function gmailTools(send: Stub) {
  const sent = new Map<string, string>();
  return {
    sent,
    tools: {
      GMAIL_SEND_EMAIL: async (call: Call) => {
        const response = await send(call);
        if (response.ok) {
          const args = (JSON.parse(call.body) as { arguments: { body: string } }).arguments;
          sent.set(`m${sent.size + 1}`, args.body);
        }
        return response;
      },
      GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: (call: Call) => {
        const id = (JSON.parse(call.body) as { arguments: { message_id: string } }).arguments.message_id;
        const body = sent.get(id);
        return body === undefined
          ? json({ successful: false, error: "not found", data: {} })
          : json({ successful: true, error: null, data: { messageId: id, labelIds: ["SENT"], messageText: body } });
      },
    } satisfies Record<string, Stub>,
  };
}

describe("composio sends", () => {
  test("gmail send is reserved, executed once, and verified by read-back", async () => {
    const ctx = await setup("gmail", [LABEL]);
    const gmail = gmailTools(() => json({ successful: true, error: null, data: { id: "m1", threadId: "t1", labelIds: ["SENT"] } }));
    await connect(ctx, gmail.tools);
    const execute = await withDraft(ctx);
    // No send consent yet: nothing is sent.
    await expect(execute("send-mail", BOB_MAIL)).rejects.toThrow(/missing-send-permission/);
    expect(executed("GMAIL_SEND_EMAIL")).toHaveLength(0);

    await ctx.asAlice.action(api.connectors.composio.allowSend, { sourceId: ctx.sourceId });
    const receipt = await execute("send-mail", BOB_MAIL);
    expect(receipt).toMatchObject({ state: "succeeded", externalId: "m1", kind: "send-mail", destination: BOB_MAIL });
    const args = JSON.parse(executed("GMAIL_SEND_EMAIL")[0]!.body) as Record<string, unknown>;
    expect(args).toMatchObject({ connected_account_id: ctx.account.id, user_id: await composioUserId(ctx.alice.ownerId), arguments: { recipient_email: BOB_MAIL, body: DRAFT } });
  });

  test("a 4xx is failed; a timeout is unknown and a check never resends", async () => {
    const ctx = await setup("gmail", [LABEL]);
    let mode: "refuse" | "timeout" = "refuse";
    const gmail = gmailTools(() => (mode === "refuse" ? json({ error: { message: "bad", code: 400, slug: "bad_request", status: 400 } }, 400) : timeout()));
    await connect(ctx, gmail.tools);
    await ctx.asAlice.action(api.connectors.composio.allowSend, { sourceId: ctx.sourceId });
    const execute = await withDraft(ctx);
    expect(await execute("send-mail", BOB_MAIL)).toMatchObject({ state: "failed", reason: "http_400" });

    mode = "timeout";
    const lost = await execute("send-mail", BOB_MAIL);
    expect(lost).toMatchObject({ state: "unknown", reason: "timeout" });
    expect((await ctx.asAlice.action(api.actions.reconcileAction, { actionId: lost.id })).state).toBe("unknown");
    expect(executed("GMAIL_SEND_EMAIL")).toHaveLength(2); // one per instruction, never a resend
  });

  test("slack post is verified by reading the posted message back", async () => {
    const ctx = await setup("slack", [CHANNEL]);
    const posted = new Map<string, string>();
    await connect(ctx, {
      SLACK_CHAT_POST_MESSAGE: (call) => {
        const args = (JSON.parse(call.body) as { arguments: { channel: string; text: string } }).arguments;
        posted.set("1763150500.000200", args.text);
        return json({ successful: true, error: null, data: { ok: true, channel: args.channel, ts: "1763150500.000200" } });
      },
      SLACK_FETCH_CONVERSATION_HISTORY: (call) => {
        const args = (JSON.parse(call.body) as { arguments: { latest: string } }).arguments;
        const text = posted.get(args.latest);
        return json({ successful: true, error: null, data: { ok: true, messages: text === undefined ? [] : [{ ts: args.latest, text }] } });
      },
    });
    await ctx.asAlice.action(api.connectors.composio.allowSend, { sourceId: ctx.sourceId });
    const execute = await withDraft(ctx);
    const receipt = await execute("post-message", "C0TEAMCHAT");
    expect(receipt).toMatchObject({ state: "succeeded", kind: "post-message", destination: "C0TEAMCHAT", externalId: "C0TEAMCHAT:1763150500.000200" });
    expect(executed("SLACK_CHAT_POST_MESSAGE")).toHaveLength(1);
  });
});
