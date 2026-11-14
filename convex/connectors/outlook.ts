// Outlook mail and calendar through Microsoft Graph. OAuth (Mail.Read or Calendars.Read) →
// Graph subscriptions with a secret clientState → notifications carry only resource ids →
// fetch the one changed selected item. Lifecycle notifications set a visible status.
// Deliveries are routed by `?source=<sourceId>` in the notification URL; the lease is the only
// scheduled job and it reads no content.
import { ConvexError, v } from "convex/values";
import type { SourceGrant } from "../../packages/domain/src/types";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { action, type ActionCtx, httpAction, internalAction, internalMutation, mutation } from "../_generated/server";
import { ingestItems, markChecked, markFailed, requireOwnedSource, type ProviderItem } from "../connections";
import { requireOwnerId } from "../lib/auth";
import {
  issueOAuthState,
  keepLease,
  oauthResultPage,
  oauthToken,
  openCredential,
  ProviderError,
  providerJson,
  randomToken,
  renewalSuperseded,
  requireEnv,
  sealCredential,
  takeOAuthState,
} from "../lib/providerAuth";

const GRAPH = "https://graph.microsoft.com/v1.0";
const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const KINDS = ["outlook-mail", "outlook-calendar"] as const;
type Kind = (typeof KINDS)[number];
const SCOPES: Record<Kind, string> = {
  "outlook-mail": "offline_access Mail.Read",
  "outlook-calendar": "offline_access Calendars.Read",
};
const LEASE_MS = 10_000 * 60 * 1000; // Graph's Outlook maximum is 10,080 minutes
const MAX_ITEMS = 20; // per selected folder or calendar on a bounded read
const CALENDAR_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_TEXT = 4000;
const MAIL_SELECT = "$select=subject,from,receivedDateTime,body,webLink";
const EVENT_SELECT = "$select=subject,start,end,isCancelled,lastModifiedDateTime,webLink";
const TEXT_BODY = { prefer: 'outlook.body-content-type="text"' };

type Secrets = { refreshToken: string; clientState: string; subscriptions: string };
type GraphMessage = {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  body?: { content?: string };
  webLink?: string;
};
type DateTimeZone = { dateTime?: string; timeZone?: string };
type GraphEvent = {
  id: string;
  subject?: string;
  start?: DateTimeZone;
  end?: DateTimeZone;
  isCancelled?: boolean;
  lastModifiedDateTime?: string;
  webLink?: string;
  calendar?: { id?: string };
};
type Notification = {
  subscriptionId?: string;
  clientState?: string;
  lifecycleEvent?: string;
  resourceData?: { id?: unknown };
};
type RunCtx = Pick<ActionCtx, "runQuery" | "runMutation">;

const isKind = (value: string): value is Kind => (KINDS as readonly string[]).includes(value);
const redirectUri = () => `${requireEnv("CONVEX_SITE_URL")}/oauth/microsoft/callback`;
const notificationUrl = (sourceId: string) =>
  `${requireEnv("CONVEX_SITE_URL")}/outlook/notifications?source=${encodeURIComponent(sourceId)}`;
const active = (grant: SourceGrant) => grant.state === "active" && grant.read;
const httpsUrl = (url: string | undefined) => (url?.startsWith("https://") ? { sourceUrl: url } : {});

