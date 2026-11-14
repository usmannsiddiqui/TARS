// Auth0 Native sign-in (RFC 8252): authorization code + PKCE through the system browser,
// fixed loopback redirect, state + nonce validation. Main process only; no Electron import so
// the pure parts are unit-testable. Live sign-in against a real tenant is UNVERIFIED.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { OwnerIdSchema, type OwnerId } from "@companion/domain";

export const LOOPBACK_PORT = 51735;
export const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;
const SCOPE = "openid profile email offline_access";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
// Renew a minute early so a token never expires between handing it out and the cloud checking it.
const REFRESH_MARGIN_SEC = 60;

export class AuthError extends Error {
  override name = "AuthError";
}

export type AuthConfig = { domain: string; clientId: string };

/** Reads AUTH0_DOMAIN / AUTH0_CLIENT_ID; null when sign-in is not configured. */
export function authConfigFromEnv(env: NodeJS.ProcessEnv): AuthConfig | null {
  const domain = env["AUTH0_DOMAIN"];
  const clientId = env["AUTH0_CLIENT_ID"];
  if (!domain || !clientId) return null;
  if (!/^[a-z0-9.-]+$/i.test(domain)) throw new AuthError("AUTH0_DOMAIN must be a bare hostname");
  return { domain, clientId };
}

const randomToken = () => randomBytes(32).toString("base64url");

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(); // 43 chars of base64url = 256 bits
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function buildAuthorizeUrl(
  config: AuthConfig,
  params: { state: string; nonce: string; challenge: string },
): string {
  const url = new URL(`https://${config.domain}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Validates the loopback callback. Throws on provider error, state mismatch or missing code. */
export function parseCallback(callbackUrl: string, expectedState: string): { code: string } {
  const params = new URL(callbackUrl).searchParams;
  const error = params.get("error");
  if (error) {
    const description = params.get("error_description");
    throw new AuthError(`Sign-in failed: ${error}${description ? ` (${description})` : ""}`);
  }
  if (params.get("state") !== expectedState) throw new AuthError("Sign-in rejected: state mismatch");
  const code = params.get("code");
  if (!code) throw new AuthError("Sign-in failed: no authorization code");
  return { code };
}

const IdTokenClaimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  azp: z.string().optional(),
  sub: z.string().min(1),
  nonce: z.string().optional(),
  exp: z.number(),
});

/**
 * Checks issuer, audience, nonce (null for a refresh, which carries none) and expiry.
 * The owner is `${iss}|${sub}`: exactly how Convex builds UserIdentity.tokenIdentifier, so
 * local and cloud records name the same owner. The token comes straight from the token endpoint
 * over TLS (OIDC Core 3.1.3.7), so the JWT signature is not re-verified here; Convex verifies
 * tokens independently against the issuer's JWKS on every call.
 */
export function validateIdTokenClaims(
  idToken: string,
  expected: AuthConfig & { nonce: string | null; nowSec: number },
): { ownerId: OwnerId; expiresAt: number } {
  const payload = idToken.split(".")[1];
  let claims: z.infer<typeof IdTokenClaimsSchema>;
  try {
    claims = IdTokenClaimsSchema.parse(JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")));
  } catch {
    throw new AuthError("Sign-in rejected: malformed ID token");
  }
  if (claims.iss !== `https://${expected.domain}/`) throw new AuthError("Sign-in rejected: wrong issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.clientId)) throw new AuthError("Sign-in rejected: wrong audience");
  if (audiences.length > 1 && claims.azp !== expected.clientId) throw new AuthError("Sign-in rejected: wrong azp");
  if (expected.nonce !== null && claims.nonce !== expected.nonce) throw new AuthError("Sign-in rejected: nonce mismatch");
  if (claims.exp <= expected.nowSec) throw new AuthError("Sign-in rejected: ID token expired");
  return { ownerId: OwnerIdSchema.parse(`${claims.iss}|${claims.sub}`), expiresAt: claims.exp };
}

const TokenResponseSchema = z.object({
  id_token: z.string(),
  access_token: z.string(),
  refresh_token: z.string().optional(),
});

const SessionSchema = z.object({
  ownerId: OwnerIdSchema,
  idToken: z.string(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number(),
});
type Session = z.infer<typeof SessionSchema>;

/** Secret persistence; in the app this is a file encrypted with Electron safeStorage. */
export type SecretVault = { read(): Promise<string | null>; write(value: string): Promise<void> };

export type AuthDeps = {
  config: AuthConfig | null;
  openExternal(url: string): Promise<void>;
  vault: SecretVault;
};

/** Waits for exactly one GET /callback on the fixed loopback port, then closes the listener. */
function awaitLoopbackCallback(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== "GET" || !req.url?.startsWith("/callback")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'" });
      res.end("<!doctype html><title>TARS</title><p>You can close this tab and return to TARS.</p>");
      clearTimeout(timer);
      server.close();
      resolve(`http://127.0.0.1:${LOOPBACK_PORT}${req.url}`);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new AuthError("Sign-in timed out"));
    }, SIGN_IN_TIMEOUT_MS);
    server.once("error", (err) => {
      clearTimeout(timer);
      reject(new AuthError(`Sign-in could not listen on ${REDIRECT_URI}: ${err.message}`));
    });
    server.listen(LOOPBACK_PORT, "127.0.0.1");
  });
}

