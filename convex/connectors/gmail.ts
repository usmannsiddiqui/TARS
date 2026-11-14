// Gmail: OAuth (gmail.readonly) → users.watch on the selected labels → authenticated Pub/Sub
// push carrying only {emailAddress, historyId} → history.list from the stored cursor → bounded
// read of the selected messages. The watch lease is the only scheduled job; it reads no mail.
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
  renewalSuperseded,
  requireEnv,
  sealCredential,
  takeOAuthState,
} from "../lib/providerAuth";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"; // Google's OIDC signing keys (JWKS)
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const MAX_MESSAGES = 20; // per push, and per label on a repair read
const HISTORY_PAGE = 100;
const MAX_TEXT = 4000;
const HISTORY_ID = /^\d+$/;
const STATE_PREFIX = "gmail:";

type Header = { name?: string; value?: string };
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Header[] };
type GmailMessage = { id: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: Part };
type HistoryRecord = { id: string; messagesAdded?: { message?: GmailMessage }[]; labelsAdded?: { message?: GmailMessage }[] };
type RunCtx = Pick<ActionCtx, "runQuery" | "runMutation">;

const redirectUri = () => `${requireEnv("CONVEX_SITE_URL")}/oauth/google/callback`;
const active = (grant: SourceGrant) => grant.state === "active" && grant.read;
const selected = (grant: SourceGrant, labelIds: string[] | undefined) =>
  (labelIds ?? []).some((label) => grant.selectors.includes(label));

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
const base64UrlText = (value: string) => new TextDecoder().decode(base64UrlBytes(value));

