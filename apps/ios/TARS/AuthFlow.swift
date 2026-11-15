import CryptoKit
import Foundation

// Auth0 Native sign-in (RFC 8252), the same tenant and client as the Mac app: authorization code + PKCE,
// state and nonce checked. Pure parts only; the session and network live in Auth0Provider.

let redirectURI = "tars://callback"
let callbackScheme = "tars"
private let scope = "openid profile email offline_access"
/// Renew a minute early so a token never expires between handing it out and Convex checking it.
private let renewalMargin: TimeInterval = 60

struct AuthConfig: Equatable { let domain: String; let clientId: String }

enum AuthError: Error, Equatable, LocalizedError {
  case notConfigured
  case provider(String)
  case rejected(String)
  case signedOut

  var errorDescription: String? {
    switch self {
    case .notConfigured: "Sign-in is not configured in this build."
    case let .provider(reason): "Sign-in failed: \(reason)"
    case let .rejected(reason): "Sign-in rejected: \(reason)"
    case .signedOut: "Signed out."
    }
  }
}

private func base64URL(_ data: some DataProtocol) -> String {
  Data(data).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

enum PKCE {
  static func challenge(for verifier: String) -> String { base64URL(Array(SHA256.hash(data: Data(verifier.utf8)))) }
}

/// 256 random bits, base64url (43 characters): verifier, state and nonce.
func randomToken() -> String {
  var bytes = [UInt8](repeating: 0, count: 32)
  precondition(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess, "no system randomness")
  return base64URL(bytes)
}

func authorizeURL(_ config: AuthConfig, state: String, nonce: String, challenge: String) -> URL {
  var components = URLComponents()
  components.scheme = "https"
  components.host = config.domain
  components.path = "/authorize"
  components.queryItems = [
    URLQueryItem(name: "response_type", value: "code"),
    URLQueryItem(name: "client_id", value: config.clientId),
    URLQueryItem(name: "redirect_uri", value: redirectURI),
    URLQueryItem(name: "scope", value: scope),
    URLQueryItem(name: "state", value: state),
    URLQueryItem(name: "nonce", value: nonce),
    URLQueryItem(name: "code_challenge", value: challenge),
    URLQueryItem(name: "code_challenge_method", value: "S256"),
  ]
  return components.url!
}

/// The authorization code from the callback. Throws on a provider error, a state mismatch or a missing code.
func parseCallback(_ url: URL, expectedState: String) throws -> String {
  let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
  let param = { (name: String) in items.first { $0.name == name }?.value }
  if let error = param("error") {
    throw AuthError.provider(param("error_description").map { "\(error) (\($0))" } ?? error)
  }
  guard param("state") == expectedState else { throw AuthError.rejected("state mismatch") }
  guard let code = param("code"), !code.isEmpty else { throw AuthError.rejected("no authorization code") }
  return code
}

private struct Claims: Decodable {
  enum Audience: Decodable {
    case one(String), many([String])
    init(from decoder: Decoder) throws {
      let c = try decoder.singleValueContainer()
      if let one = try? c.decode(String.self) { self = .one(one) } else { self = .many(try c.decode([String].self)) }
    }
    var all: [String] { switch self { case let .one(a): [a]; case let .many(a): a } }
  }
  let iss: String
  let aud: Audience
  let azp: String?
  let sub: String
  let nonce: String?
  let exp: TimeInterval
}

/// Checks issuer, audience, nonce (nil for a refresh, which carries none) and expiry; returns the expiry
/// (seconds since epoch). The token comes straight from the token endpoint over TLS (OIDC Core 3.1.3.7), so
/// the signature is not re-verified here; Convex verifies every token against the issuer's JWKS.
func validateIdToken(_ token: String, config: AuthConfig, nonce: String?, now: TimeInterval) throws -> TimeInterval {
  let parts = token.split(separator: ".", omittingEmptySubsequences: false)
  var payload = parts.count == 3 ? String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") : ""
  payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
  guard let data = Data(base64Encoded: payload), let claims = try? JSONDecoder().decode(Claims.self, from: data), !claims.sub.isEmpty else {
    throw AuthError.rejected("malformed ID token")
  }
  guard claims.iss == "https://\(config.domain)/" else { throw AuthError.rejected("wrong issuer") }
  let audiences = claims.aud.all
  guard audiences.contains(config.clientId) else { throw AuthError.rejected("wrong audience") }
  if audiences.count > 1, claims.azp != config.clientId { throw AuthError.rejected("wrong azp") }
  if let nonce, claims.nonce != nonce { throw AuthError.rejected("nonce mismatch") }
  guard claims.exp > now else { throw AuthError.rejected("ID token expired") }
  return claims.exp
}

func needsRenewal(expiresAt: TimeInterval, now: TimeInterval) -> Bool { now >= expiresAt - renewalMargin }

func renewalDate(expiresAt: TimeInterval) -> Date { Date(timeIntervalSince1970: expiresAt - renewalMargin) }
