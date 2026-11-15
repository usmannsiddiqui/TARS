import XCTest
@testable import ObserverCore

/// An abstract accessibility tree. Counts every content read so tests can prove nothing was read.
final class FakeNode: AXNode {
    let role: String?
    let subrole: String?
    let url: String?
    private let value: String?
    private let kids: [FakeNode]
    let reads: Counter

    final class Counter { var count = 0 }

    init(_ role: String, _ text: String? = nil, subrole: String? = nil, url: String? = nil,
         reads: Counter, _ kids: [FakeNode] = []) {
        self.role = role; self.subrole = subrole; self.url = url
        self.value = text; self.kids = kids; self.reads = reads
    }

    var text: String? { if value != nil { reads.count += 1 }; return value }
    var children: [FakeNode] { kids }
}

private let notes = "com.apple.Notes"
private let safari = "com.apple.Safari"
private let firefox = "org.mozilla.firefox"

private func scope(_ bundles: [String: Set<String>], version: Int = 7) -> Scope {
    Scope(grantVersion: version, bundles: bundles)
}

private func browserWindow(origin url: String?, reads: FakeNode.Counter) -> FakeNode {
    FakeNode("AXWindow", "Window title", reads: reads, [
        FakeNode("AXToolbar", "Address bar text", reads: reads),
        FakeNode("AXWebArea", url: url, reads: reads, [FakeNode("AXStaticText", "Private page body", reads: reads)]),
    ])
}

final class ScopeTests: XCTestCase {
    func testUnselectedAppIsDenied() {
        let reads = FakeNode.Counter()
        let window = FakeNode("AXWindow", reads: reads, [FakeNode("AXStaticText", "Slack DM", reads: reads)])
        let s = scope([notes: []])

        XCTAssertEqual(capture(bundleId: "com.tinyspeck.slackmacgap", window: window, scope: s), .denied)
        XCTAssertEqual(capture(bundleId: notes, window: window, scope: nil), .denied, "no scope yet means nothing is allowed")
        XCTAssertEqual(reads.count, 0, "no text may be read from an unselected app")

        let session = Session()
        session.apply(.scope(s))
        XCTAssertFalse(session.request(window: "1-1", bundleId: "com.tinyspeck.slackmacgap"))
    }

    func testUnknownBrowserOriginIsDenied() {
        let reads = FakeNode.Counter()
        let s = scope([safari: ["https://docs.example.com"]])

        XCTAssertEqual(capture(bundleId: safari, window: browserWindow(origin: nil, reads: reads), scope: s), .denied)
        XCTAssertEqual(capture(bundleId: safari, window: browserWindow(origin: "https://evil.example.com/x", reads: reads), scope: s), .denied)
        XCTAssertEqual(capture(bundleId: safari, window: browserWindow(origin: "file:///Users/me/a.html", reads: reads), scope: s), .denied)
        XCTAssertEqual(capture(bundleId: safari, window: FakeNode("AXWindow", "no web area", reads: reads), scope: s), .denied)
        // A browser selected without any origin captures nothing.
        XCTAssertEqual(capture(bundleId: safari, window: browserWindow(origin: "https://docs.example.com/", reads: reads), scope: scope([safari: []])), .denied)
        XCTAssertEqual(reads.count, 0, "no text may be read when the origin is unknown or not allowed")

        // A browser whose origin we cannot determine is unsupported, never read.
        XCTAssertEqual(capture(bundleId: firefox, window: browserWindow(origin: "https://docs.example.com/", reads: reads), scope: scope([firefox: ["https://docs.example.com"]])), .unsupported)
        XCTAssertEqual(reads.count, 0)

        // Allowed origin: only the page content is read, not browser chrome.
        let allowed = capture(bundleId: safari, window: browserWindow(origin: "https://Docs.Example.com:443/doc/1?q", reads: reads), scope: s)
        XCTAssertEqual(allowed, .captured(text: "Private page body", siteOrigin: "https://docs.example.com", truncated: false))
    }

    func testTraversalBudgetStops() {
        let reads = FakeNode.Counter()
        let many = FakeNode("AXWindow", reads: reads, (0..<600).map { FakeNode("AXStaticText", "n\($0)", reads: reads) })
        guard case let .captured(text, _, truncated) = capture(bundleId: notes, window: many, scope: scope([notes: []])) else { return XCTFail() }
        XCTAssertTrue(truncated, "node budget")
        XCTAssertEqual(text.split(separator: "\n").count, 499, "window + 499 children = 500 nodes")

        let long = FakeNode("AXWindow", reads: reads, (0..<5).map { _ in FakeNode("AXStaticText", String(repeating: "a", count: 5_000), reads: reads) })
        guard case let .captured(text2, _, truncated2) = capture(bundleId: notes, window: long, scope: scope([notes: []])) else { return XCTFail() }
        XCTAssertTrue(truncated2, "character budget")
        XCTAssertEqual(text2.utf16.count, 12_000)

        var t: UInt64 = 0
        let clock = { () -> UInt64 in t += 30_000_000; return t } // every check costs 30 ms
        guard case let .captured(text3, _, truncated3) = capture(bundleId: notes, window: many, scope: scope([notes: []]), now: clock) else { return XCTFail() }
        XCTAssertTrue(truncated3, "time budget")
        XCTAssertLessThan(text3.split(separator: "\n").count, 5)

        let small = FakeNode("AXWindow", reads: reads, [FakeNode("AXStaticText", "hello", reads: reads)])
        XCTAssertEqual(capture(bundleId: notes, window: small, scope: scope([notes: []])), .captured(text: "hello", siteOrigin: nil, truncated: false))
    }

