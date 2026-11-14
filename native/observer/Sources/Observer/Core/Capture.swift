// Bounded, scope-first text extraction over an abstract accessibility tree, and the one-pending-slot
// sequencing that discards results from an old grant. Original implementation; no Screenpipe code.
import Foundation

/// One accessibility element. Reading `text` is a content read; role/subrole/url/children are structure.
public protocol AXNode {
    var role: String? { get }
    var subrole: String? { get }
    /// Only meaningful on AXWebArea.
    var url: String? { get }
    var text: String? { get }
    var children: [Self] { get }
}

/// Contract defaults: initial engineering limits, to be tuned only from measurement.
public struct Budget: Sendable {
    public var nodes = 500
    public var characters = 12_000 // UTF-16 units, the same unit as the main process's string length check
    public var nanoseconds: UInt64 = 100_000_000
    public init() {}
}

public enum Outcome: Equatable, Sendable {
    case denied
    case unsupported
    case captured(text: String, siteOrigin: String?, truncated: Bool)
}

public let monotonicNow: @Sendable () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }

private func isSecure<N: AXNode>(_ node: N) -> Bool {
    node.role == "AXSecureTextField" || node.subrole == "AXSecureTextField"
}

/// Scope is decided before any text is read: unselected app, unknown or unlisted origin → nothing read.
public func capture<N: AXNode>(bundleId: String, window: N, scope: Scope?, budget: Budget = Budget(),
                               now: () -> UInt64 = monotonicNow) -> Outcome {
    guard let scope, let origins = scope.bundles[bundleId] else { return .denied }
    let start = now()
    func expired() -> Bool { now() - start >= budget.nanoseconds }

    guard Browsers.known.contains(bundleId) else {
        // Origins on a plain app mean the user wanted site-limited capture we cannot enforce there.
        guard origins.isEmpty else { return .unsupported }
        return walk(window, siteOrigin: nil, budget: budget, expired: expired)
    }
    guard Browsers.originReadable.contains(bundleId) else { return .unsupported }
    // Find the page (structure only, no text); its URL is the only origin source we trust.
    var queue = [window], seen = 0
    while !queue.isEmpty, seen < budget.nodes, !expired() {
        let node = queue.removeFirst()
        seen += 1
        if node.role == "AXWebArea" {
            guard let origin = node.url.flatMap(normalizeOrigin), origins.contains(origin) else { return .denied }
            var rest = budget
            rest.nodes -= seen - 1 // the search and the walk share one node budget
            return walk(node, siteOrigin: origin, budget: rest, expired: expired)
        }
        if !isSecure(node) { queue.append(contentsOf: node.children) }
    }
    return .denied
}

private func walk<N: AXNode>(_ root: N, siteOrigin: String?, budget: Budget, expired: () -> Bool) -> Outcome {
    var stack = [root], visited = 0, units = 0, truncated = false
    var pieces: [String] = []
    while let node = stack.popLast() {
        if visited >= budget.nodes || expired() { truncated = true; break }
        visited += 1
        if isSecure(node) { continue } // never read, never descended
        if let raw = node.text?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
            let separator = pieces.isEmpty ? 0 : 1
            let room = budget.characters - units - separator
            if raw.utf16.count > room {
                var cut = ""
                for ch in raw where cut.utf16.count + ch.utf16.count <= room { cut.append(ch) }
                if !cut.isEmpty { pieces.append(cut); units += separator + cut.utf16.count }
                truncated = true
                break
            }
            pieces.append(raw)
            units += separator + raw.utf16.count
        }
        stack.append(contentsOf: node.children.reversed()) // document order
    }
    return .captured(text: pieces.joined(separator: "\n"), siteOrigin: siteOrigin, truncated: truncated)
}

public struct Ticket: Equatable, Sendable {
    public let window: String
    public let bundleId: String
    let generation: Int
    public let scope: Scope
}

/// One output line on stdout.
public enum OutputLine: Equatable, Sendable {
    case event(bundleId: String, windowId: String, siteOrigin: String?, text: String, capturedAt: String,
               grantVersion: Int, truncated: Bool)
    case status(String, bundleId: String? = nil)

    public var json: String {
        var object: [String: Any]
        switch self {
        case let .event(bundleId, windowId, siteOrigin, text, capturedAt, grantVersion, truncated):
            object = ["type": "event", "bundleId": bundleId, "windowId": windowId, "text": text,
                      "capturedAt": capturedAt, "grantVersion": grantVersion, "truncated": truncated]
            if let siteOrigin { object["siteOrigin"] = siteOrigin }
        case let .status(status, bundleId):
            object = ["type": "status", "status": status]
            if let bundleId { object["bundleId"] = bundleId }
        }
        let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }
}

/// Main-thread state. Each window has at most one pending extraction; a scope change or pause bumps the
/// generation, which drops pending slots and makes every in-flight result stale.
public final class Session {
    public private(set) var scope: Scope?
    public private(set) var paused = false
    private var generation = 0
    private var pending: [String: String] = [:] // window -> bundleId

    public init() {}

    public func apply(_ message: ControlMessage) {
        switch message {
        case let .scope(s): scope = s
        case .pause: paused = true
        case .resume: paused = false
        case .stop: break
        }
        invalidate()
    }

    /// Drops pending slots and makes every in-flight result stale (scope change, pause, permission loss).
    public func invalidate() {
        generation += 1
        pending.removeAll()
    }

    public func allows(_ bundleId: String) -> Bool { !paused && scope?.bundles[bundleId] != nil }

    /// True when a new extraction should be dispatched; false if denied or coalesced into the pending slot.
    public func request(window: String, bundleId: String) -> Bool {
        guard allows(bundleId), pending[window] == nil else { return false }
        pending[window] = bundleId
        return true
    }

    /// Called when the worker starts; nil if the slot was dropped meanwhile.
    public func begin(window: String) -> Ticket? {
        guard let bundleId = pending.removeValue(forKey: window), !paused, let scope else { return nil }
        return Ticket(window: window, bundleId: bundleId, generation: generation, scope: scope)
    }

    public func finish(_ ticket: Ticket, _ outcome: Outcome, capturedAt: String) -> OutputLine? {
        guard ticket.generation == generation, !paused, scope == ticket.scope else { return nil }
        switch outcome {
        case .denied: return nil
        case .unsupported: return .status("unsupported-app", bundleId: ticket.bundleId)
        case let .captured(text, siteOrigin, truncated):
            guard !text.isEmpty else { return nil }
            return .event(bundleId: ticket.bundleId, windowId: ticket.window, siteOrigin: siteOrigin, text: text,
                          capturedAt: capturedAt, grantVersion: ticket.scope.grantVersion, truncated: truncated)
        }
    }
}