function graph(path: string, token: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return providerJson(`${GRAPH}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

export const storeCredential = internalMutation({
  args: { sourceId: v.string(), credential: v.string() },
  returns: v.null(),
  handler: async (ctx, { sourceId, credential }) => {
    const row = await ctx.db
      .query("connections")
      .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
      .unique();
    if (row !== null) await ctx.db.patch(row._id, { credential });
    return null;
  },
});

/** A fresh access token. Microsoft rotates refresh tokens; the new one replaces the old. */
async function accessToken(ctx: RunCtx, sourceId: string, kind: Kind, secrets: Secrets): Promise<string> {
  const tokens = await oauthToken(`${AUTHORITY}/token`, {
    grant_type: "refresh_token",
    refresh_token: secrets.refreshToken,
    scope: SCOPES[kind],
    client_id: requireEnv("MICROSOFT_CLIENT_ID"),
    client_secret: requireEnv("MICROSOFT_CLIENT_SECRET"),
  });
  if (tokens.refresh_token !== undefined && tokens.refresh_token !== secrets.refreshToken) {
    secrets.refreshToken = tokens.refresh_token;
    await ctx.runMutation(internal.connectors.outlook.storeCredential, { sourceId, credential: await sealCredential(secrets) });
  }
  return tokens.access_token;
}

// ---- Item mapping

function mailItem(message: GraphMessage): ProviderItem | null {
  if (message.receivedDateTime === undefined || Number.isNaN(Date.parse(message.receivedDateTime))) return null;
  const from = message.from?.emailAddress;
  const sender = from === undefined ? "" : `${from.name ?? ""} <${from.address ?? ""}>`.trim();
  const text = `From: ${sender}\nSubject: ${message.subject ?? ""}\n\n${(message.body?.content ?? "").trim()}`;
  return {
    externalId: message.id,
    version: message.receivedDateTime, // received mail does not change
    text: text.slice(0, MAX_TEXT),
    occurredAt: new Date(message.receivedDateTime).toISOString(),
    ...httpsUrl(message.webLink),
  };
}

/** Start/end kept verbatim with Graph's time zone name; cancellation is part of the text. */
function eventItem(event: GraphEvent): ProviderItem | null {
  if (event.lastModifiedDateTime === undefined || Number.isNaN(Date.parse(event.lastModifiedDateTime))) return null;
  const when = (value: DateTimeZone | undefined) => `${value?.dateTime ?? "unknown"} ${value?.timeZone ?? ""}`.trim();
  const lines = [
    `Meeting: ${event.subject ?? ""}${event.isCancelled === true ? " (cancelled)" : ""}`,
    `Start: ${when(event.start)}`,
    `End: ${when(event.end)}`,
  ];
  return {
    externalId: event.id,
    version: event.lastModifiedDateTime,
    text: lines.join("\n"),
    occurredAt: new Date(event.lastModifiedDateTime).toISOString(),
    ...httpsUrl(event.webLink),
  };
}

/** Bounded selected read (connect, repair, Refresh): newest mail per folder, or the next 14 days per calendar. */
async function readSelected(ctx: RunCtx, grant: SourceGrant, kind: Kind, token: string): Promise<void> {
  const items: ProviderItem[] = [];
  for (const selector of grant.selectors) {
    const id = encodeURIComponent(selector);
    if (kind === "outlook-mail") {
      const page = (await graph(
        `/me/mailFolders/${id}/messages?$top=${MAX_ITEMS}&$orderby=receivedDateTime desc&${MAIL_SELECT}`,
        token,
        { headers: TEXT_BODY },
      )) as { value?: GraphMessage[] };
      for (const message of page.value ?? []) items.push(...[mailItem(message)].filter((i) => i !== null));
    } else {
      const start = new Date().toISOString();
      const end = new Date(Date.now() + CALENDAR_WINDOW_MS).toISOString();
      const page = (await graph(
        `/me/calendars/${id}/calendarView?startDateTime=${start}&endDateTime=${end}&$top=${MAX_ITEMS}&${EVENT_SELECT}`,
        token,
      )) as { value?: GraphEvent[] };
      for (const event of page.value ?? []) items.push(...[eventItem(event)].filter((i) => i !== null));
    }
  }
  await ingestItems(ctx, grant, items);
  await markChecked(ctx, grant.id);
}

/** The one changed item, only if it is still in a selected folder/calendar. A vanished item is skipped. */
async function fetchChanged(grant: SourceGrant, kind: Kind, folder: string, id: string, token: string) {
  try {
    if (kind === "outlook-mail") {
      if (!grant.selectors.includes(folder)) return null; // selection rechecked after delivery
      const message = (await graph(`/me/messages/${encodeURIComponent(id)}?${MAIL_SELECT}`, token, {
        headers: TEXT_BODY,
      })) as GraphMessage;
      return mailItem(message);
    }
    const event = (await graph(
      `/me/events/${encodeURIComponent(id)}?${EVENT_SELECT}&$expand=calendar($select=id)`,
      token,
    )) as GraphEvent;
    return grant.selectors.includes(event.calendar?.id ?? "") ? eventItem(event) : null;
  } catch (error) {
    if (error instanceof ProviderError && error.code === "http_404") return null;
    throw error;
  }
}

// ---- Subscriptions

/** Graph offers events only mailbox-wide (`me/events`); calendars are filtered after fetch. */
async function subscribe(sourceId: string, kind: Kind, selector: string, clientState: string, token: string) {
  const resource = kind === "outlook-mail" ? `me/mailFolders('${selector.replace(/'/g, "''")}')/messages` : "me/events";
  const created = (await graph("/subscriptions", token, {
    method: "POST",
    body: {
      changeType: kind === "outlook-mail" ? "created" : "created,updated",
      notificationUrl: notificationUrl(sourceId),
      lifecycleNotificationUrl: notificationUrl(sourceId),
      resource,
      expirationDateTime: new Date(Date.now() + LEASE_MS).toISOString(),
      clientState,
    },
  })) as { id?: string; expirationDateTime?: string };
  const expiresAt = Date.parse(created.expirationDateTime ?? "");
  if (typeof created.id !== "string" || Number.isNaN(expiresAt)) throw new ProviderError("needs-retry", "unexpected_response");
  return { id: created.id, expiresAt };
}

