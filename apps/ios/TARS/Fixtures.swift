#if DEBUG
import SwiftUI

/// Illustrative data for previews and simulator screenshots (launch argument -fixtureToday). Debug builds only.
enum Fixtures {
  static let brief = try! JSONDecoder().decode(PendingBrief.self, from: Data("""
  {"key":"morning:2026-11-15","kind":"morning","preparedAt":\(Date.now.addingTimeInterval(-3_600).timeIntervalSince1970 * 1000),"delivered":true,"tradeoffs":[],
   "read":[{"kind":"outlook-calendar","count":3},{"kind":"gmail","count":12},{"kind":"canvas","count":2},{"kind":"commitments","count":7}],
   "brief":{"kind":"morning","items":[],"recommendedAction":"Send Alice the revised pilot pricing","reason":"She asked for it before Thursday's call, and the draft is already half done.",
     "staleSourceIds":[],
     "hard":[
       {"commitmentId":"c1","projectId":"p1","text":"Weekly sync with Bob","dueAt":"2026-11-15T15:00:00Z","kind":"meeting","current":true,"label":"10:00 AM"},
       {"commitmentId":"c2","projectId":"p2","text":"Grant application, section 3","dueAt":"2026-11-15T22:59:00Z","kind":"deadline","current":true,"label":"Today 5:59 PM"}],
     "suggested":[{"projectId":"p3","text":"Outline the onboarding email sequence"},{"projectId":"p1","text":"Tidy the investor update notes"}],
     "triage":[]}}
  """.utf8))

  static let offers = try! JSONDecoder().decode([NudgeOffer].self, from: Data("""
  [{"nudgeId":"n1","projectId":"p1","key":"nudge:c3","title":"Reply to Alice about the pilot","body":"TARS drafted a first reply from her last email. It needs your numbers and a sign-off.","startedForYou":true,"delivered":true}]
  """.utf8))

  @MainActor static var store: Store { Store(fixture: brief, offers: offers) }
}

#Preview("Today") {
  TodayView().environmentObject(Fixtures.store)
}

#Preview("Nothing yet") {
  TodayView().environmentObject(Store(fixture: nil, offers: []))
}
#endif
