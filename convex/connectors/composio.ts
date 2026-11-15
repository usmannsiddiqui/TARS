// Composio: Slack, Gmail, Outlook mail, Teams and GitHub through Composio-hosted sign-in. Composio holds the
// OAuth tokens; we keep only the connected account id. Every trigger event arrives at one signed
// webhook (/composio/events) and goes through the one intake path. Reads use read-only tools on
// our own; a write (send/post) runs only from actions.executeIntent, through `perform`.
// Docs: docs.composio.dev (triggers, subscribing-to-events, connected-accounts, tools, toolkits/github).
import { ConvexError, v } from "convex/values";
import { z } from "zod";
import { contentHash, mailSubject, outcomeForFailure, sameContent, type EffectOutcome } from "../../packages/domain/src/actions";
import { isWriteTool, parseRepositories } from "../../packages/domain/src/composio";
import { mailFields } from "../../packages/domain/src/delivery";
import type { SourceGrant } from "../../packages/domain/src/types";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { action, type ActionCtx, httpAction, internalAction, internalMutation } from "../_generated/server";
import { ingestItems, loadContext, markChecked, markFailed, requireOwnedSource, type ProviderItem } from "../connections";
import { requireOwnerId } from "../lib/auth";
import {
  issueOAuthState,
  oauthResultPage,
  ProviderError,
  providerJson,
  randomToken,
  requireEnv,
  sealCredential,
  takeOAuthState,
  verifyHmacSha256Base64,
} from "../lib/providerAuth";
import { type GraphMessage, mailItem } from "./outlook";
import { toItem as slackItem } from "./slack";

const API = "https://backend.composio.dev/api/v3.1";
/** Composio's hosted connect page; the desktop allowlists exactly this origin. */
export const CONNECT_ORIGIN = "https://connect.composio.dev";
const STATE_PREFIX = "composio:";
const TOLERANCE_SECONDS = 300; // the SDK's default webhook tolerance
const MAX_SIGNATURES = 5;
const MAX_TEXT = 4000;
const MAX_FETCH = 10; // messages per on-event mail check
const CHECK_DEBOUNCE_MS = 20_000;
// shortcut: "latest" follows Composio's newest tool schema; pin a dated version once proven live.
const TOOL_VERSION = "latest";

const KINDS = ["slack", "gmail", "outlook-mail", "teams", "github"] as const;
type Kind = (typeof KINDS)[number];
const kindArg = v.union(...KINDS.map((k) => v.literal(k)));
const NAME: Record<Kind, string> = { slack: "Slack", gmail: "Gmail", "outlook-mail": "Outlook mail", teams: "Microsoft Teams", github: "GitHub" };
const TOOLKIT: Record<Kind, string> = { slack: "slack", gmail: "gmail", "outlook-mail": "outlook", teams: "microsoft_teams", github: "github" };
/** One auth config per toolkit, made in the Composio dashboard (managed or your own OAuth app). */
const AUTH_CONFIG_ENV: Record<Kind, string> = {
  slack: "COMPOSIO_AUTH_CONFIG_SLACK",
  gmail: "COMPOSIO_AUTH_CONFIG_GMAIL",
  "outlook-mail": "COMPOSIO_AUTH_CONFIG_OUTLOOK",
  teams: "COMPOSIO_AUTH_CONFIG_TEAMS",
  github: "COMPOSIO_AUTH_CONFIG_GITHUB",
};
/**
 * The triggers per kind, one instance of each per selected item. Slack, Outlook and GitHub are
 * realtime (webhooks); Gmail's may be polled by Composio on its side (nothing here runs on a timer), so
 * it asks for a one-minute interval. Teams has no message trigger, so a Teams connection receives nothing yet.
 */