// ---- OAuth

/** Begin connecting: returns Microsoft's consent URL for the system browser. */
export const startConnect = mutation({
  args: { sourceId: v.string() },
  returns: v.string(),
  handler: async (ctx, { sourceId }) => {
    const ownerId = await requireOwnerId(ctx);
    const grant = await ctx.db
      .query("grants")
      .withIndex("by_source", (q) => q.eq("id", sourceId))
      .unique();
    if (grant === null || grant.ownerId !== ownerId || !isKind(grant.kind)) throw new ConvexError("Source is not available");
    const url = new URL(`${AUTHORITY}/authorize`);
    url.search = new URLSearchParams({
      client_id: requireEnv("MICROSOFT_CLIENT_ID"),
      response_type: "code",
      redirect_uri: redirectUri(),
      response_mode: "query",
      scope: SCOPES[grant.kind],
      state: await issueOAuthState(ctx, ownerId, `${grant.kind}:${sourceId}`),
    }).toString();
    return url.toString();
  },
});

export const claimState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, { state }): Promise<{ ownerId: string; kind: Kind; sourceId: string } | null> => {
    const bound = await takeOAuthState(ctx, state);
    const split = bound?.provider.indexOf(":") ?? -1;
    if (bound === null || split < 0) return null;
    const kind = bound.provider.slice(0, split);
    return isKind(kind) ? { ownerId: bound.ownerId, kind, sourceId: bound.provider.slice(split + 1) } : null;
  },
});