async function requestTokens(config: AuthConfig, params: Record<string, string>): Promise<z.infer<typeof TokenResponseSchema>> {
  const response = await fetch(`https://${config.domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const err = z.object({ error: z.string(), error_description: z.string().optional() }).safeParse(body);
    throw new AuthError(
      err.success ? `Sign-in failed: ${err.data.error}` : `Sign-in failed: token endpoint returned ${response.status}`,
    );
  }
  return TokenResponseSchema.parse(body);
}

export function createAuth(deps: AuthDeps) {
  let session: Session | null = null;

  /** Validates and persists a token response; a refresh must name the same owner and may rotate the refresh token. */
  async function save(
    config: AuthConfig,
    tokens: z.infer<typeof TokenResponseSchema>,
    nonce: string | null,
    previous: Session | undefined,
  ): Promise<Session> {
    const { ownerId, expiresAt } = validateIdTokenClaims(tokens.id_token, {
      ...config,
      nonce,
      nowSec: Math.floor(Date.now() / 1000),
    });
    if (previous && previous.ownerId !== ownerId) throw new AuthError("Refresh rejected: token is for a different owner");
    const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
    const next: Session = {
      ownerId,
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt,
    };
    await deps.vault.write(JSON.stringify(next));
    session = next;
    return next;
  }

  return {
    /** Loads a previously signed-in session from OS-protected storage. */
    async restore(): Promise<void> {
      const raw = await deps.vault.read();
      session = raw ? SessionSchema.parse(JSON.parse(raw)) : null;
    },

    /** Owner of the signed-in session, or null. Never invented. */
    currentOwner(): OwnerId | null {
      return session?.ownerId ?? null;
    },

    async signIn(): Promise<void> {
      const config = deps.config;
      if (!config) throw new AuthError("Sign-in is not configured (set AUTH0_DOMAIN and AUTH0_CLIENT_ID)");
      const state = randomToken();
      const nonce = randomToken();
      const pkce = createPkcePair();

      const callback = awaitLoopbackCallback();
      await deps.openExternal(buildAuthorizeUrl(config, { state, nonce, challenge: pkce.challenge }));
      const { code } = parseCallback(await callback, state);

      const tokens = await requestTokens(config, {
        grant_type: "authorization_code",
        client_id: config.clientId,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: REDIRECT_URI,
      });
      await save(config, tokens, nonce, undefined);
    },

    /**
     * The short-lived ID token the Convex client authenticates with; refreshed here when it is
     * expiring or the cloud rejected it. The refresh token itself never leaves the main process.
     */
    async idToken(forceRefresh: boolean): Promise<string | null> {
      if (!session) return null;
      if (!forceRefresh && session.expiresAt - REFRESH_MARGIN_SEC > Math.floor(Date.now() / 1000)) return session.idToken;
      const config = deps.config;
      if (!config || !session.refreshToken) return null; // expired with no way to renew: sign in again
      const tokens = await requestTokens(config, {
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: session.refreshToken,
      });
      return (await save(config, tokens, null, session)).idToken;
    },
  };
}
