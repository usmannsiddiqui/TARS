// Control protocol and scope policy. Pure Foundation: no AX, no I/O.
// Original implementation; no Screenpipe code.
import Foundation

/// The current allowlist. A bundle with an empty origin set is a plain app; browsers need origins.
public struct Scope: Equatable, Sendable {
    public let grantVersion: Int
    public let bundles: [String: Set<String>]
    public init(grantVersion: Int, bundles: [String: Set<String>]) {
        self.grantVersion = grantVersion
        self.bundles = bundles
    }
}

public enum ControlMessage: Equatable, Sendable {
    case scope(Scope), pause, resume, stop
}

/// The reason never echoes message content.
public struct ControlError: Error, Equatable {
    public let reason: String
}

public enum Browsers {
    /// Browsers we recognize. A recognized browser is never read as a plain app.
    static let known: Set<String> = [
        "com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "org.chromium.Chromium",
        "org.mozilla.firefox", "company.thebrowser.Browser", "com.microsoft.edgemac", "com.brave.Browser",
        "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
    ]
    /// Browsers whose page origin we read from the AXWebArea's AXURL. Every other known browser is unsupported.
    static let originReadable: Set<String> = ["com.apple.Safari", "com.google.Chrome"]
}

/// `scheme://host[:port]` for http(s) URLs with a host and no credentials; nil for anything else.
public func normalizeOrigin(_ raw: String) -> String? {
    guard let c = URLComponents(string: raw), let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = c.host?.lowercased(), !host.isEmpty, c.user == nil, c.password == nil else { return nil }
    let defaultPort = scheme == "https" ? 443 : 80
    let port = c.port.map { $0 == defaultPort ? "" : ":\($0)" } ?? ""
    return "\(scheme)://\(host)\(port)"
}

private let bundleIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$")

private func isBool(_ value: Any) -> Bool {
    guard let n = value as? NSNumber else { return false }
    return CFGetTypeID(n) == CFBooleanGetTypeID()
}

/// Strict parser: exact key sets, typed values, nothing executable.
public func parseControl(_ line: String) -> Result<ControlMessage, ControlError> {
    func fail(_ reason: String) -> Result<ControlMessage, ControlError> { .failure(ControlError(reason: reason)) }
    guard line.utf8.count <= 65_536 else { return fail("message too long") }
    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)), let dict = object as? [String: Any],
          let type = dict["type"] as? String else { return fail("not a JSON object with a type") }
    let keys = Set(dict.keys)
    switch type {
    case "pause", "resume", "stop":
        guard keys == ["type"] else { return fail("unexpected fields") }
        return .success(type == "pause" ? .pause : type == "resume" ? .resume : .stop)
    case "scope":
        guard keys == ["type", "grantVersion", "bundles"] else { return fail("unexpected fields") }
        guard let raw = dict["grantVersion"], !isBool(raw), let version = raw as? Int, version >= 0 else {
            return fail("grantVersion must be a non-negative integer")
        }
        guard let list = dict["bundles"] as? [Any] else { return fail("bundles must be an array") }
        var bundles: [String: Set<String>] = [:]
        for item in list {
            guard let entry = item as? [String: Any], let bundleId = entry["bundleId"] as? String,
                  Set(entry.keys).isSubset(of: ["bundleId", "origins"]),
                  bundleIdPattern.firstMatch(in: bundleId, range: NSRange(bundleId.startIndex..., in: bundleId)) != nil
            else { return fail("invalid bundle entry") }
            guard bundles[bundleId] == nil else { return fail("duplicate bundle") }
            var origins = Set<String>()
            if let rawOrigins = entry["origins"] {
                guard let strings = rawOrigins as? [String] else { return fail("origins must be strings") }
                for origin in strings {
                    guard normalizeOrigin(origin) == origin else { return fail("origin must be a normalized http(s) origin") }
                    origins.insert(origin)
                }
            }
            bundles[bundleId] = origins
        }
        return .success(.scope(Scope(grantVersion: version, bundles: bundles)))
    default:
        return fail("unknown message type")
    }
}