/** GET /oauth/microsoft/callback — the owner comes from the stored state row, never the request. */
export const oauthCallback = httpAction(async (ctx, request) => {
  const params = new URL(request.url).searchParams;
  const claimed = await ctx.runMutation(internal.connectors.outlook.claimState, { state: params.get("state") ?? "" });
  const code = params.get("code");
  if (claimed === null || code === null) {
    return oauthResultPage(400, "This link has expired or was already used. Start connecting again from the app.");
  }
  const { ownerId, kind, sourceId } = claimed;
  try {
    const tokens = await oauthToken(`${AUTHORITY}/token`, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      scope: SCOPES[kind],
      client_id: requireEnv("MICROSOFT_CLIENT_ID"),
      client_secret: requireEnv("MICROSOFT_CLIENT_SECRET"),
    });
    if (tokens.refresh_token === undefined) throw new ProviderError("missing-access", "no_refresh_token");
    const me = (await graph("/me?$select=id", tokens.access_token)) as { id?: string };
    if (typeof me.id !== "string") throw new ProviderError("needs-retry", "unexpected_response");
    const previous = (await ctx.runQuery(internal.connections.context, { sourceId })).connection;

    const secrets: Secrets = { refreshToken: tokens.refresh_token, clientState: randomToken(), subscriptions: "{}" };
    await ctx.runMutation(internal.connections.save, {
      ownerId,
      sourceId,
      provider: kind,
      accountKey: me.id,
      credential: await sealCredential(secrets),
    });
    const { grant } = await ctx.runQuery(internal.connections.context, { sourceId });
    try {
      if (previous?.provider === kind) await unsubscribe(previous, tokens.access_token); // Graph rejects duplicates
      const subscriptions: Record<string, string> = {};
      let expiresAt = Infinity;
      for (const selector of kind === "outlook-mail" ? grant!.selectors : ["*"]) {
        const created = await subscribe(sourceId, kind, selector, secrets.clientState, tokens.access_token);
        subscriptions[created.id] = selector;
        expiresAt = Math.min(expiresAt, created.expiresAt);
      }
      secrets.subscriptions = JSON.stringify(subscriptions);
      await ctx.runMutation(internal.connectors.outlook.storeCredential, { sourceId, credential: await sealCredential(secrets) });
      if (Number.isFinite(expiresAt)) await keepLease(ctx, internal.connectors.outlook.renewLease, grant!, expiresAt);
      await readSelected(ctx, grant!, kind, tokens.access_token);
    } catch (error) {
      await markFailed(ctx, sourceId, error);
      return oauthResultPage(502, "Outlook is linked but could not be read yet. Check its status in the app.");
    }
    return oauthResultPage(200, "Outlook is connected. You can return to the app.");
  } catch (error) {
    if (error instanceof ProviderError || error instanceof ConvexError) {
      return oauthResultPage(400, "Outlook could not be connected. Start connecting again from the app.");
    }
    throw error;
  }
});

/** Best effort: old subscriptions that are already gone are fine. */
async function unsubscribe(connection: Doc<"connections">, token: string): Promise<void> {
  const old = JSON.parse((await openCredential(connection.credential)).subscriptions ?? "{}") as Record<string, string>;
  for (const id of Object.keys(old)) {
    try {
      await graph(`/subscriptions/${encodeURIComponent(id)}`, token, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
    }
  }
}

// ---- Notifications

const status = (code: number) => new Response(null, { status: code });

/** POST /outlook/notifications?source=<sourceId> — change and lifecycle notifications alike. */
export const handleNotification = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  // Subscription handshake: echo the decoded token as plain text, before any other work.
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken !== null) {
    return new Response(validationToken, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const sourceId = url.searchParams.get("source");
  if (sourceId === null) return status(404);
  const { grant, connection } = await ctx.runQuery(internal.connections.context, { sourceId });
  if (grant === null || connection === null || !isKind(connection.provider)) return status(404);
  const kind = connection.provider;

  let notes: Notification[];
  try {
    const body = (await request.json()) as { value?: unknown };
    notes = Array.isArray(body.value) ? (body.value as Notification[]) : [];
  } catch {
    return status(400);
  }
  const secrets = (await openCredential(connection.credential)) as Secrets;
  // clientState is the secret only Graph and we know; a mismatch is not from our subscription.
  if (notes.length === 0 || notes.some((note) => note.clientState !== secrets.clientState)) return status(401);
  if (!active(grant)) return status(202);

  const subscriptions = JSON.parse(secrets.subscriptions) as Record<string, string>;
  const ours = notes.filter((note) => subscriptions[note.subscriptionId ?? ""] !== undefined);
  const changes = ours.filter((note) => note.lifecycleEvent === undefined && typeof note.resourceData?.id === "string");
  let token: string | undefined;
  const getToken = async () => (token ??= await accessToken(ctx, sourceId, kind, secrets));
  try {
    for (const note of ours.filter((n) => n.lifecycleEvent !== undefined)) {
      const id = note.subscriptionId!;
      if (note.lifecycleEvent === "missed") {
        await ctx.runMutation(internal.connections.setStatus, { sourceId, availability: "stale", lastError: "notifications_missed" });
      } else if (note.lifecycleEvent === "reauthorizationRequired") {
        await graph(`/subscriptions/${encodeURIComponent(id)}/reauthorize`, await getToken(), { method: "POST" });
      } else if (note.lifecycleEvent === "subscriptionRemoved") {
        const created = await subscribe(sourceId, kind, subscriptions[id]!, secrets.clientState, await getToken());
        subscriptions[created.id] = subscriptions[id]!;
        delete subscriptions[id];
        secrets.subscriptions = JSON.stringify(subscriptions);
        await ctx.runMutation(internal.connectors.outlook.storeCredential, { sourceId, credential: await sealCredential(secrets) });
        // Changes made while it was gone were not delivered.
        await ctx.runMutation(internal.connections.setStatus, { sourceId, availability: "stale", lastError: "subscription_removed" });
      }
    }
    if (changes.length > 0) {
      if (connection.availability !== "connected") {
        await readSelected(ctx, grant, kind, await getToken()); // this event repairs a stale source
      } else {
        const items: ProviderItem[] = [];
        for (const note of changes) {
          const item = await fetchChanged(grant, kind, subscriptions[note.subscriptionId!]!, note.resourceData!.id as string, await getToken());
          if (item !== null) items.push(item);
        }
        await ingestItems(ctx, grant, items);
        await markChecked(ctx, sourceId);
      }
    }
    return status(202);
  } catch (error) {
    const failure = await markFailed(ctx, sourceId, error);
    // 503 asks Graph to redeliver (its own backoff, up to 4 h); missing access will not fix itself.
    return status(failure.availability === "needs-retry" ? 503 : 202);
  }
});

