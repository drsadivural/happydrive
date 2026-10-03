import Foundation
import HappyDriveCore

/// ビルド設定（xcconfig → Info.plist）から読む値
struct AppConfig: Sendable {
    var googleClientId: String? = nil
    let apiBaseURL: URL
    let termsVersion: String
    let privacyVersion: String
    let termsURL: URL?
    let privacyURL: URL?
    let supportURL: URL?
    let apnsEnvironment: APNsEnvironment
    let appVersion: String

    static func load(bundle: Bundle = .main, environment: [String: String] = ProcessInfo.processInfo.environment) -> AppConfig {
        func string(_ key: String) -> String? {
            guard let v = bundle.object(forInfoDictionaryKey: key) as? String else { return nil }
            let trimmed = v.trimmingCharacters(in: .whitespacesAndNewlines)
            // 未展開の $(VAR) は未設定として扱う
            return trimmed.isEmpty || trimmed.hasPrefix("$(") ? nil : trimmed
        }

        var base = string("HDAPIBaseURL").flatMap(URL.init(string:))
        #if DEBUG
        // UI テストやローカル検証用の上書き（Debug ビルドのみ）
        if let override = environment["HD_API_BASE_URL"], let url = URL(string: override) {
            base = url
        }
        #endif
        guard let apiBaseURL = base else {
            fatalError("Info.plist の HDAPIBaseURL（xcconfig の API_BASE_URL）が未設定です")
        }

        let version = (bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "-"
        let build = (bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "-"

        return AppConfig(
            googleClientId: string("HDGoogleClientID"),
            apiBaseURL: apiBaseURL,
            termsVersion: string("HDTermsVersion") ?? "unset",
            privacyVersion: string("HDPrivacyVersion") ?? "unset",
            termsURL: string("HDTermsURL").flatMap(URL.init(string:)),
            privacyURL: string("HDPrivacyURL").flatMap(URL.init(string:)),
            supportURL: string("HDSupportURL").flatMap(URL.init(string:)),
            apnsEnvironment: string("HDAPNsEnvironment") == "production" ? .production : .sandbox,
            appVersion: "\(version) (\(build))"
        )
    }
}
