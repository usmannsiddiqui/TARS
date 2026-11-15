import SwiftUI

// The desktop's identity (renderer/styles.css): studio grey, near-black Helvetica Neue, frosted cards, one navy
// accent for the single primary action. No glow, no neon; state is glyph + word, never colour alone.
extension Color {
  static let studio = Color(red: 0xD6 / 255, green: 0xD5 / 255, blue: 0xD2 / 255)
  static let ink = Color(red: 0x0B / 255, green: 0x0B / 255, blue: 0x0B / 255)
  static let ink2 = Color(red: 0x39 / 255, green: 0x39 / 255, blue: 0x37 / 255)
  static let ink3 = Color(red: 0x52 / 255, green: 0x51 / 255, blue: 0x4E / 255)
  static let accent = Color(red: 0x1F / 255, green: 0x34 / 255, blue: 0x60 / 255)
}

extension Font {
  static func heading(_ size: CGFloat, _ style: Font.TextStyle) -> Font { .custom("HelveticaNeue-Bold", size: size, relativeTo: style) }
  static func text(_ size: CGFloat, _ style: Font.TextStyle) -> Font { .custom("HelveticaNeue", size: size, relativeTo: style) }
  static func medium(_ size: CGFloat, _ style: Font.TextStyle) -> Font { .custom("HelveticaNeue-Medium", size: size, relativeTo: style) }
}

struct PrimaryButton: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.medium(17, .body))
      .foregroundStyle(.white)
      .frame(maxWidth: .infinity, minHeight: 44)
      .padding(.horizontal, 16)
      .background(Color.accent.opacity(configuration.isPressed ? 0.85 : 1), in: RoundedRectangle(cornerRadius: 8))
  }
}

struct SecondaryButton: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.medium(17, .body))
      .foregroundStyle(Color.ink)
      .frame(maxWidth: .infinity, minHeight: 44)
      .padding(.horizontal, 16)
      .background(Color.white.opacity(configuration.isPressed ? 0.6 : 0.84), in: RoundedRectangle(cornerRadius: 8))
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.black.opacity(0.2)))
  }
}

extension View {
  /// The frosted content card: one separation method (frost + its light edge), no resting shadow.
  func frosted() -> some View {
    padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
      .background(Color.white.opacity(0.62), in: RoundedRectangle(cornerRadius: 14))
      .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.white.opacity(0.65)))
  }

  func sectionTitle() -> some View {
    font(.heading(20, .title3)).foregroundStyle(Color.ink).accessibilityAddTraits(.isHeader)
  }
}

/// A state, said by glyph and word (and a detail), read as one sentence by VoiceOver.
struct StateLine: View {
  let glyph: String
  let word: String
  var detail: String? = nil

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: glyph).foregroundStyle(Color.ink)
      (Text(word).font(.heading(15, .subheadline)) + Text(detail.map { "  \($0)" } ?? "").font(.text(15, .subheadline)))
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(detail.map { "\(word). \($0)" } ?? word)
  }
}

/// TARS, exported from the desktop renderer's PetFigure (idle, "mark" framing).
struct TarsFigure: View {
  let size: CGFloat
  var body: some View {
    Image("TarsFigure").resizable().interpolation(.high).frame(width: size, height: size).accessibilityLabel("TARS")
  }
}
