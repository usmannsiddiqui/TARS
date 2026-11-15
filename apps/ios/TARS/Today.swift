import Foundation

// briefs.getPendingBrief and briefs.listNudgeOffers, decoded as Convex returns them, and what Today shows from them.

struct PendingBrief: Decodable {
  struct Brief: Decodable {
    struct Hard: Decodable { let text: String; let label: String; let kind: String }
    struct Suggested: Decodable { let text: String }
    let recommendedAction: String?
    let reason: String?
    let staleSourceIds: [String]
    let hard: [Hard]
    let suggested: [Suggested]
  }
  struct Read: Decodable { let kind: String; let count: Double }
  let key: String
  let preparedAt: Double // ms since epoch
  let brief: Brief
  /// What the brief read, per kind. Absent on briefs prepared before it existed.
  let read: [Read]?
}

struct NudgeOffer: Decodable {
  let nudgeId: String
  let projectId: String
  let title: String
  let body: String
  let startedForYou: Bool
}

/// The project's current draft (artifacts.getArtifact); only the text is shown.
struct Draft: Decodable { let text: String }

enum Load<T> {
  case loading
  case loaded(T)
  case failed(String)
}

struct HardRow: Equatable { let text: String; let label: String; let kind: String }

struct BriefContent: Equatable {
  let preparedAt: Date
  let start: String?
  let why: String?
  /// One sentence per kind the brief really read, with its real count.
  let read: [String]
  let hard: [HardRow]
  let suggested: [String]
  let staleCount: Int
}

struct OfferContent: Equatable {
  let nudgeId: String
  let projectId: String
  let title: String
  let body: String
  let startedForYou: Bool
}

struct TodayContent: Equatable {
  /// nil: nothing is prepared yet.
  let brief: BriefContent?
  /// The one offer shown, as on the desktop's Today.
  let offer: OfferContent?
}

enum TodayScreen: Equatable {
  case loading
  case failed(String)
  case ready(TodayContent)
}

func todayScreen(brief: Load<PendingBrief?>, offers: Load<[NudgeOffer]>) -> TodayScreen {
  switch (brief, offers) {
  case let (.failed(reason), _), let (_, .failed(reason)): .failed(reason)
  case let (.loaded(brief), .loaded(offers)):
    .ready(TodayContent(brief: brief.map(briefContent), offer: offers.first.map {
      OfferContent(nudgeId: $0.nudgeId, projectId: $0.projectId, title: $0.title, body: $0.body, startedForYou: $0.startedForYou)
    }))
  default: .loading
  }
}

private func briefContent(_ row: PendingBrief) -> BriefContent {
  BriefContent(
    preparedAt: Date(timeIntervalSince1970: row.preparedAt / 1000),
    start: row.brief.recommendedAction,
    why: row.brief.reason,
    read: readSentences(row.read ?? []),
    hard: row.brief.hard.map { HardRow(text: $0.text, label: $0.label, kind: $0.kind) },
    suggested: row.brief.suggested.map(\.text),
    staleCount: row.brief.staleSourceIds.count
  )
}

// The desktop's words for what the brief read, in its row order (meetings, mail, deadlines, chat, notes, code, commitments).
private func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String { "\(n) \(n == 1 ? one : many ?? one + "s")" }
private let readWords: [(kind: String, words: (Int) -> String)] = [
  ("outlook-calendar", { $0 == 1 ? "Read today's meeting" : "Read today's \($0) meetings" }),
  ("gmail", { "Read \(plural($0, "new email"))" }),
  ("outlook-mail", { "Read \(plural($0, "new email"))" }),
  ("canvas", { "Checked \(plural($0, "Canvas deadline"))" }),
  ("slack", { "Read \(plural($0, "new Slack message"))" }),
  ("teams", { "Read \(plural($0, "new Teams message"))" }),
  ("notion", { "Looked over \(plural($0, "Notion update"))" }),
  ("obsidian", { "Looked over \(plural($0, "changed note"))" }),
  ("github", { "Checked \(plural($0, "GitHub update"))" }),
  ("claude-code", { "Looked over \(plural($0, "Claude Code session note"))" }),
  ("codex", { "Looked over \(plural($0, "Codex session note"))" }),
  ("observation", { "Looked over \(plural($0, "note"))" + " from your apps" }),
  ("commitments", { "Went through \(plural($0, "open commitment"))" }),
]

/// One sentence per kind really read, with its count. Zero and unknown kinds get none.
private func readSentences(_ read: [PendingBrief.Read]) -> [String] {
  readWords.compactMap { entry in
    let count = read.first { $0.kind == entry.kind }.map { Int($0.count) } ?? 0
    return count > 0 ? entry.words(count) : nil
  }
}
