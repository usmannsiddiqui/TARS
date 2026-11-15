import Combine
import ConvexMobile
import Foundation

/// Today's live data: Convex subscriptions over one authenticated WebSocket. Nothing here polls; every change
/// arrives as a push. The only write is "Not now".
@MainActor
final class Store: ObservableObject {
  enum Auth: Equatable {
    case starting
    case signedOut(note: String?)
    case signingIn
    case signedIn
  }

  @Published private(set) var auth: Auth = .starting
  @Published private(set) var brief: Load<PendingBrief?> = .loading
  @Published private(set) var offers: Load<[NudgeOffer]> = .loading
  @Published private(set) var online = true
  /// Set when this build has no Convex or Auth0 configuration.
  let setupProblem: String?

  private let client: ConvexClientWithAuth<Session>?
  private let provider: Auth0Provider?
  private var lifetime = Set<AnyCancellable>()
  private var live = Set<AnyCancellable>()
  private var note: String?

  var today: TodayScreen { todayScreen(brief: brief, offers: offers) }

  init() {
    let info = Bundle.main.infoDictionary ?? [:]
    let value = { (key: String) in (info[key] as? String)?.trimmingCharacters(in: .whitespaces) ?? "" }
    let url = value("TARSConvexURL"), domain = value("TARSAuth0Domain"), clientId = value("TARSAuth0ClientID")
    guard URL(string: url)?.scheme == "https", !domain.isEmpty, !clientId.isEmpty else {
      setupProblem = "This build has no Convex or Auth0 settings. Run apps/ios/scripts/make-config.sh, then build again."
      client = nil
      provider = nil
      auth = .signedOut(note: nil)
      return
    }
    setupProblem = nil
    let provider = Auth0Provider(config: AuthConfig(domain: domain, clientId: clientId))
    let client = ConvexClientWithAuth(deploymentUrl: url, authProvider: provider)
    self.provider = provider
    self.client = client

    // The first value is the client's own initial "unauthenticated", before the cached session is read.
    client.authState.dropFirst().receive(on: DispatchQueue.main).sink { [weak self] state in self?.authChanged(state) }.store(in: &lifetime)
    client.watchWebSocketState().receive(on: DispatchQueue.main).sink { [weak self] in self?.online = $0 == .connected }.store(in: &lifetime)
    Task { _ = await client.loginFromCache() }
  }

  #if DEBUG
  /// Screenshots and previews: Today from fixed data, no network.
  init(fixture brief: PendingBrief?, offers: [NudgeOffer]) {
    setupProblem = nil
    client = nil
    provider = nil
    auth = .signedIn
    self.brief = .loaded(brief)
    self.offers = .loaded(offers)
  }
  #endif

  func signIn() {
    guard let client else { return }
    note = nil
    auth = .signingIn
    Task {
      if case let .failure(error) = await client.login() {
        note = error.localizedDescription
        auth = .signedOut(note: note)
      }
    }
  }

  func signOut() {
    guard let client else { return }
    Task { await client.logout() }
  }

  /// A failed subscription, retried because the user asked.
  func retry() { subscribe() }

  func becameActive() {
    guard let provider else { return }
    Task { await provider.renewIfDue() }
  }

  /// "Not now": closes the offer; the subscription removes it from the screen.
  func notNow(_ nudgeId: String) async throws {
    guard let client else { throw AuthError.signedOut }
    struct Responded: Decodable { let projectId: String }
    do {
      let _: Responded = try await client.mutation("briefs:respondToNudge", with: ["nudgeId": nudgeId, "choice": "not-now"])
    } catch let error as ClientError {
      throw Failure(message: describe(error))
    }
  }

  /// The project's draft, live and read-only.
  func draft(_ projectId: String) -> AnyPublisher<Draft?, ClientError>? {
    client?.subscribe(to: "artifacts:getArtifact", with: ["projectId": projectId], yielding: Draft?.self)
  }

  private func authChanged(_ state: AuthState<Session>) {
    switch state {
    case .authenticated:
      auth = .signedIn
      subscribe()
    case .unauthenticated:
      live.removeAll()
      brief = .loading
      offers = .loading
      auth = .signedOut(note: note)
    case .loading:
      if auth != .signingIn { auth = .starting }
    }
  }

  private func subscribe() {
    guard let client else { return }
    live.removeAll()
    brief = .loading
    offers = .loading
    client.subscribe(to: "briefs:getPendingBrief", with: ["kind": "morning"], yielding: PendingBrief?.self)
      .receive(on: DispatchQueue.main)
      .sink(receiveCompletion: { [weak self] in if case let .failure(error) = $0 { self?.brief = .failed(describe(error)) } },
            receiveValue: { [weak self] in self?.brief = .loaded($0) })
      .store(in: &live)
    client.subscribe(to: "briefs:listNudgeOffers", yielding: [NudgeOffer].self)
      .receive(on: DispatchQueue.main)
      .sink(receiveCompletion: { [weak self] in if case let .failure(error) = $0 { self?.offers = .failed(describe(error)) } },
            receiveValue: { [weak self] in self?.offers = .loaded($0) })
      .store(in: &live)
  }
}

struct Failure: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/// A Convex error in words; a ConvexError's data arrives JSON-encoded.
func describe(_ error: ClientError) -> String {
  switch error {
  case let .ConvexError(data): (try? JSONDecoder().decode(String.self, from: Data(data.utf8))) ?? data
  case let .ServerError(msg), let .InternalError(msg): msg
  }
}