type Trigger = { slug: string; config(selector: string): Record<string, unknown>; pollingInterval?: number };
const ownerRepo = (repository: string) => {
  const [owner, repo] = repository.split("/");
  return { owner, repo };
};
const TRIGGERS: Partial<Record<Kind, Trigger[]>> = {
  slack: [{ slug: "SLACK_CHANNEL_MESSAGE_RECEIVED", config: (channel) => ({ channel_id: channel }) }],
  // shortcut: labelIds' type (string vs list) is not documented; one label per instance as a string.
  gmail: [{ slug: "GMAIL_NEW_GMAIL_MESSAGE", config: (label) => ({ labelIds: label }), pollingInterval: 1 }],
  "outlook-mail": [{ slug: "OUTLOOK_MESSAGE_TRIGGER", config: (folder) => ({ folder_id: folder }) }],
  // GitHub's comment triggers each watch one issue or PR (and are polled), so a repository is read through these two.
  github: [
    { slug: "GITHUB_ISSUE_ADDED_EVENT", config: ownerRepo },
    { slug: "GITHUB_PULL_REQUEST_EVENT", config: ownerRepo },
  ],
};
const KIND_OF_TRIGGER = new Map(Object.entries(TRIGGERS).flatMap(([kind, triggers]) => triggers.map((t) => [t.slug, kind as Kind] as const)));
const SENDS = new Set<string>(["gmail", "slack"]);

type RunCtx = Pick<ActionCtx, "runQuery" | "runMutation">;
type Account = { connectedAccountId: string; userId: string };

/** Opaque, stable Composio user id: a hash of the owner id, never a name or address. */
export async function composioUserId(ownerId: string): Promise<string> {
  return `tars_${(await contentHash(`tars-owner:${ownerId}`)).slice(0, 40)}`;
}

