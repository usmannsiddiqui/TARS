import AuthenticationServices
import ConvexMobile
import Foundation

/// Signs in through Auth0 in a private browser sheet, keeps the session in the Keychain and hands Convex the
/// ID token, renewing it with the refresh token a minute before it expires. Convex derives the owner from the
/// verified token; this app never names one.
actor Auth0Provider: AuthProvider {
  private let config: AuthConfig
  private var session: Session?
  private var refreshing: Task<Session, Error>?
  private var renewal: Task<Void, Never>?
  private var onIdToken: (@Sendable (String?) -> Void)?

  init(config: AuthConfig) { self.config = config }

  func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> Session {
    let state = randomToken(), nonce = randomToken(), verifier = randomToken()
    let url = authorizeURL(config, state: state, nonce: nonce, challenge: PKCE.challenge(for: verifier))
    let code = try parseCallback(try await WebSignIn().run(url), expectedState: state)
    let tokens = try await requestTokens([
      "grant_type": "authorization_code", "client_id": config.clientId, "code": code, "code_verifier": verifier, "redirect_uri": redirectURI,
    ])
    let next = try save(tokens, nonce: nonce, previous: nil)
    started(next, onIdToken)
    return next
  }

  /// Also what the Convex client calls on every reconnect, so a stale token is renewed here.
  func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> Session {
    guard let current = session ?? Keychain.read() else { throw AuthError.signedOut }
    session = current
    let next = needsRenewal(expiresAt: current.expiresAt, now: Date().timeIntervalSince1970) ? try await refresh() : current
    started(next, onIdToken)
    return next
  }

  func logout() async throws {
    renewal?.cancel()
    let refreshToken = session?.refreshToken ?? Keychain.read()?.refreshToken
    session = nil
    onIdToken = nil
    Keychain.clear()
    if let refreshToken { await revoke(refreshToken) }
  }

  nonisolated func extractIdToken(from authResult: Session) -> String { authResult.idToken }

  /// The app came back to the foreground: renew now if the scheduled renewal could not run.
  func renewIfDue() async {
    guard let current = session, needsRenewal(expiresAt: current.expiresAt, now: Date().timeIntervalSince1970) else { return }
    await renewNow()
  }

  // ---- Internals.

  private func started(_ next: Session, _ callback: @Sendable @escaping (String?) -> Void) {
    onIdToken = callback
    schedule(next)
  }

  /// One renewal at the token's own deadline (not a poll): sleeps until a minute before expiry, then refreshes.
  private func schedule(_ next: Session) {
    renewal?.cancel()
    let delay = max(0, renewalDate(expiresAt: next.expiresAt).timeIntervalSinceNow)
    renewal = Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled else { return }
      await self?.renewNow()
    }
  }

  private func renewNow() async {
    do {
      let next = try await refresh()
      onIdToken?(next.idToken)
      schedule(next)
    } catch is AuthError {
      // The refresh token is gone or rejected: the session is over.
      onIdToken?(nil)
    } catch {
      // Offline: keep the session; the reconnect or the next foreground renews it.
    }
  }

  /// One refresh at a time, so a rotated refresh token is never used twice.
  private func refresh() async throws -> Session {
    if let refreshing { return try await refreshing.value }
    let task = Task { () throws -> Session in
      guard let current = session, let refreshToken = current.refreshToken else { throw AuthError.signedOut }
      do {
        let tokens = try await requestTokens(["grant_type": "refresh_token", "client_id": config.clientId, "refresh_token": refreshToken])
        return try save(tokens, nonce: nil, previous: current)
      } catch let error as AuthError {
        session = nil
        Keychain.clear()
        throw error
      }
    }
    refreshing = task
    defer { refreshing = nil }
    return try await task.value
  }

  private struct Tokens: Decodable {
    let id_token: String
    let refresh_token: String?
  }

  private func save(_ tokens: Tokens, nonce: String?, previous: Session?) throws -> Session {
    let expiresAt = try validateIdToken(tokens.id_token, config: config, nonce: nonce, now: Date().timeIntervalSince1970)
    let next = Session(idToken: tokens.id_token, refreshToken: tokens.refresh_token ?? previous?.refreshToken, expiresAt: expiresAt)
    try Keychain.write(next)
    session = next
    return next
  }

  private func requestTokens(_ params: [String: String]) async throws -> Tokens {
    var request = URLRequest(url: URL(string: "https://\(config.domain)/oauth/token")!)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data(formEncode(params).utf8)
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    // A 5xx is Auth0 being down, not the session being dead: treat it like being offline.
    if status >= 500 { throw URLError(.badServerResponse) }
    guard status == 200 else {
      struct Failure: Decodable { let error: String }
      throw AuthError.provider((try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "token endpoint returned \(status)")
    }
    guard let tokens = try? JSONDecoder().decode(Tokens.self, from: data) else { throw AuthError.rejected("malformed token response") }
    return tokens
  }

  /// Best effort: sign-out on this phone does not wait on the network.
  private func revoke(_ refreshToken: String) async {
    var request = URLRequest(url: URL(string: "https://\(config.domain)/oauth/revoke")!)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data(formEncode(["client_id": config.clientId, "token": refreshToken]).utf8)
    _ = try? await URLSession.shared.data(for: request)
  }
}

private func formEncode(_ params: [String: String]) -> String {
  let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
  return params.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "")" }.joined(separator: "&")
}

/// The Auth0 page in a private (ephemeral) browser sheet, so no cookie outlives sign-out.
@MainActor
private final class WebSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
  private var session: ASWebAuthenticationSession?

  func run(_ url: URL) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callback, error in
        if let callback {
          continuation.resume(returning: callback)
        } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
          continuation.resume(throwing: AuthError.provider("cancelled"))
        } else {
          continuation.resume(throwing: AuthError.provider(error?.localizedDescription ?? "no callback"))
        }
      }
      session.presentationContextProvider = self
      session.prefersEphemeralWebBrowserSession = true
      self.session = session
      if !session.start() { continuation.resume(throwing: AuthError.provider("could not open the sign-in page")) }
    }
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }
  }
}
