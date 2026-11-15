import Combine
import ConvexMobile
import SwiftUI

struct TodayView: View {
  @EnvironmentObject private var store: Store
  @State private var draftFor: OfferContent?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        header
        if !store.online {
          StateLine(glyph: "wifi.slash", word: "Offline", detail: "Showing what last arrived. Reconnecting on its own.")
        }
        switch store.today {
        case .loading:
          HStack(spacing: 12) {
            ProgressView().tint(Color.ink)
            Text("Reading today's brief").font(.text(17, .body)).foregroundStyle(Color.ink2)
          }
          .accessibilityElement(children: .combine)
        case let .failed(reason):
          VStack(alignment: .leading, spacing: 16) {
            StateLine(glyph: "exclamationmark.triangle", word: "Could not load today", detail: reason)
            Button("Try again") { store.retry() }.buttonStyle(PrimaryButton())
          }
        case let .ready(content):
          if let offer = content.offer { OfferCard(offer: offer, onFinish: { draftFor = offer }) }
          if let brief = content.brief {
            BriefSections(brief: brief)
          } else {
            StateLine(glyph: "clock", word: "Nothing prepared yet", detail: "TARS prepares your morning brief each morning. It appears here the moment it is ready.")
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.bottom, 32)
    }
    .background(Color.studio.ignoresSafeArea())
    .sheet(item: $draftFor) { DraftView(offer: $0) }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center) {
        TarsFigure(size: 72)
        Spacer()
        Button("Sign out") { store.signOut() }
          .font(.medium(15, .subheadline))
          .foregroundStyle(Color.ink)
          .frame(minWidth: 44, minHeight: 44)
          .accessibilityHint("Removes your session from this phone")
      }
      Text("Today").font(.heading(34, .largeTitle)).foregroundStyle(Color.ink).accessibilityAddTraits(.isHeader)
      Text(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day())).font(.text(17, .body)).foregroundStyle(Color.ink3)
    }
    .padding(.top, 8)
  }
}

extension OfferContent: Identifiable { var id: String { nudgeId } }

/// Something TARS started for you, with the desktop's two choices.
struct OfferCard: View {
  @EnvironmentObject private var store: Store
  let offer: OfferContent
  let onFinish: () -> Void
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      StateLine(glyph: "doc.text", word: offer.startedForYou ? "Started for you" : "Draft waiting", detail: "A draft is waiting in the project.")
      Text(offer.title).sectionTitle()
      Text(offer.body).font(.text(17, .body)).foregroundStyle(Color.ink2).fixedSize(horizontal: false, vertical: true)
      VStack(spacing: 8) {
        Button("Finish it together", action: onFinish)
          .buttonStyle(PrimaryButton())
          .accessibilityHint("Shows the draft, read only")
        Button("Not now") {
          busy = true
          error = nil
          Task {
            do { try await store.notNow(offer.nudgeId) } catch { self.error = error.localizedDescription }
            busy = false
          }
        }
        .buttonStyle(SecondaryButton())
        .disabled(busy)
        .accessibilityHint("Closes this offer")
      }
      if let error { StateLine(glyph: "exclamationmark.triangle", word: "Not closed", detail: error) }
    }
    .frosted()
  }
}

struct BriefSections: View {
  let brief: BriefContent

  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      VStack(alignment: .leading, spacing: 12) {
        Text("Recommended start").sectionTitle()
        if let start = brief.start {
          Text(start).font(.medium(22, .title2)).foregroundStyle(Color.ink).fixedSize(horizontal: false, vertical: true)
          if let why = brief.why {
            (Text("Why this one: ").font(.heading(17, .body)) + Text(why).font(.text(17, .body)))
              .foregroundStyle(Color.ink2)
              .fixedSize(horizontal: false, vertical: true)
          }
        } else {
          StateLine(glyph: "checkmark.circle", word: "Nothing urgent", detail: "No single start stands out today.")
        }
        Text("Prepared \(brief.preparedAt.formatted(date: .omitted, time: .shortened)) · updates live")
          .font(.text(13, .footnote))
          .foregroundStyle(Color.ink3)
      }
      .frosted()

