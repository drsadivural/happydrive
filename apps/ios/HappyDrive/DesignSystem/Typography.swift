import SwiftUI
import UIKit
import CoreText

/// Noto Sans JP（可変フォント, OFL）。Dynamic Type に追従させるため必ず relativeTo を指定する。
enum HDFontRegistry {
    nonisolated(unsafe) private static var registered = false
    nonisolated(unsafe) private static var available: [String: Bool] = [:]

    /// Info.plist の UIAppFonts で登録されるが、念のため未登録なら手動で登録する
    @MainActor
    static func registerIfNeeded() {
        guard !registered else { return }
        registered = true
        if UIFont(name: HDWeight.regular.postScriptName, size: 12) == nil,
           let url = Bundle.main.url(forResource: "NotoSansJP-VF", withExtension: "ttf") {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    static func isAvailable(_ name: String) -> Bool {
        if let cached = available[name] { return cached }
        let ok = UIFont(name: name, size: 12) != nil
        available[name] = ok
        return ok
    }
}

enum HDWeight {
    case regular, medium, semibold, bold

    var postScriptName: String {
        switch self {
        case .regular: return "NotoSansJP-Regular"
        case .medium: return "NotoSansJP-Medium"
        case .semibold: return "NotoSansJP-SemiBold"
        case .bold: return "NotoSansJP-Bold"
        }
    }

    var systemWeight: Font.Weight {
        switch self {
        case .regular: return .regular
        case .medium: return .medium
        case .semibold: return .semibold
        case .bold: return .bold
        }
    }
}

extension Font.TextStyle {
    /// 標準サイズ（Large 設定時）。Dynamic Type で拡大縮小される。
    var hdBaseSize: CGFloat {
        switch self {
        case .largeTitle: return 34
        case .title: return 28
        case .title2: return 22
        case .title3: return 20
        case .headline: return 17
        case .body: return 17
        case .callout: return 16
        case .subheadline: return 15
        case .footnote: return 13
        case .caption: return 12
        case .caption2: return 11
        @unknown default: return 17
        }
    }
}

extension Font {
    /// 例: `.font(.hd(.body))`, `.font(.hd(.title2, .bold))`
    static func hd(_ style: Font.TextStyle, _ weight: HDWeight = .regular) -> Font {
        let name = weight.postScriptName
        if HDFontRegistry.isAvailable(name) {
            return .custom(name, size: style.hdBaseSize, relativeTo: style)
        }
        return .system(style, weight: weight.systemWeight)
    }
}