// ---- User Refresh and lease renewal

/** User-triggered only: one bounded read of the selected folders or calendars. */
export const refresh = action({
  args: { sourceId: v.string(), kind: v.union(v.literal("outlook-mail"), v.literal("outlook-calendar")) },
  returns: v.null(),
  handler: async (ctx, { sourceId, kind }): Promise<null> => {
    const { grant, connection } = await requireOwnedSource(ctx, sourceId, kind);
    if (connection === null) throw new ConvexError("Source is not connected");
    try {
      const secrets = (await openCredential(connection.credential)) as Secrets;
      await readSelected(ctx, grant, kind, await accessToken(ctx, sourceId, kind, secrets));
    } catch (error) {
      throw new ConvexError((await markFailed(ctx, sourceId, error)).message);
    }
    return null;
  },
});

/** Extends each Graph subscription a day before it lapses. Revalidates the grant; reads no content. */
export const renewLease = internalAction({
  args: { sourceId: v.string(), grantVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, { sourceId, grantVersion }): Promise<null> => {
    const { grant, connection } = await ctx.runQuery(internal.connections.context, { sourceId });
    if (grant === null || connection === null || !isKind(connection.provider)) return null;
    if (grant.version !== grantVersion || !active(grant)) return null; // revoked or changed: stop the chain
    if (renewalSuperseded(connection.subscriptionExpiresAt)) return null;
    try {
      const secrets = (await openCredential(connection.credential)) as Secrets;
      const token = await accessToken(ctx, sourceId, connection.provider, secrets);
      let expiresAt = Infinity;
      for (const id of Object.keys(JSON.parse(secrets.subscriptions) as Record<string, string>)) {
        const renewed = (await graph(`/subscriptions/${encodeURIComponent(id)}`, token, {
          method: "PATCH",
          body: { expirationDateTime: new Date(Date.now() + LEASE_MS).toISOString() },
        })) as { expirationDateTime?: string };
        const at = Date.parse(renewed.expirationDateTime ?? "");
        if (Number.isNaN(at)) throw new ProviderError("needs-retry", "unexpected_response");
        expiresAt = Math.min(expiresAt, at);
      }
      if (Number.isFinite(expiresAt)) await keepLease(ctx, internal.connectors.outlook.renewLease, grant, expiresAt);
    } catch (error) {
      await markFailed(ctx, sourceId, error); // visible; reconnect re-creates the subscriptions
    }
    return null;
  },
});
