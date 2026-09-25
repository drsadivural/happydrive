import Foundation

/// 契約: 時刻は UTC の ISO 8601。小数秒あり/なしの両方を受け付け、送信は小数秒なし（Z）で行う。
public enum HDJSON {
    public static func makeDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let date = parseDateTime(raw) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "ISO 8601 形式ではない日時: \(raw)")
        }
        return d
    }

    public static func makeEncoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatDateTime(date))
        }
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }

    /// "2026-09-26T06:00:00Z" / "2026-09-26T06:00:00.123Z" / "+09:00" オフセット付きを解析
    public static func parseDateTime(_ raw: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: raw) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }

    /// 秒未満がある場合のみミリ秒を付ける（端末で記録した時刻の精度を保つ）
    public static func formatDateTime(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        let t = date.timeIntervalSince1970
        let hasFraction = abs(t - t.rounded(.down)) >= 0.0005
        f.formatOptions = hasFraction ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: date)
    }
}