    func testSecureFieldIsExcluded() {
        let reads = FakeNode.Counter()
        let window = FakeNode("AXWindow", reads: reads, [
            FakeNode("AXStaticText", "Sign in", reads: reads),
            FakeNode("AXSecureTextField", "hunter2", reads: reads),
            FakeNode("AXTextField", "hunter3", subrole: "AXSecureTextField", reads: reads, [FakeNode("AXStaticText", "hunter4", reads: reads)]),
        ])
        XCTAssertEqual(capture(bundleId: notes, window: window, scope: scope([notes: []])), .captured(text: "Sign in", siteOrigin: nil, truncated: false))
        XCTAssertEqual(reads.count, 1, "secure fields and their children are never read")
    }

    func testOldGrantVersionResultIsDiscarded() {
        let session = Session()
        session.apply(.scope(scope([notes: []], version: 1)))
        XCTAssertTrue(session.request(window: "w", bundleId: notes))
        XCTAssertFalse(session.request(window: "w", bundleId: notes), "a burst coalesces into the one pending slot")
        let ticket = try! XCTUnwrap(session.begin(window: "w"))
        XCTAssertTrue(session.request(window: "w", bundleId: notes), "one more may queue while one runs")

        session.apply(.scope(scope([notes: []], version: 2)))
        XCTAssertNil(session.begin(window: "w"), "scope change drops the pending extraction")
        let done = Outcome.captured(text: "old", siteOrigin: nil, truncated: false)
        XCTAssertNil(session.finish(ticket, done, capturedAt: "2026-11-14T10:00:00.000Z"), "in-flight result under the old grant version is discarded")

        XCTAssertTrue(session.request(window: "w", bundleId: notes))
        let fresh = try! XCTUnwrap(session.begin(window: "w"))
        session.apply(.pause)
        XCTAssertNil(session.finish(fresh, done, capturedAt: "2026-11-14T10:00:00.000Z"), "pause discards in-flight results")
        XCTAssertFalse(session.request(window: "w", bundleId: notes), "nothing queues while paused")

        session.apply(.resume)
        XCTAssertTrue(session.request(window: "w", bundleId: notes))
        let live = try! XCTUnwrap(session.begin(window: "w"))
        let line = try! XCTUnwrap(session.finish(live, done, capturedAt: "2026-11-14T10:00:00.000Z"))
        let json = try! JSONSerialization.jsonObject(with: Data(line.json.utf8)) as! [String: Any]
        XCTAssertEqual(json["type"] as? String, "event")
        XCTAssertEqual(json["grantVersion"] as? Int, 2)
        XCTAssertEqual(json["text"] as? String, "old")
        XCTAssertEqual(json["truncated"] as? Bool, false)
        XCTAssertNil(json["siteOrigin"])
        XCTAssertEqual(Set(json.keys), ["type", "bundleId", "windowId", "text", "capturedAt", "grantVersion", "truncated"])
    }

    func testMalformedControlMessageIsRejected() {
        let bad = [
            "not json",
            "[]",
            #"{"type":"exec","command":"rm -rf ~"}"#,
            #"{"type":"pause","extra":1}"#,
            #"{"type":"scope","grantVersion":true,"bundles":[]}"#,
            #"{"type":"scope","grantVersion":-1,"bundles":[]}"#,
            #"{"type":"scope","grantVersion":1.5,"bundles":[]}"#,
            #"{"type":"scope","grantVersion":1,"bundles":[{"bundleId":"a b"}]}"#,
            #"{"type":"scope","grantVersion":1,"bundles":[{"bundleId":"com.a","run":"x"}]}"#,
            #"{"type":"scope","grantVersion":1,"bundles":[{"bundleId":"com.a"},{"bundleId":"com.a"}]}"#,
            #"{"type":"scope","grantVersion":1,"bundles":[{"bundleId":"com.apple.Safari","origins":["https://a.com/path"]}]}"#,
            #"{"type":"scope","grantVersion":1,"bundles":[{"bundleId":"com.apple.Safari","origins":["javascript:alert(1)"]}]}"#,
        ]
        for line in bad {
            if case .success = parseControl(line) { XCTFail("accepted: \(line)") }
        }
        XCTAssertEqual(parseControl(#"{"type":"stop"}"#), .success(.stop))
        XCTAssertEqual(
            parseControl(#"{"type":"scope","grantVersion":3,"bundles":[{"bundleId":"com.apple.Notes"},{"bundleId":"com.apple.Safari","origins":["https://docs.example.com"]}]}"#),
            .success(.scope(Scope(grantVersion: 3, bundles: [notes: [], safari: ["https://docs.example.com"]]))))
    }
}