const isKind = (kind: string): kind is Kind => (KINDS as readonly string[]).includes(kind);
const accountOf = async (connection: Doc<"connections">): Promise<Account> => ({
  connectedAccountId: connection.accountKey,
  userId: await composioUserId(connection.ownerId),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProviderError("needs-retry", "unexpected_response");
  return result.data;
}

function composio(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  return providerJson(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { "x-api-key": requireEnv("COMPOSIO_API_KEY"), "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const ToolResult = z.object({ successful: z.boolean(), data: z.unknown() });

/** One tool call. Not exported: reads go through readTool, writes only through `perform`. */
async function runTool(slug: string, account: Account, args: Record<string, unknown>) {
  const body = { connected_account_id: account.connectedAccountId, user_id: account.userId, arguments: args, version: TOOL_VERSION };
  return parse(ToolResult, await composio(`/tools/execute/${slug}`, { method: "POST", body }));
}

/** A bounded read TARS may make on its own. Anything the write check calls a write is refused. */
async function readTool(slug: string, account: Account, args: Record<string, unknown>): Promise<unknown> {
  if (isWriteTool({ slug })) throw new Error(`${slug} is not a read-only tool`);
  const result = await runTool(slug, account, args);
  if (!result.successful) throw new ProviderError("needs-retry", "tool_error");
  return result.data;
}

// ---- Connect

const LinkSchema = z.object({ redirect_url: z.url(), connected_account_id: z.string().min(1) });
// shortcut: GET connected_accounts/{id} response fields are not in the docs page; user_id and toolkit.slug assumed.
const AccountSchema = z.object({ status: z.string(), user_id: z.string(), toolkit: z.object({ slug: z.string() }) });

/** Begin connecting: a Composio-hosted link bound to a single-use state row owned by the caller. */
export const startConnect = action({
  args: { sourceId: v.string(), kind: kindArg },
  returns: v.string(),
  handler: async (ctx, { sourceId, kind }): Promise<string> => {
    const { ownerId, grant } = await requireOwnedSource(ctx, sourceId, kind);
    // A trigger is built from each selector: none would read nothing, a malformed one could read the wrong thing.
    if (grant.selectors.length === 0) throw new ConvexError(`Choose at least one thing for ${NAME[kind]} to read`);
    if (kind === "github") {
      const repos = parseRepositories(grant.selectors.join(","));
      if ("error" in repos) throw new ConvexError(repos.error);
    }
    const state = randomToken();
    let link: z.infer<typeof LinkSchema>;
    try {
      link = parse(
        LinkSchema,
        await composio("/connected_accounts/link", {
          method: "POST",
          body: {
            auth_config_id: requireEnv(AUTH_CONFIG_ENV[kind]),
            user_id: await composioUserId(ownerId),
            // Composio appends status and connected_account_id to this URL when sign-in finishes.
            callback_url: `${requireEnv("CONVEX_SITE_URL")}/composio/callback?state=${state}`,
          },
        }),
      );
    } catch (error) {
      if (error instanceof ProviderError) throw new ConvexError(error.message);
      throw error;
    }
    if (new URL(link.redirect_url).origin !== CONNECT_ORIGIN) throw new ConvexError("needs-retry: unexpected_response");
    await ctx.runMutation(internal.connectors.composio.bindState, { state, ownerId, sourceId, connectedAccountId: link.connected_account_id });
    return link.redirect_url;
  },
});

export const bindState = internalMutation({
  args: { state: v.string(), ownerId: v.string(), sourceId: v.string(), connectedAccountId: v.string() },
  returns: v.null(),
  handler: async (ctx, { state, ownerId, sourceId, connectedAccountId }) => {
    await issueOAuthState(ctx, ownerId, `${STATE_PREFIX}${sourceId}:${connectedAccountId}`, state);
    return null;
  },
});

export const claimState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, { state }): Promise<{ ownerId: string; sourceId: string; connectedAccountId: string } | null> => {
    const bound = await takeOAuthState(ctx, state);
    if (bound === null || !bound.provider.startsWith(STATE_PREFIX)) return null;
    const rest = bound.provider.slice(STATE_PREFIX.length);
    const split = rest.lastIndexOf(":");
    return { ownerId: bound.ownerId, sourceId: rest.slice(0, split), connectedAccountId: rest.slice(split + 1) };
  },
});

const expired = () => oauthResultPage(400, "This link has expired or was already used. Start connecting again from the app.");

/**
 * GET /composio/callback. The owner and source come from the stored state row; the account id in the
 * query must be the one this state was issued for, and Composio must hold it ACTIVE for this owner.
 */
export const oauthCallback = httpAction(async (ctx, request) => {
  const params = new URL(request.url).searchParams;
  const claimed = await ctx.runMutation(internal.connectors.composio.claimState, { state: params.get("state") ?? "" });
  if (claimed === null || params.get("status") !== "success" || params.get("connected_account_id") !== claimed.connectedAccountId) {
    return expired();
  }
  const { ownerId, sourceId, connectedAccountId } = claimed;
  const { grant } = await ctx.runQuery(internal.connections.context, { sourceId });
  if (grant === null || grant.ownerId !== ownerId || !isKind(grant.kind)) return expired();
  const kind = grant.kind;
  const account = { connectedAccountId, userId: await composioUserId(ownerId) };
  try {
    const held = parse(AccountSchema, await composio(`/connected_accounts/${encodeURIComponent(connectedAccountId)}`));
    if (held.status !== "ACTIVE" || held.user_id !== account.userId || held.toolkit.slug !== TOOLKIT[kind]) {
      throw new ProviderError("missing-access", "account_mismatch");
    }
    await ctx.runMutation(internal.connections.save, {
      ownerId,
      sourceId,
      provider: kind,
      accountKey: connectedAccountId,
      // Composio holds the provider tokens: nothing secret is stored, only which account is ours.
      credential: await sealCredential({ connectedAccountId }),
      broker: "composio",
    });
  } catch (error) {
    if (error instanceof ProviderError || error instanceof ConvexError) {
      return oauthResultPage(400, `${NAME[kind]} could not be connected. Start connecting again from the app.`);
    }
    throw error;
  }
  try {
    await subscribe(ctx, grant, kind, account);
    await markChecked(ctx, sourceId);
  } catch (error) {
    await markFailed(ctx, sourceId, error);
    return oauthResultPage(502, `${NAME[kind]} is linked but its updates could not be turned on yet. Check its status in the app.`);
  }
  return oauthResultPage(200, `${NAME[kind]} is connected through Composio. You can return to the app.`);
});

/**
 * One trigger instance per selected channel, label or folder, pinned to this connected account. A
 * polled trigger asks for its interval (an instance field, not trigger_config); if Composio rejects
 * that, it is made without one and the connection records that it polls at Composio's default.
 */
async function subscribe(ctx: RunCtx, grant: SourceGrant, kind: Kind, account: Account): Promise<void> {
  let upgrade: "polling_interval_1" | "default_interval" | undefined;
  for (const selector of grant.selectors) {
    for (const trigger of TRIGGERS[kind] ?? []) {
      const path = `/trigger_instances/${trigger.slug}/upsert`;
      const body = { user_id: account.userId, connected_account_id: account.connectedAccountId, trigger_config: trigger.config(selector) };
      if (trigger.pollingInterval === undefined) {
        await composio(path, { method: "POST", body });
        continue;
      }
      try {
        await composio(path, { method: "POST", body: { ...body, polling_interval: trigger.pollingInterval } });
        upgrade ??= "polling_interval_1";
      } catch (error) {
        if (!(error instanceof ProviderError) || !(error.code === "http_400" || error.code === "http_422")) throw error;
        await composio(path, { method: "POST", body });
        upgrade = "default_interval";
      }
    }
  }
  if (upgrade !== undefined) await ctx.runMutation(internal.connectors.composio.setTriggerUpgrade, { sourceId: grant.id, triggerUpgrade: upgrade });
}

export const setTriggerUpgrade = internalMutation({
  args: { sourceId: v.string(), triggerUpgrade: v.union(v.literal("polling_interval_1"), v.literal("default_interval")) },
  returns: v.null(),
  handler: async (ctx, { sourceId, triggerUpgrade }) => {
    const { connection } = await loadContext(ctx, sourceId);
    if (connection !== null) await ctx.db.patch(connection._id, { triggerUpgrade });
    return null;
  },
});

/** Separate consent to send or post from this account. Composio already holds the token; this is TARS's permission. */
export const allowSend = action({
  args: { sourceId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sourceId }): Promise<null> => {
    const ownerId = await requireOwnerId(ctx);
    const { grant, connection } = await ctx.runQuery(internal.connections.context, { sourceId });
    if (grant === null || grant.ownerId !== ownerId || grant.state === "revoked" || connection?.broker !== "composio" || !SENDS.has(grant.kind)) {
      throw new ConvexError("Source is not available");
    }
    await ctx.runMutation(internal.actions.saveSendPermission, { ownerId, sourceId, provider: grant.kind, credential: connection.credential });
    return null;
  },
});

