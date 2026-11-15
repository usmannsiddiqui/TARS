import XCTest
@testable import TARS

final class TodayTests: XCTestCase {
  // Shapes exactly as briefs.getPendingBrief returns them (read is optional: older rows lack it).
  let briefWithoutRead = """
  {"key":"morning:2026-11-15","kind":"morning","preparedAt":1763197200000,"delivered":false,"tradeoffs":[],
   "brief":{"kind":"morning","items":[],"recommendedAction":"Reply to Dana about the pilot contract","reason":"It is due at noon and blocks the invoice.",
     "staleSourceIds":["src1"],
     "hard":[{"commitmentId":"c1","projectId":"p1","text":"Investor call","dueAt":"2026-11-15T15:00:00Z","kind":"meeting","current":true,"label":"10:00 AM"}],
     "suggested":[{"projectId":"p2","text":"Outline the onboarding email"}],"triage":[]}}
  """

  let offers = """
  [{"nudgeId":"n1","projectId":"p1","key":"nudge:c1","title":"Started for you: the pilot reply","body":"A first draft is ready to finish.","startedForYou":true,"delivered":false}]
  """

  private func brief(_ json: String) throws -> PendingBrief? { try JSONDecoder().decode(PendingBrief?.self, from: Data(json.utf8)) }
  private func nudges(_ json: String) throws -> [NudgeOffer] { try JSONDecoder().decode([NudgeOffer].self, from: Data(json.utf8)) }

  func testLoadingUntilBothSubscriptionsAnswer() throws {
    XCTAssertEqual(todayScreen(brief: .loading, offers: .loaded([])), .loading)
    XCTAssertEqual(todayScreen(brief: .loaded(nil), offers: .loading), .loading)
  }

  func testFailureWinsOverLoading() {
    XCTAssertEqual(todayScreen(brief: .failed("Server error"), offers: .loading), .failed("Server error"))
  }

  func testNothingPreparedYet() throws {
    XCTAssertEqual(todayScreen(brief: .loaded(try brief("null")), offers: .loaded([])), .ready(TodayContent(brief: nil, offer: nil)))
  }

  func testPreparedBriefWithoutReadRows() throws {
    guard case let .ready(content) = todayScreen(brief: .loaded(try brief(briefWithoutRead)), offers: .loaded([])) else { return XCTFail("not ready") }
    let b = try XCTUnwrap(content.brief)
    XCTAssertEqual(b.preparedAt, Date(timeIntervalSince1970: 1_763_197_200))
    XCTAssertEqual(b.start, "Reply to Dana about the pilot contract")
    XCTAssertEqual(b.why, "It is due at noon and blocks the invoice.")
    XCTAssertEqual(b.read, [])
    XCTAssertEqual(b.hard, [HardRow(text: "Investor call", label: "10:00 AM", kind: "meeting")])
    XCTAssertEqual(b.suggested, ["Outline the onboarding email"])
    XCTAssertEqual(b.staleCount, 1)
  }

  func testPreparedBriefWithReadRowsInOrderDroppingZeroAndUnknown() throws {
    let json = briefWithoutRead.replacingOccurrences(
      of: "\"tradeoffs\":[]",
      with: "\"tradeoffs\":[],\"read\":[{\"kind\":\"commitments\",\"count\":4},{\"kind\":\"gmail\",\"count\":1},{\"kind\":\"slack\",\"count\":0},{\"kind\":\"mystery\",\"count\":3},{\"kind\":\"outlook-calendar\",\"count\":3}]"
    )
    guard case let .ready(content) = todayScreen(brief: .loaded(try brief(json)), offers: .loaded([])) else { return XCTFail("not ready") }
    XCTAssertEqual(content.brief?.read, ["Read today's 3 meetings", "Read 1 new email", "Went through 4 open commitments"])
  }

  func testFirstOfferIsShown() throws {
    guard case let .ready(content) = todayScreen(brief: .loaded(nil), offers: .loaded(try nudges(offers))) else { return XCTFail("not ready") }
    XCTAssertEqual(content.offer, OfferContent(nudgeId: "n1", projectId: "p1", title: "Started for you: the pilot reply", body: "A first draft is ready to finish.", startedForYou: true))
  }
}
