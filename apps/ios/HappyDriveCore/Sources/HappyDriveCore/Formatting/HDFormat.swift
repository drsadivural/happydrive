import Foundation

/// 表示用の書式。時刻は JST、金額は整数円。端末の地域設定に依存しないよう手組みで整形する。
public enum HDFormat {
    public static let jst: TimeZone = TimeZone(identifier: "Asia/Tokyo") ?? TimeZone(secondsFromGMT: 9 * 3600)!

    public static var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = jst
        c.locale = Locale(identifier: "ja_JP")
        return c
    }

    static let weekdays = ["日", "月", "火", "水", "木", "金", "土"]

    // MARK: 金額

    /// 12345 → "¥12,345"、-500 → "-¥500"
    public static func yen(_ amount: Int) -> String {
        let sign = amount < 0 ? "-" : ""
        return "\(sign)¥\(grouped(abs(amount)))"
    }

    /// 3 桁区切り
    public static func grouped(_ value: Int) -> String {
        let digits = Array(String(value))
        var out = ""
        for (i, d) in digits.enumerated() {
            if i > 0 && (digits.count - i) % 3 == 0 { out.append(",") }
            out.append(d)
        }
        return out
    }

    /// VoiceOver 用（"12,345円"）
    public static func yenSpoken(_ amount: Int) -> String {
        (amount < 0 ? "マイナス" : "") + "\(grouped(abs(amount)))円"
    }

    // MARK: 時間・期間

    /// 分 → "30分" / "1時間" / "4時間20分"
    public static func duration(minutes: Int) -> String {
        let m = max(0, minutes)
        if m < 60 { return "\(m)分" }
        let h = m / 60, r = m % 60
        return r == 0 ? "\(h)時間" : "\(h)時間\(r)分"
    }

    /// 秒 → "0:45" 形式（再送信までの残り等）
    public static func countdown(seconds: Int) -> String {
        let s = max(0, seconds)
        return "\(s / 60):" + (s % 60 < 10 ? "0" : "") + "\(s % 60)"
    }

    public static func distance(km: Double) -> String {
        if km < 0 { return "-" }
        return String(format: "%.1f km", km)
    }

    /// 2 点間を VoiceOver でも自然に読める形（"残り 350m"）
    public static func meters(_ m: Double) -> String {
        if m >= 1000 { return String(format: "%.1f km", m / 1000) }
        return "\(Int(m.rounded()))m"
    }

    // MARK: 日時（JST）

    public static func components(_ date: Date) -> DateComponents {
        calendar.dateComponents([.year, .month, .day, .hour, .minute, .weekday], from: date)
    }

    /// "15:00"
    public static func time(_ date: Date) -> String {
        let c = components(date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// "15:00–15:30"
    public static func timeRange(_ start: Date, _ end: Date) -> String {
        "\(time(start))–\(time(end))"
    }

    /// "9月26日(土)"
    public static func monthDay(_ date: Date) -> String {
        let c = components(date)
        let w = weekdays[((c.weekday ?? 1) - 1) % 7]
        return "\(c.month ?? 0)月\(c.day ?? 0)日(\(w))"
    }

    /// "2026年9月26日(土)"
    public static func fullDate(_ date: Date) -> String {
        let c = components(date)
        return "\(c.year ?? 0)年" + monthDay(date)
    }

    /// "2026/09/26 15:00"
    public static func dateTime(_ date: Date) -> String {
        let c = components(date)
        return String(format: "%04d/%02d/%02d %02d:%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0)
    }

    /// "本日 15:00" / "明日 10:00" / "昨日 9:00" / "9月28日(月) 10:00"
    public static func relativeDayTime(_ date: Date, now: Date = Date()) -> String {
        "\(relativeDay(date, now: now)) \(time(date))"
    }

    public static func relativeDay(_ date: Date, now: Date = Date()) -> String {
        let cal = calendar
        let d0 = cal.startOfDay(for: now)
        let d1 = cal.startOfDay(for: date)
        let days = cal.dateComponents([.day], from: d0, to: d1).day ?? 0
        switch days {
        case 0: return "本日"
        case 1: return "明日"
        case -1: return "昨日"
        default: return monthDay(date)
        }
    }

    /// 案件の時間帯表示: "本日 15:00–15:30"
    public static func schedule(_ start: Date, _ end: Date, now: Date = Date()) -> String {
        "\(relativeDay(start, now: now)) \(timeRange(start, end))"
    }

    // MARK: API 用の暦日（format: date）

    /// JST の暦日 "2026-09-26"
    public static func apiDate(_ date: Date) -> CalendarDateString {
        let c = components(date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// "2026-09-26" → その日の JST 0 時
    public static func parseAPIDate(_ s: CalendarDateString) -> Date? {
        let parts = s.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var c = DateComponents()
        c.year = parts[0]; c.month = parts[1]; c.day = parts[2]
        c.timeZone = jst
        return calendar.date(from: c)
    }

    /// "2026-09-26" → "9月26日(土)"
    public static func displayAPIDate(_ s: CalendarDateString?) -> String {
        guard let s, let d = parseAPIDate(s) else { return "-" }
        return monthDay(d)
    }

    /// JST の年月 "2026-09"
    public static func apiMonth(_ date: Date) -> String {
        let c = components(date)
        return String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
    }

    /// "2026-09" → "2026年9月"
    public static func displayMonth(_ month: String) -> String {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2 else { return month }
        return "\(parts[0])年\(parts[1])月"
    }

    /// 前後の月（"2026-01", -1 → "2025-12"）
    public static func shiftMonth(_ month: String, by delta: Int) -> String {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2 else { return month }
        var total = parts[0] * 12 + (parts[1] - 1) + delta
        if total < 0 { total = 0 }
        return String(format: "%04d-%02d", total / 12, total % 12 + 1)
    }

    /// その暦日（JST）の指定時刻の Date（"HH:MM" 入力から時間枠を作る）
    public static func date(on day: CalendarDateString, hour: Int, minute: Int) -> Date? {
        guard let base = parseAPIDate(day) else { return nil }
        return calendar.date(byAdding: .minute, value: hour * 60 + minute, to: base)
    }

    /// 時刻帯の挨拶（ホーム見出し）
    public static func greeting(now: Date = Date()) -> String {
        let h = components(now).hour ?? 12
        switch h {
        case 4..<11: return "おはようございます"
        case 11..<18: return "こんにちは"
        default: return "こんばんは"
        }
    }
}