/** Scheduled once by a revoke: delete the connected account (and so its triggers) at Composio. Not retried. */
export const disconnect = internalAction({
  args: { sourceId: v.string(), grantVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, { sourceId, grantVersion }): Promise<null> => {
    const { grant, connection } = await ctx.runQuery(internal.connections.context, { sourceId });
    if (grant?.version !== grantVersion || grant.state !== "revoked" || connection?.broker !== "composio") return null;
    try {
      await composio(`/connected_accounts/${encodeURIComponent(connection.accountKey)}`, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      await ctx.runMutation(internal.connections.markCleanupFailed, { sourceId });
    }
    return null;
  },
});

// ---- Events

/** Standard Webhooks style: HMAC-SHA256 over `id.timestamp.body`, base64, fresh within five minutes. */
export async function verifyWebhook(secret: string, headers: Headers, raw: string): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp") ?? "";
  const signatures = (headers.get("webhook-signature") ?? "").split(" ").filter((s) => s !== "");
  if (!id || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  // shortcut: the docs use the secret's bytes directly as the key (no whsec_ base64 decoding); recheck with a real secret.
  for (const entry of signatures.slice(0, MAX_SIGNATURES)) {
    if (await verifyHmacSha256Base64(secret, `${id}.${timestamp}.${raw}`, entry.slice(entry.indexOf(",") + 1))) return true;
  }
  return false;
}

const EnvelopeSchema = z.object({
  type: z.string(),
  metadata: z.object({ trigger_slug: z.string(), connected_account_id: z.string(), user_id: z.string() }),
  data: z.unknown(),
  timestamp: z.iso.datetime({ offset: true }),
});
type Envelope = z.infer<typeof EnvelopeSchema>;

const ok = () => new Response(null, { status: 200 });

/** POST /composio/events. Verify, then map one event to evidence under the STORED owner and grant. */
export const handleEvent = httpAction(async (ctx, request) => {
  const raw = await request.text();
  if (!(await verifyWebhook(requireEnv("COMPOSIO_WEBHOOK_SECRET"), request.headers, raw))) {
    return new Response("invalid signature", { status: 401 });
  }
  let envelope: Envelope;
  try {
    envelope = EnvelopeSchema.parse(JSON.parse(raw));
  } catch {
    return new Response("invalid body", { status: 400 });
  }
  // Other project events (e.g. connection expiry) share this URL; only trigger messages carry items.
  const kind = envelope.type === "composio.trigger.message" ? KIND_OF_TRIGGER.get(envelope.metadata.trigger_slug) : undefined;
  if (kind === undefined) return ok();
  const found = await ctx.runQuery(internal.connections.byAccount, { provider: kind, accountKey: envelope.metadata.connected_account_id });
  const grant = found?.grant;
  const connection = found?.connection;
  if (grant == null || connection?.broker !== "composio" || grant.state !== "active" || !grant.read) return ok();
  // The payload never picks the owner: its user id must be the stored owner's, or the event is dropped.
  if (envelope.metadata.user_id !== (await composioUserId(grant.ownerId))) return ok();
  try {
    const item = await itemOf(kind, grant, await accountOf(connection), envelope);
    if (item !== null) await ingestItems(ctx, grant, [item]);
    await markChecked(ctx, grant.id, undefined, "pushed");
  } catch (error) {
    await markFailed(ctx, grant.id, error);
  }
  return ok();
});

const SlackEvent = z.object({ channel: z.string(), ts: z.string(), text: z.string().exactOptional(), subtype: z.string().exactOptional() });
const GmailEvent = z.object({
  message_id: z.string().min(1),
  label_ids: z.array(z.string()),
  sender: z.string().optional(),
  subject: z.string().optional(),
  message_text: z.string().optional(),
  message_timestamp: z.string().optional(),
});
// Issue and pull-request webhooks carry the same fields; neither names its repository, so the url does.
const GitHubEvent = z.object({
  action: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  description: z.string().nullish(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
});
// shortcut: the docs call `url` "the GitHub URL"; the web form is assumed and the API form is read too. Recheck on a live event.
const GITHUB_URL = /^https:\/\/(?:api\.)?github\.com\/(?:repos\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pulls?)\/(\d+)$/;
const OutlookEvent = z.object({ id: z.string().min(1) });
// shortcut: OUTLOOK_GET_MESSAGE's `data` is assumed to be the Graph message itself (the docs do not show it).
const OutlookMessage = z.looseObject({ id: z.string(), parentFolderId: z.string().optional() });

/** A selected item from one event, or null. Text is source content: evidence, never an instruction. */
async function itemOf(kind: Kind, grant: SourceGrant, account: Account, envelope: Envelope): Promise<ProviderItem | null> {
  if (kind === "slack") {
    const event = SlackEvent.safeParse(envelope.data);
    return event.success && grant.selectors.includes(event.data.channel) ? slackItem(event.data.channel, event.data) : null;
  }
  if (kind === "gmail") {
    const event = GmailEvent.safeParse(envelope.data);
    return event.success ? gmailItem(grant, event.data, envelope.timestamp) : null;
  }
  if (kind === "github") return githubItem(grant, envelope);
  // Outlook's trigger carries only the message id: read it, then keep it only in a selected folder.
  const event = OutlookEvent.safeParse(envelope.data);
  if (!event.success) return null;
  const message = parse(OutlookMessage, await readTool("OUTLOOK_GET_MESSAGE", account, { message_id: event.data.id }));
  return grant.selectors.includes(message.parentFolderId ?? "") ? mailItem(message as GraphMessage) : null;
}

/** A Gmail message in a selected label, pushed or fetched: the one mapping both paths use. */
function gmailItem(grant: SourceGrant, message: z.infer<typeof GmailEvent>, fallbackTime: string): ProviderItem | null {
  if (!message.label_ids.some((label) => grant.selectors.includes(label))) return null;
  const { message_id, sender, subject, message_text, message_timestamp } = message;
  return {
    externalId: message_id, // the Gmail message id, as the direct connector stores it
    version: message_id, // Gmail message content is immutable: one version per message
    text: `From: ${sender ?? ""}\nSubject: ${subject ?? ""}\n\n${(message_text ?? "").trim()}`.slice(0, MAX_TEXT),
    occurredAt: isoTime(message_timestamp, fallbackTime),
    ...mailFields(sender, subject),
  };
}

/** One issue or PR in a selected repository. Each distinct action, title and body is its own version. */
async function githubItem(grant: SourceGrant, envelope: Envelope): Promise<ProviderItem | null> {
  const event = GitHubEvent.safeParse(envelope.data);
  const match = event.success ? GITHUB_URL.exec(event.data.url) : null;
  if (!event.success || match === null) return null;
  const [, owner, name, type] = match as unknown as [string, string, string, string];
  const repo = `${owner}/${name}`.toLowerCase();
  if (!grant.selectors.some((s) => s.toLowerCase() === repo)) return null;
  const { action, createdAt, createdBy, description, number, title } = event.data;
  const pull = envelope.metadata.trigger_slug === "GITHUB_PULL_REQUEST_EVENT";
  return {
    externalId: `${repo}#${number}`,
    version: (await contentHash(`${action}\n${title}\n${description ?? ""}`)).slice(0, 32),
    text: `${pull ? "Pull request" : "Issue"} ${repo}#${number} ${action} by ${createdBy}\nTitle: ${title}\n\n${(description ?? "").trim()}`.slice(0, MAX_TEXT),
    // An opening happened when it was created; a later action (closed, synchronize) when it was delivered.
    occurredAt: action === "opened" ? isoTime(createdAt, envelope.timestamp) : envelope.timestamp,
    sourceUrl: `https://github.com/${owner}/${name}/${type === "issues" ? "issues" : "pull"}/${number}`,
  };
}

// shortcut: message_timestamp's format is not documented; ISO or epoch (s/ms) is read, else the delivery time.
function isoTime(value: string | undefined, fallback: string): string {
  const time = value !== undefined && /^\d+$/.test(value) ? Number(value) * (value.length <= 10 ? 1000 : 1) : Date.parse(value ?? "");
  return new Date(Number.isNaN(time) ? fallback : time).toISOString();
}

// ---- Mail check on an app event (window focus, return to the Mac): never on a timer.

// shortcut: GMAIL_FETCH_EMAILS's processed fields (camelCase, like GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID's) are assumed, not documented; recheck on a live read.
const FetchedMail = z.object({
  messages: z.array(
    z.object({
      messageId: z.string().min(1),
      labelIds: z.array(z.string()),
      sender: z.string().optional(),
      subject: z.string().optional(),
      messageText: z.string().optional(),
      messageTimestamp: z.string().optional(),
    }),
  ),
});

/** The owner's active Composio Gmail grants, claimed for a check unless one started under 20 seconds ago. */
export const claimMailCheck = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }): Promise<{ grant: SourceGrant; connection: Doc<"connections">; newestAt?: number }[]> => {
    const now = Date.now();
    const rows = (await ctx.db.query("connections").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).collect()).filter(
      (row) => row.provider === "gmail" && row.broker === "composio",
    );
    if (rows.some((row) => (row.mailCheckStartedAt ?? 0) > now - CHECK_DEBOUNCE_MS)) return [];
    const claimed = [];
    for (const connection of rows) {
      const { grant } = await loadContext(ctx, connection.sourceId);
      if (grant === null || grant.ownerId !== ownerId || grant.state !== "active" || !grant.read) continue;
      await ctx.db.patch(connection._id, { mailCheckStartedAt: now });
      // shortcut: reads every stored revision of this source to find the newest; add an occurredAt index if sources grow large.
      const stored = await ctx.db.query("evidence").withIndex("by_item", (q) => q.eq("ownerId", ownerId).eq("sourceId", grant.id)).collect();
      const newestAt = stored.reduce((max, row) => Math.max(max, Date.parse(row.occurredAt)), 0);
      claimed.push({ grant, connection, ...(newestAt > 0 ? { newestAt } : {}) });
    }
    return claimed;
  },
});

