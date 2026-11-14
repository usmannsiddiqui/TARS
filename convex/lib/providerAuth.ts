// Shared connector seam: sealed credentials, webhook HMAC checks, OAuth state, and
// provider-failure classification. Plain helpers; registered functions live in connections.ts.
import type { MutationCtx } from "../_generated/server";
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
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const state = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await ctx.db.insert("oauthStates", { state, ownerId, provider, expiresAt: Date.now() + STATE_TTL_MS });
  return state;
}

/** True once for a matching, unexpired state. Any presentation burns it, so a stolen value fails too. */
export async function consumeOAuthState(
  ctx: MutationCtx,
  { state, ownerId, provider }: { state: string; ownerId: string; provider: string },
): Promise<boolean> {
  const row = await ctx.db
    .query("oauthStates")
    .withIndex("by_state", (q) => q.eq("state", state))
    .unique();
  if (row === null) return false;
  await ctx.db.delete(row._id);
  return row.ownerId === ownerId && row.provider === provider && row.expiresAt > Date.now();
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
  if (!response.ok) throw new ProviderError(availabilityForStatus(response.status), `http_${response.status}`);
  return response.json();
}
