import SwiftUI

@main
struct TARSApp: App {
  @StateObject private var store = Self.makeStore()
  @Environment(\.scenePhase) private var phase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(store)
        .preferredColorScheme(.light)
        .onChange(of: phase) { _, now in if now == .active { store.becameActive() } }
    }
  }

  private static func makeStore() -> Store {
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("-fixtureToday") { return Fixtures.store }
    #endif
    return Store()
  }
}

struct RootView: View {
  @EnvironmentObject private var store: Store

  var body: some View {
    Group {
      switch store.auth {
      case .starting:
        VStack(spacing: 16) {
          TarsFigure(size: 96)
          ProgressView().tint(Color.ink)
          Text("Opening your session").font(.text(17, .body)).foregroundStyle(Color.ink2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      case .signedOut, .signingIn:
        SignInView()
      case .signedIn:
        TodayView()
      }
    }
    .background(Color.studio.ignoresSafeArea())
  }
}

struct SignInView: View {
  @EnvironmentObject private var store: Store

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Spacer()
      TarsFigure(size: 120)
      Text("TARS").font(.heading(34, .largeTitle)).foregroundStyle(Color.ink).accessibilityAddTraits(.isHeader)
      Text("Your morning brief and anything TARS started for you, live on your phone. Sign in with the same account you use in TARS on your Mac.")
        .font(.text(17, .body))
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
      if let problem = store.setupProblem {
        StateLine(glyph: "wrench.and.screwdriver", word: "Not set up", detail: problem)
      } else {
        if case let .signedOut(note?) = store.auth {
          StateLine(glyph: "exclamationmark.triangle", word: "Not signed in", detail: note)
        }
        Button {
          store.signIn()
        } label: {
          if store.auth == .signingIn {
            HStack(spacing: 8) { ProgressView().tint(.white); Text("Signing in") }
          } else {
            Text("Sign in")
          }
        }
        .buttonStyle(PrimaryButton())
        .disabled(store.auth == .signingIn)
        .accessibilityHint("Opens the sign-in page in a private browser sheet")
      }
      Text("Read only on the phone. Editing and sending stay in TARS on your Mac.")
        .font(.text(13, .footnote))
        .foregroundStyle(Color.ink3)
      Spacer()
    }
    .padding(.horizontal, 24)
  }
}