/**
 * Look for mail newer than the newest stored, in each selected label, and pass it through the webhook's
 * intake (duplicates dropped by id + version; automatic preparation as for a pushed message). A
 * connection made before the one-minute interval gets its triggers re-upserted once, here.
 */
async function checkOwnerMail(ctx: RunCtx, ownerId: string): Promise<void> {
  const claimed = await ctx.runMutation(internal.connectors.composio.claimMailCheck, { ownerId });
  for (const { grant, connection, newestAt } of claimed) {
    const account = await accountOf(connection);
    if (connection.triggerUpgrade === undefined) {
      try {
        await subscribe(ctx, grant, "gmail", account);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error; // no marker stored: tried again on the next event
      }
    }
    try {
      const items: ProviderItem[] = [];
      for (const label of grant.selectors) {
        const args = { label_ids: [label], max_results: MAX_FETCH, verbose: true, ...(newestAt === undefined ? {} : { query: `after:${Math.floor(newestAt / 1000)}` }) };
        const { messages } = parse(FetchedMail, await readTool("GMAIL_FETCH_EMAILS", account, args));
        const fetchedAt = new Date().toISOString();
        for (const m of messages) {
          const item = gmailItem(
            grant,
            { message_id: m.messageId, label_ids: m.labelIds, sender: m.sender, subject: m.subject, message_text: m.messageText, message_timestamp: m.messageTimestamp },
            fetchedAt,
          );
          if (item !== null) items.push(item);
        }
      }
      await ingestItems(ctx, grant, items.slice(0, MAX_FETCH));
      await markChecked(ctx, grant.id, undefined, "opened");
    } catch (error) {
      await markFailed(ctx, grant.id, error);
    }
  }
}

