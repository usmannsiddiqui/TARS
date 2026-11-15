import Foundation
import Security

/// The signed-in session, kept only in the Keychain (this device, after first unlock). Never logged.
struct Session: Codable {
  let idToken: String
  let refreshToken: String?
  let expiresAt: TimeInterval
}

enum Keychain {
  private static let base: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "dev.tars.companion",
    kSecAttrAccount as String: "session",
  ]

  static func read() -> Session? {
    var query = base
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
    return try? JSONDecoder().decode(Session.self, from: data)
  }

  static func write(_ session: Session) throws {
    let data = try JSONEncoder().encode(session)
    let update: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    var status = SecItemUpdate(base as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound { status = SecItemAdd(base.merging(update) { $1 } as CFDictionary, nil) }
    guard status == errSecSuccess else { throw AuthError.provider("could not save the session to the Keychain (\(status))") }
  }

  static func clear() {
    SecItemDelete(base as CFDictionary)
  }
}