function gmailGet(path: string, token: string): Promise<unknown> {
  return providerJson(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

async function accessToken(connection: Doc<"connections">): Promise<string> {
  const { refreshToken } = await openCredential(connection.credential);
  const tokens = await oauthToken(TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken!,
    client_id: requireEnv("GOOGLE_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
  });
  return tokens.access_token;
}

// ---- Message mapping

function plainText(part: Part | undefined): string | undefined {
  if (part === undefined) return undefined;
  if (part.mimeType === "text/plain" && part.body?.data !== undefined) return base64UrlText(part.body.data);
  for (const child of part.parts ?? []) {
    const text = plainText(child);
    if (text !== undefined) return text;
  }
  return undefined;
}

/** One selected message as a provider item; gone or unselected messages are skipped. */
async function fetchMessage(grant: SourceGrant, token: string, id: string): Promise<ProviderItem | null> {
  let message: GmailMessage;
  try {
    message = (await gmailGet(`/messages/${encodeURIComponent(id)}?format=full`, token)) as GmailMessage;
  } catch (error) {
    if (error instanceof ProviderError && error.code === "http_404") return null; // deleted since the change
    throw error;
  }
  if (!selected(grant, message.labelIds) || !HISTORY_ID.test(message.internalDate ?? "")) return null;
  const header = (name: string) =>
    message.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
  const body = plainText(message.payload) ?? message.snippet ?? "";
  const text = `From: ${header("From")}\nSubject: ${header("Subject")}\n\n${body.trim()}`.slice(0, MAX_TEXT);
  // Gmail message content is immutable, so internalDate is a stable version: label changes never duplicate.
  return {
    externalId: message.id,
    version: message.internalDate!,
    text,
    occurredAt: new Date(Number(message.internalDate)).toISOString(),
  };
}

async function ingestMessages(ctx: RunCtx, grant: SourceGrant, token: string, ids: Iterable<string>) {
  const items: ProviderItem[] = [];
  for (const id of ids) {
    const item = await fetchMessage(grant, token, id);
    if (item !== null) items.push(item);
  }
  await ingestItems(ctx, grant, items);
}

/** Bounded selected read (connect, repair, Refresh): newest messages per selected label, then cursor. */
async function readLabels(ctx: RunCtx, grant: SourceGrant, token: string, cursor: string): Promise<void> {
  const ids = new Set<string>();
  for (const label of grant.selectors) {
    const page = (await gmailGet(
      `/messages?labelIds=${encodeURIComponent(label)}&maxResults=${MAX_MESSAGES}`,
      token,
    )) as { messages?: { id: string }[] };
    for (const message of page.messages ?? []) ids.add(message.id);
  }
  await ingestMessages(ctx, grant, token, ids);
  await markChecked(ctx, grant.id, cursor);
}

/** Changes since the cursor. An expired cursor (404) is stale and is NOT answered with a full read. */
async function readHistory(ctx: RunCtx, grant: SourceGrant, token: string, cursor: string): Promise<void> {
  const params = `startHistoryId=${cursor}&historyTypes=messageAdded&historyTypes=labelAdded&maxResults=${HISTORY_PAGE}`;
  let page: { history?: HistoryRecord[]; historyId?: string; nextPageToken?: string };
  try {
    page = (await gmailGet(`/history?${params}`, token)) as typeof page;
  } catch (error) {
    if (!(error instanceof ProviderError && error.code === "http_404")) throw error;
    await ctx.runMutation(internal.connections.setStatus, {
      sourceId: grant.id,
      availability: "stale",
      lastError: "history_expired",
    });
    return;
  }
  const ids = new Set<string>();
  let processed = cursor;
  let complete = true;
  for (const record of page.history ?? []) {
    if (ids.size >= MAX_MESSAGES) {
      complete = false; // the next push continues from `processed`
      break;
    }
    for (const entry of [...(record.messagesAdded ?? []), ...(record.labelsAdded ?? [])]) {
      if (entry.message !== undefined && selected(grant, entry.message.labelIds)) ids.add(entry.message.id);
    }
    processed = record.id;
  }
  await ingestMessages(ctx, grant, token, ids);
  const next = complete && page.nextPageToken === undefined && page.historyId !== undefined ? page.historyId : processed;
  await markChecked(ctx, grant.id, next);
}

async function startWatch(grant: SourceGrant, token: string): Promise<{ historyId: string; expiration: number }> {
  const body = (await providerJson(`${API}/watch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      topicName: requireEnv("GMAIL_PUBSUB_TOPIC"),
      labelIds: grant.selectors,
      labelFilterBehavior: "INCLUDE",
    }),
  })) as { historyId?: string; expiration?: string };
  if (!HISTORY_ID.test(body.historyId ?? "") || !/^\d+$/.test(body.expiration ?? "")) {
    throw new ProviderError("needs-retry", "unexpected_response");
  }
  return { historyId: body.historyId!, expiration: Number(body.expiration) };
}

// ---- OAuth

/** Begin connecting: returns Google's consent URL for the system browser. */
export const startConnect = mutation({
  args: { sourceId: v.string() },
  returns: v.string(),
  handler: async (ctx, { sourceId }) => {
    const ownerId = await requireOwnerId(ctx);
    const grant = await ctx.db
      .query("grants")
      .withIndex("by_source", (q) => q.eq("id", sourceId))
      .unique();
    if (grant === null || grant.ownerId !== ownerId || grant.kind !== "gmail") {
      throw new ConvexError("Source is not available");
    }
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPE,
      access_type: "offline", // a refresh token, so pushes can be read later
      prompt: "consent",
      state: await issueOAuthState(ctx, ownerId, `${STATE_PREFIX}${sourceId}`),
    }).toString();
    return url.toString();
  },
});

export const claimState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, { state }): Promise<{ ownerId: string; sourceId: string } | null> => {
    const bound = await takeOAuthState(ctx, state);
    if (bound === null || !bound.provider.startsWith(STATE_PREFIX)) return null;
    return { ownerId: bound.ownerId, sourceId: bound.provider.slice(STATE_PREFIX.length) };
  },
});

/** GET /oauth/google/callback — the owner comes from the stored state row, never the request. */
export const oauthCallback = httpAction(async (ctx, request) => {
  const params = new URL(request.url).searchParams;
  const claimed = await ctx.runMutation(internal.connectors.gmail.claimState, { state: params.get("state") ?? "" });
  const code = params.get("code");
  if (claimed === null || code === null) {
    return oauthResultPage(400, "This link has expired or was already used. Start connecting again from the app.");
  }
  const { ownerId, sourceId } = claimed;
  try {
    const tokens = await oauthToken(TOKEN_URL, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
    });
    if (tokens.refresh_token === undefined) throw new ProviderError("missing-access", "no_refresh_token");
    const profile = (await gmailGet("/profile", tokens.access_token)) as { emailAddress?: string };
    if (typeof profile.emailAddress !== "string") throw new ProviderError("needs-retry", "unexpected_response");
    await ctx.runMutation(internal.connections.save, {
      ownerId,
      sourceId,
      provider: "gmail",
      accountKey: profile.emailAddress.toLowerCase(), // pushes name the mailbox by address
      credential: await sealCredential({ refreshToken: tokens.refresh_token }),
    });
    const { grant } = await ctx.runQuery(internal.connections.context, { sourceId });
    try {
      const watch = await startWatch(grant!, tokens.access_token);
      await keepLease(ctx, internal.connectors.gmail.renewLease, grant!, watch.expiration);
      await readLabels(ctx, grant!, tokens.access_token, watch.historyId);
    } catch (error) {
      await markFailed(ctx, sourceId, error);
      return oauthResultPage(502, "Gmail is linked but could not be read yet. Check its status in the app.");
    }
    return oauthResultPage(200, "Gmail is connected. You can return to the app.");
  } catch (error) {
    if (error instanceof ProviderError || error instanceof ConvexError) {
      return oauthResultPage(400, "Gmail could not be connected. Start connecting again from the app.");
    }
    throw error;
  }
});

// ---- Push

/** Pub/Sub's OIDC token: RS256 signature by Google's JWKS, issuer, audience, push account, expiry. */
async function verifyPushToken(authorization: string | null): Promise<boolean> {
  const audience = `${requireEnv("CONVEX_SITE_URL")}/gmail/push`;
  const account = requireEnv("GMAIL_PUSH_SERVICE_ACCOUNT");
  const match = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(authorization ?? "");
  if (match === null) return false;
  let header: { alg?: string; kid?: string };
  let claims: { iss?: string; aud?: string; email?: string; email_verified?: boolean; exp?: number };
  try {
    header = JSON.parse(base64UrlText(match[1]!));
    claims = JSON.parse(base64UrlText(match[2]!));
  } catch {
    return false;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return false;
  const certs = (await providerJson(CERTS_URL)) as {
    keys?: { kid?: string; kty?: string; n?: string; e?: string; alg?: string; use?: string }[];
  };
  const jwk = certs.keys?.find((key) => key.kid === header.kid);
  if (jwk === undefined) return false;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const signed = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlBytes(match[3]!),
    new TextEncoder().encode(`${match[1]}.${match[2]}`),
  );
  return (
    signed &&
    ISSUERS.has(claims.iss ?? "") &&
    claims.aud === audience &&
    claims.email === account &&
    claims.email_verified === true &&
    typeof claims.exp === "number" &&
    claims.exp > Date.now() / 1000
  );
}

const status = (code: number) => new Response(null, { status: code });

/** POST /gmail/push. Any 2xx acks the Pub/Sub message; 503 asks Pub/Sub to redeliver (its backoff). */
export const handlePush = httpAction(async (ctx, request) => {
  try {
    if (!(await verifyPushToken(request.headers.get("authorization")))) return status(401);
  } catch (error) {
    if (error instanceof ProviderError) return status(503); // could not fetch Google's keys
    throw error;
  }
  let note: { emailAddress?: unknown; historyId?: unknown };
  try {
    const body = (await request.json()) as { message?: { data?: string } };
    note = JSON.parse(base64UrlText(body.message?.data ?? ""));
  } catch {
    return status(400);
  }
  const historyId = String(note.historyId);
  if (typeof note.emailAddress !== "string" || !HISTORY_ID.test(historyId)) return status(400);

  const found = await ctx.runQuery(internal.connections.byAccount, {
    provider: "gmail",
    accountKey: note.emailAddress.toLowerCase(),
  });
  if (found?.grant == null || found.connection === null || !active(found.grant)) return status(200);
  const { grant, connection } = found;
  try {
    const token = await accessToken(connection);
    // A stale or missing cursor is repaired by this event with one bounded selected read.
    if (connection.availability === "stale" || connection.cursor === undefined) {
      await readLabels(ctx, grant, token, historyId);
    } else {
      await readHistory(ctx, grant, token, connection.cursor);
    }
    return status(200);
  } catch (error) {
    const failure = await markFailed(ctx, grant.id, error);
    return status(failure.availability === "needs-retry" ? 503 : 200);
  }
});

// ---- User Refresh and lease renewal

/** User-triggered only: one bounded read of the selected labels; repairs a stale cursor. */
export const refresh = action({
  args: { sourceId: v.string() },
  returns: v.null(),
  handler: async (ctx, { sourceId }): Promise<null> => {
    const { grant, connection } = await requireOwnedSource(ctx, sourceId, "gmail");
    if (connection === null) throw new ConvexError("Source is not connected");
    try {
      const token = await accessToken(connection);
      // Cursor taken before the list, so nothing that arrives during the read is skipped.
      const profile = (await gmailGet("/profile", token)) as { historyId?: string };
      if (!HISTORY_ID.test(profile.historyId ?? "")) throw new ProviderError("needs-retry", "unexpected_response");
      await readLabels(ctx, grant, token, profile.historyId!);
    } catch (error) {
      throw new ConvexError((await markFailed(ctx, sourceId, error)).message);
    }
    return null;
  },
});

/** Re-arms users.watch a day before it lapses. Revalidates the grant; never reads mail. */
export const renewLease = internalAction({
  args: { sourceId: v.string(), grantVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, { sourceId, grantVersion }): Promise<null> => {
    const { grant, connection } = await ctx.runQuery(internal.connections.context, { sourceId });
    if (grant === null || connection === null || connection.provider !== "gmail") return null;
    if (grant.version !== grantVersion || !active(grant)) return null; // revoked or changed: stop the chain
    if (renewalSuperseded(connection.subscriptionExpiresAt)) return null;
    try {
      const watch = await startWatch(grant, await accessToken(connection));
      // The watch's historyId is ignored: replacing the cursor would skip unread history.
      await keepLease(ctx, internal.connectors.gmail.renewLease, grant, watch.expiration);
    } catch (error) {
      await markFailed(ctx, sourceId, error); // visible; reconnect re-arms it
    }
    return null;
  },
});