/** The app window gained focus or became visible: check the caller's Composio Gmail now. */
export const checkMail = action({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    await checkOwnerMail(ctx, await requireOwnerId(ctx));
    return null;
  },
});

/** Scheduled once by briefs.handleReturn (OS resume or unlock), for the owner that mutation verified. */
export const checkMailFor = internalAction({
  args: { ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId }): Promise<null> => {
    await checkOwnerMail(ctx, ownerId);
    return null;
  },
});

// ---- Writes: called only by actions.ts for a reserved, running action.

const GmailSent = z.object({ id: z.string().min(1) });
// shortcut: GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID's processed fields (labelIds, messageText) are assumed, not documented.
const GmailMessage = z.object({ labelIds: z.array(z.string()), messageText: z.string() });
const SlackPosted = z.object({ ok: z.literal(true), channel: z.string().min(1), ts: z.string().min(1) });
const SlackHistory = z.object({ messages: z.array(z.object({ ts: z.string(), text: z.string().optional() })) });

/** The effect for one reserved action. A tool that ran but reported an error may have delivered: unknown. */
export async function perform(ctx: RunCtx, row: Doc<"actions">, onSent?: () => Promise<void>): Promise<EffectOutcome> {
  const { connection } = await ctx.runQuery(internal.connections.context, { sourceId: row.sourceId });
  if (connection?.broker !== "composio") return { state: "failed", reason: "not_connected" }; // nothing was sent
  if (row.provider !== "composio-gmail" && row.provider !== "composio-slack") return { state: "failed", reason: "unsupported" };
  const account = await accountOf(connection);
  const gmail = row.provider === "composio-gmail";
  let result: z.infer<typeof ToolResult>;
  try {
    result = gmail
      ? await runTool("GMAIL_SEND_EMAIL", account, { recipient_email: row.destination, subject: row.subject ?? mailSubject(row.body), body: row.body })
      : // shortcut: `text` is Slack's deprecated plain field; it keeps the stored text equal to what was approved.
        await runTool("SLACK_CHAT_POST_MESSAGE", account, { channel: row.destination, text: row.body });
  } catch (error) {
    if (error instanceof ProviderError) return { state: outcomeForFailure(error.code), reason: error.code };
    throw error;
  }
  if (!result.successful) return { state: "unknown", reason: "tool_error" };
  await onSent?.();
  if (gmail) {
    const sent = GmailSent.safeParse(result.data);
    return sent.success ? readBack(account, row, sent.data.id) : { state: "unknown", reason: "no_message_id" };
  }
  const posted = SlackPosted.safeParse(result.data);
  return posted.success ? readBack(account, row, `${posted.data.channel}:${posted.data.ts}`) : { state: "unknown", reason: "no_message_id" };
}