      if !brief.read.isEmpty {
        Section("What TARS read") {
          ForEach(brief.read, id: \.self) { line in
            Label { Text(line) } icon: { Image(systemName: "checkmark") }.rowText()
          }
        }
      }

      Section("Meetings and deadlines") {
        if brief.hard.isEmpty {
          StateLine(glyph: "calendar", word: "None", detail: "No meetings or due dates in your sources.")
        }
        ForEach(Array(brief.hard.enumerated()), id: \.offset) { _, row in
          let meeting = row.kind == "meeting"
          Label {
            (Text("\(row.label)  ").font(.heading(17, .body)).monospacedDigit() + Text(row.text))
          } icon: {
            Image(systemName: meeting ? "calendar" : "flag")
          }
          .rowText()
          .accessibilityLabel("\(meeting ? "Meeting" : "Deadline"), \(row.label): \(row.text)")
        }
      }

      Section("Suggested work") {
        Text("Suggestions, not deadlines. Nothing here is scheduled for you.").font(.text(13, .footnote)).foregroundStyle(Color.ink3)
        if brief.suggested.isEmpty {
          StateLine(glyph: "tray", word: "Nothing suggested yet")
        }
        ForEach(brief.suggested, id: \.self) { text in
          Label { Text(text) } icon: { Image(systemName: "arrow.right") }.rowText()
        }
      }

      if brief.staleCount > 0 {
        StateLine(glyph: "exclamationmark.triangle", word: "May be out of date",
                  detail: brief.staleCount == 1 ? "1 source could not be checked as current." : "\(brief.staleCount) sources could not be checked as current.")
      }
    }
  }
}

/// A section on the page: title, then rows separated by hairlines. No card.
private struct Section<Content: View>: View {
  let title: String
  @ViewBuilder let content: Content
  init(_ title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title).sectionTitle()
      Rectangle().fill(Color.black.opacity(0.1)).frame(height: 1).accessibilityHidden(true)
      content
    }
  }
}

private extension View {
  func rowText() -> some View {
    font(.text(17, .body)).foregroundStyle(Color.ink).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// "Finish it together" on the phone: the draft, read only and live. Editing and sending stay on the Mac.
struct DraftView: View {
  @EnvironmentObject private var store: Store
  @Environment(\.dismiss) private var dismiss
  let offer: OfferContent
  @State private var draft: Load<Draft?> = .loading
  @State private var subscription: AnyCancellable?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          StateLine(glyph: "lock", word: "Read only", detail: "Editing and sending happen in TARS on your Mac.")
          switch draft {
          case .loading:
            HStack(spacing: 12) { ProgressView().tint(Color.ink); Text("Opening the draft").font(.text(17, .body)) }
          case let .failed(reason):
            StateLine(glyph: "exclamationmark.triangle", word: "Could not open the draft", detail: reason)
            Button("Try again") { open() }.buttonStyle(PrimaryButton())
          case .loaded(nil):
            StateLine(glyph: "doc", word: "No draft yet", detail: "Open the project in TARS on your Mac to start one.")
          case let .loaded(draft?):
            Text(draft.text).font(.text(17, .body)).foregroundStyle(Color.ink).textSelection(.enabled).frosted()
          }
        }
        .padding(16)
      }
      .background(Color.studio.ignoresSafeArea())
      .navigationTitle(offer.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.foregroundStyle(Color.ink) } }
    }
    .onAppear(perform: open)
    .onDisappear { subscription = nil }
  }

  private func open() {
    draft = .loading
    subscription = store.draft(offer.projectId)?
      .receive(on: DispatchQueue.main)
      .sink(receiveCompletion: { if case let .failure(error) = $0 { draft = .failed(describe(error)) } },
            receiveValue: { draft = .loaded($0) })
  }
}
