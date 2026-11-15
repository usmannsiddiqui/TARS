import XCTest
@testable import TARS

final class AuthTests: XCTestCase {
  let config = AuthConfig(domain: "tenant.example.auth0.com", clientId: "client-123")

  // Expected value from the desktop's pkceChallenge (Node: sha256, base64url) for the same verifier.
  func testPkceChallengeMatchesDesktop() {
    XCTAssertEqual(PKCE.challenge(for: "dBjftJeZ4CVP-mJ92K1QqK8vnb6mh5RG-J0bHQkA7Gw"), "Mk6jn9oKK-jdVjf8QXa02TtfFyS-nmXTDNKhlkhqDoA")
    XCTAssertEqual(randomToken().count, 43)
  }

  func testAuthorizeUrlCarriesPkceStateNonceAndScheme() throws {
    let url = authorizeURL(config, state: "s1", nonce: "n1", challenge: "c1")
    let items = Dictionary(uniqueKeysWithValues: try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems).map { ($0.name, $0.value ?? "") })
    XCTAssertEqual(url.host, "tenant.example.auth0.com")
    XCTAssertEqual(url.path, "/authorize")
    XCTAssertEqual(items["response_type"], "code")
    XCTAssertEqual(items["client_id"], "client-123")
    XCTAssertEqual(items["redirect_uri"], "tars://callback")
    XCTAssertEqual(items["state"], "s1")
    XCTAssertEqual(items["nonce"], "n1")
    XCTAssertEqual(items["code_challenge"], "c1")
    XCTAssertEqual(items["code_challenge_method"], "S256")
    XCTAssertEqual(items["scope"], "openid profile email offline_access")
  }

  func testCallbackReturnsCodeWhenStateMatches() throws {
    XCTAssertEqual(try parseCallback(URL(string: "tars://callback?code=abc&state=s1")!, expectedState: "s1"), "abc")
  }

  func testCallbackRejectsStateMismatch() {
    XCTAssertThrowsError(try parseCallback(URL(string: "tars://callback?code=abc&state=other")!, expectedState: "s1")) {
      XCTAssertEqual($0 as? AuthError, .rejected("state mismatch"))
    }
  }

  func testCallbackSurfacesProviderError() {
    let url = URL(string: "tars://callback?error=access_denied&error_description=User%20cancelled&state=s1")!
    XCTAssertThrowsError(try parseCallback(url, expectedState: "s1")) {
      XCTAssertEqual($0 as? AuthError, .provider("access_denied (User cancelled)"))
    }
  }

  func testCallbackWithoutCodeFails() {
    XCTAssertThrowsError(try parseCallback(URL(string: "tars://callback?state=s1")!, expectedState: "s1")) {
      XCTAssertEqual($0 as? AuthError, .rejected("no authorization code"))
    }
  }

  func testIdTokenAcceptedReturnsExpiry() throws {
    let token = idToken(["iss": "https://tenant.example.auth0.com/", "aud": "client-123", "sub": "auth0|1", "nonce": "n1", "exp": 2_000])
    XCTAssertEqual(try validateIdToken(token, config: config, nonce: "n1", now: 1_000), 2_000)
  }

  func testIdTokenRejectsNonceMismatch() {
    let token = idToken(["iss": "https://tenant.example.auth0.com/", "aud": "client-123", "sub": "auth0|1", "nonce": "evil", "exp": 2_000])
    XCTAssertThrowsError(try validateIdToken(token, config: config, nonce: "n1", now: 1_000)) {
      XCTAssertEqual($0 as? AuthError, .rejected("nonce mismatch"))
    }
  }

  func testRefreshedIdTokenNeedsNoNonce() throws {
    let token = idToken(["iss": "https://tenant.example.auth0.com/", "aud": ["client-123", "other"], "azp": "client-123", "sub": "auth0|1", "exp": 2_000])
    XCTAssertEqual(try validateIdToken(token, config: config, nonce: nil, now: 1_000), 2_000)
  }

  func testIdTokenRejectsWrongIssuerAudienceAndExpiry() {
    let base: [String: Any] = ["iss": "https://tenant.example.auth0.com/", "aud": "client-123", "sub": "auth0|1", "exp": 2_000]
    var wrongIss = base; wrongIss["iss"] = "https://evil.example.com/"
    var wrongAud = base; wrongAud["aud"] = "someone-else"
    XCTAssertThrowsError(try validateIdToken(idToken(wrongIss), config: config, nonce: nil, now: 1_000)) { XCTAssertEqual($0 as? AuthError, .rejected("wrong issuer")) }
    XCTAssertThrowsError(try validateIdToken(idToken(wrongAud), config: config, nonce: nil, now: 1_000)) { XCTAssertEqual($0 as? AuthError, .rejected("wrong audience")) }
    XCTAssertThrowsError(try validateIdToken(idToken(base), config: config, nonce: nil, now: 2_000)) { XCTAssertEqual($0 as? AuthError, .rejected("ID token expired")) }
    XCTAssertThrowsError(try validateIdToken("not-a-jwt", config: config, nonce: nil, now: 1_000)) { XCTAssertEqual($0 as? AuthError, .rejected("malformed ID token")) }
  }

  func testTokenIsRenewedOneMinuteBeforeExpiry() {
    XCTAssertFalse(needsRenewal(expiresAt: 1_000, now: 939))
    XCTAssertTrue(needsRenewal(expiresAt: 1_000, now: 940))
    XCTAssertTrue(needsRenewal(expiresAt: 1_000, now: 1_500))
    XCTAssertEqual(renewalDate(expiresAt: 1_000), Date(timeIntervalSince1970: 940))
  }

  private func idToken(_ claims: [String: Any]) -> String {
    let payload = try! JSONSerialization.data(withJSONObject: claims)
    let b64 = payload.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    return "eyJhbGciOiJSUzI1NiJ9.\(b64).signature"
  }
}