/** An unknown outcome looked up again by the id the send returned. Without one it stays unknown; never resent. */
export async function lookup(ctx: RunCtx, row: Doc<"actions">): Promise<EffectOutcome> {
  const { connection } = await ctx.runQuery(internal.connections.context, { sourceId: row.sourceId });
  if (connection?.broker !== "composio") return { state: "unknown", reason: "not_connected" };
  if (row.externalId === undefined) return { state: "unknown", reason: "no_provider_id" };
  return readBack(await accountOf(connection), row, row.externalId);
}

/** Only a read-back of the approved text at the returned id is "succeeded". */
async function readBack(account: Account, row: Doc<"actions">, externalId: string): Promise<EffectOutcome> {
  const unverified: EffectOutcome = { state: "unknown", externalId, reason: "not_read_back" };
  try {
    if (row.provider === "composio-gmail") {
      const message = GmailMessage.safeParse(await readTool("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", account, { message_id: externalId, format: "full" }));
      const matches = message.success && message.data.labelIds.includes("SENT") && sameContent(message.data.messageText, row.body);
      return matches ? { state: "succeeded", externalId } : { ...unverified, reason: "read_back_mismatch" };
    }
    const split = externalId.lastIndexOf(":");
    const [channel, ts] = [externalId.slice(0, split), externalId.slice(split + 1)];
    const history = SlackHistory.safeParse(
      await readTool("SLACK_FETCH_CONVERSATION_HISTORY", account, { channel, oldest: ts, latest: ts, inclusive: true, limit: 1 }),
    );
    const message = history.success ? history.data.messages.find((m) => m.ts === ts) : undefined;
    return message !== undefined && sameContent(message.text ?? "", row.body) ? { state: "succeeded", externalId } : { ...unverified, reason: "read_back_mismatch" };
  } catch (error) {
    if (error instanceof ProviderError) return unverified;
    throw error;
  }
}
