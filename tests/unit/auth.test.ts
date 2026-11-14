import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  buildAuthorizeUrl,
  createAuth,
  createPkcePair,
  parseCallback,
  pkceChallenge,
  REDIRECT_URI,
  validateIdTokenClaims,
} from "../../apps/desktop/src/main/auth";

const config = { domain: "tenant.example.auth0.com", clientId: "client-123" };
const issuer = "https://tenant.example.auth0.com/";

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const idToken = (claims: object) => `${b64url({ alg: "RS256" })}.${b64url(claims)}.signature`;
const nowSec = 1_800_000_000;
const goodClaims = { iss: issuer, aud: config.clientId, sub: "auth0|alice", nonce: "n-1", exp: nowSec + 60 };

describe("auth (pure parts; live Auth0 sign-in unverified)", () => {
  it("computes the S256 PKCE challenge from the RFC 7636 Appendix B vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates a fresh high-entropy verifier whose challenge matches", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(pkceChallenge(a.verifier));
  });

  it("builds an authorization-code + PKCE request to the fixed loopback redirect", () => {
    const url = new URL(buildAuthorizeUrl(config, { state: "s-1", nonce: "n-1", challenge: "c-1" }));
    expect(url.origin + url.pathname).toBe("https://tenant.example.auth0.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-123",
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email offline_access",
      state: "s-1",
      nonce: "n-1",
      code_challenge: "c-1",
      code_challenge_method: "S256",
    });
    expect(REDIRECT_URI).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("returns the code when state matches", () => {
    expect(parseCallback(`${REDIRECT_URI}?code=abc&state=s-1`, "s-1")).toEqual({ code: "abc" });
  });

  it("rejects a callback whose state does not match", () => {
    expect(() => parseCallback(`${REDIRECT_URI}?code=abc&state=attacker`, "s-1")).toThrow(AuthError);
    expect(() => parseCallback(`${REDIRECT_URI}?code=abc`, "s-1")).toThrow(/state/i);
  });

  it("surfaces an error callback from the provider", () => {
    expect(() =>
      parseCallback(`${REDIRECT_URI}?error=access_denied&error_description=User%20cancelled&state=s-1`, "s-1"),
    ).toThrow("Sign-in failed: access_denied (User cancelled)");
  });

  it("accepts ID token claims with matching issuer, audience, nonce and expiry", () => {
    expect(validateIdTokenClaims(idToken(goodClaims), { ...config, nonce: "n-1", nowSec })).toEqual({
      ownerId: `${issuer}|auth0|alice`,
      expiresAt: nowSec + 60,
    });
  });

  it("owner_id_matches_convex_token_identifier", () => {
    // Convex derives UserIdentity.tokenIdentifier as `${iss}|${sub}`; the local owner must be that exact string
    // or every cloud call would be denied as another owner.
    const { ownerId } = validateIdTokenClaims(idToken(goodClaims), { ...config, nonce: "n-1", nowSec });
    expect(ownerId).toBe(`${goodClaims.iss}|${goodClaims.sub}`);
    expect(ownerId).toBe("https://tenant.example.auth0.com/|auth0|alice");
  });

  it("rejects an ID token whose nonce does not match", () => {
    expect(() =>
      validateIdTokenClaims(idToken({ ...goodClaims, nonce: "replayed" }), { ...config, nonce: "n-1", nowSec }),
    ).toThrow(/nonce/i);
  });

  it("rejects ID tokens with the wrong issuer, audience, or an expired exp", () => {
    const opts = { ...config, nonce: "n-1", nowSec };
    expect(() => validateIdTokenClaims(idToken({ ...goodClaims, iss: "https://evil.example/" }), opts)).toThrow(AuthError);
    expect(() => validateIdTokenClaims(idToken({ ...goodClaims, aud: "other" }), opts)).toThrow(AuthError);
    expect(() => validateIdTokenClaims(idToken({ ...goodClaims, exp: nowSec - 1 }), opts)).toThrow(AuthError);
    expect(() => validateIdTokenClaims("not-a-jwt", opts)).toThrow(AuthError);
  });
});

describe("ID token for the cloud client", () => {
  afterEach(() => vi.unstubAllGlobals());

  const memoryVault = (initial: object | null) => {
    let value = initial ? JSON.stringify(initial) : null;
    return { read: async () => value, write: async (next: string) => void (value = next), current: () => value };
  };
  const session = (expiresAt: number) => ({
    ownerId: `${issuer}|auth0|alice`,
    idToken: "old-id-token",
    accessToken: "old-access",
    refreshToken: "refresh-secret",
    expiresAt,
  });
  const futureSec = () => Math.floor(Date.now() / 1000) + 3600;

  it("returns the current ID token without a network call while it is fresh", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const auth = createAuth({ config, openExternal: async () => {}, vault: memoryVault(session(futureSec())) });
    await auth.restore();
    expect(await auth.idToken(false)).toBe("old-id-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes an expired ID token in the main process and never returns the refresh token", async () => {
    const fresh = idToken({ iss: issuer, aud: config.clientId, sub: "auth0|alice", exp: futureSec() });
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: "refresh-secret",
      });
      return new Response(JSON.stringify({ id_token: fresh, access_token: "new-access" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const vault = memoryVault(session(1));
    const auth = createAuth({ config, openExternal: async () => {}, vault });
    await auth.restore();

    expect(await auth.idToken(false)).toBe(fresh);
    expect(fetchSpy).toHaveBeenCalledWith("https://tenant.example.auth0.com/oauth/token", expect.anything());
    // The rotated session keeps the refresh token in the vault only.
    expect(JSON.parse(vault.current() ?? "{}")).toMatchObject({ idToken: fresh, refreshToken: "refresh-secret" });
    expect(auth.currentOwner()).toBe(`${issuer}|auth0|alice`);
  });

  it("refuses a refreshed token for a different owner", async () => {
    const other = idToken({ iss: issuer, aud: config.clientId, sub: "auth0|mallory", exp: futureSec() });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id_token: other, access_token: "x" }), { status: 200 }));
    const auth = createAuth({ config, openExternal: async () => {}, vault: memoryVault(session(1)) });
    await auth.restore();
    await expect(auth.idToken(true)).rejects.toThrow(/owner/i);
  });

  it("returns null when signed out", async () => {
    const auth = createAuth({ config, openExternal: async () => {}, vault: memoryVault(null) });
    await auth.restore();
    expect(await auth.idToken(false)).toBeNull();
  });
});
