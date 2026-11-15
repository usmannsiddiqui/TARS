// Shared connector seam: sealed credentials, webhook HMAC checks, OAuth state, and
// provider-failure classification. Plain helpers; registered functions live in connections.ts.
import type { FunctionReference } from "convex/server";
import type { SourceGrant } from "../../packages/domain/src/types";
import { internal } from "../_generated/api";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { decryptSecret, encryptSecret } from "./crypto";

export type Availability = "connected" | "stale" | "missing-access" | "needs-retry";

// ---- Credentials: encrypt in an action before storing, decrypt only inside internal code.
export async function sealCredential(secrets: Record<string, string>): Promise<string> {
  return encryptSecret(JSON.stringify(secrets));
}

export async function openCredential(sealed: string): Promise<Record<string, string>> {
  return JSON.parse(await decryptSecret(sealed)) as Record<string, string>;
}

// ---- Webhook signatures.
/** Constant-time check of a hex HMAC-SHA256 (subtle.verify does not leak timing). */
export async function verifyHmacSha256Hex(secret: string, message: string, hex: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(message));
}

// ---- OAuth state: random, single-use, expiring, bound to owner and provider.
const STATE_TTL_MS = 10 * 60 * 1000;

export async function issueOAuthState(ctx: MutationCtx, ownerId: string, provider: string): Promise<string> {
  const state = randomToken();
  await ctx.db.insert("oauthStates", { state, ownerId, provider, expiresAt: Date.now() + STATE_TTL_MS });
  return state;
}

/**
 * Burn the state and return what it was bound to, or null if unknown or expired. For a
 * provider redirect, which arrives unauthenticated: the owner comes from this row only.
 */
export async function takeOAuthState(
  ctx: MutationCtx,
  state: string,
): Promise<{ ownerId: string; provider: string } | null> {
  const row = await ctx.db
    .query("oauthStates")
    .withIndex("by_state", (q) => q.eq("state", state))
    .unique();
  if (row === null) return null;
  await ctx.db.delete(row._id);
  return row.expiresAt > Date.now() ? { ownerId: row.ownerId, provider: row.provider } : null;
}

/** True once for a matching, unexpired state. Any presentation burns it, so a stolen value fails too. */
export async function consumeOAuthState(
  ctx: MutationCtx,
  { state, ownerId, provider }: { state: string; ownerId: string; provider: string },
): Promise<boolean> {
  const bound = await takeOAuthState(ctx, state);
  return bound !== null && bound.ownerId === ownerId && bound.provider === provider;
}

/** Plain page shown in the browser after a provider redirect. */
export function oauthResultPage(status: number, message: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>Connection</title><p>${message}</p>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

type TokenResponse = { access_token: string; refresh_token?: string };

/** OAuth token endpoint call (code exchange or refresh). A rejected grant is missing access, not a retry. */
export async function oauthToken(url: string, params: Record<string, string>): Promise<TokenResponse> {
  let body: Partial<TokenResponse>;
  try {
    body = (await providerJson(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    })) as Partial<TokenResponse>;
  } catch (error) {
    // 400 invalid_grant: revoked consent or a used/expired code; retrying cannot fix it.
    if (error instanceof ProviderError && error.code === "http_400") throw new ProviderError("missing-access", "token_rejected");
    throw error;
  }
  if (typeof body.access_token !== "string") throw new ProviderError("needs-retry", "token_response");
  return body as TokenResponse;
}

/** Deployment env var read at request time, so a missing value fails only that request. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- Subscription leases: the one scheduled job. It renews a lease, never reads content.
export const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

/** Record the lease expiry (status unchanged) and schedule exactly one renewal a day before it. */
export async function keepLease(
  ctx: ActionCtx,
  renew: FunctionReference<"action", "internal", { sourceId: string; grantVersion: number }>,
  grant: SourceGrant,
  expiresAt: number,
): Promise<void> {
  const { connection } = await ctx.runQuery(internal.connections.context, { sourceId: grant.id });
  if (connection === null) return;
  await ctx.runMutation(internal.connections.setStatus, {
    sourceId: grant.id,
    availability: connection.availability,
    ...(connection.lastError === undefined ? {} : { lastError: connection.lastError }),
    subscriptionExpiresAt: expiresAt,
  });
  await ctx.scheduler.runAt(expiresAt - RENEW_BEFORE_MS, renew, { sourceId: grant.id, grantVersion: grant.version });
}

/** A renewal fired by an older chain (a reconnect moved the lease later) has nothing to do. */
export function renewalSuperseded(subscriptionExpiresAt: number | undefined): boolean {
  return subscriptionExpiresAt !== undefined && subscriptionExpiresAt - Date.now() > RENEW_BEFORE_MS + 60_000;
}

// ---- Provider calls: one bounded request, failures become a visible status (never a retry timer).
const FETCH_TIMEOUT_MS = 10_000;

export class ProviderError extends Error {
  constructor(
    readonly availability: Availability,
    readonly code: string, // short code for lastError, never provider content
  ) {
    super(`${availability}: ${code}`);
  }
}

export function availabilityForStatus(status: number): Availability {
  return status === 401 || status === 403 || status === 404 ? "missing-access" : "needs-retry";
}

/** GET/POST JSON with a timeout. Non-2xx and timeouts throw ProviderError. */
export async function providerJson(url: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new ProviderError("needs-retry", timedOut ? "timeout" : "network");
  }
  if (!response.ok) throw new ProviderError(availabilityForStatus(response.status), failureCode(response));
  // 204, and Graph's 202 from message send, carry no body.
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A parse error message quotes the body; only the code leaves here. A 2xx did happen: see outcomeForFailure.
    throw new ProviderError("needs-retry", "unexpected_response");
  }
}

/**
 * Short code for a non-2xx. Kept from the response: a Retry-After in seconds (shown, never acted on
 * by a timer) and the scope an RFC 6750 insufficient_scope challenge names. Nothing else.
 */
function failureCode(response: Response): string {
  const retryAfter = response.headers.get("retry-after") ?? "";
  if (response.status === 429 && /^\d+$/.test(retryAfter)) return `http_429_retry_after_${retryAfter}s`;
  const challenge = response.headers.get("www-authenticate") ?? "";
  const scope = /error="insufficient_scope"/.test(challenge) ? /scope="([^"]+)"/.exec(challenge)?.[1] : undefined;
  if (response.status === 403 && scope !== undefined) return `missing_scope:${scope}`;
  return `http_${response.status}`;
}
