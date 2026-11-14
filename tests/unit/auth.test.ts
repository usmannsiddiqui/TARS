import { describe, expect, it } from "vitest";
import {
  AuthError,
  buildAuthorizeUrl,
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
      ownerId: "auth0|alice",
      expiresAt: nowSec + 60,
    });
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
