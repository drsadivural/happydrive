import Foundation

public enum CSVError: Error, Sendable, Equatable {
    case unterminatedQuote(line: Int)
    case empty
}

/// RFC 4180 準拠の CSV 解析・生成
public enum CSV {
    /// CSV 文字列を行×列に分解。BOM・CRLF/LF/CR・引用符内の改行と "" エスケープに対応。空行は除く。
    public static func parse(_ text: String) throws -> [[String]] {
        var input = text
        if input.hasPrefix("\u{FEFF}") { input.removeFirst() }

        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var inQuotes = false
        var fieldWasQuoted = false
        var line = 1
        var quoteStartLine = 1

        let iterator = Array(input.unicodeScalars)
        var i = 0
        func endField() {
            row.append(fieldWasQuoted ? field : field.trimmingCharacters(in: .whitespaces))
            field = ""
            fieldWasQuoted = false
        }
        func endRow() {
            endField()
            if !(row.count == 1 && row[0].isEmpty) { rows.append(row) }
            row = []
        }

        while i < iterator.count {
            let c = iterator[i]
            if inQuotes {
                if c == "\"" {
                    if i + 1 < iterator.count && iterator[i + 1] == "\"" {
                        field.unicodeScalars.append("\"")
                        i += 1
                    } else {
                        inQuotes = false
                    }
                } else {
                    if c == "\n" { line += 1 }
                    field.unicodeScalars.append(c)
                }
            } else {
                switch c {
                case "\"":
                    if field.trimmingCharacters(in: .whitespaces).isEmpty {
                        field = ""
                        inQuotes = true
                        fieldWasQuoted = true
                        quoteStartLine = line
                    } else {
                        field.unicodeScalars.append(c)
                    }
                case ",":
                    endField()
                case "\r":
                    endRow()
                    if i + 1 < iterator.count && iterator[i + 1] == "\n" { i += 1 }
                    line += 1
                case "\n":
                    endRow()
                    line += 1
                default:
                    field.unicodeScalars.append(c)
                }
            }
            i += 1
        }
        if inQuotes { throw CSVError.unterminatedQuote(line: quoteStartLine) }
        if !field.isEmpty || !row.isEmpty || fieldWasQuoted { endRow() }
        return rows
    }

    /// 1 フィールドのエスケープ（, " 改行 を含む場合は引用符で囲む）
    public static func escape(_ field: String) -> String {
        if field.contains(where: { $0 == "," || $0 == "\"" || $0 == "\n" || $0 == "\r" }) || field.hasPrefix(" ") || field.hasSuffix(" ") {
            return "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        return field
    }

    /// 行×列から CSV 文字列を生成（改行は CRLF でなく LF。UTF-8 で送信する）
    public static func build(header: [String], rows: [[String]]) -> String {
        var lines = [header.map(escape).joined(separator: ",")]
        for r in rows { lines.append(r.map(escape).joined(separator: ",")) }
        return lines.joined(separator: "\n") + "\n"
    }

    /// ファイルの文字コードを判定して文字列化（UTF-8 → Shift_JIS の順に試す）
    public static func decode(_ data: Data) -> String? {
        if let s = String(data: data, encoding: .utf8) { return s }
        #if canImport(Darwin)
        if let s = String(data: data, encoding: .shiftJIS) { return s }
        #endif
        return nil
    }
}

/// 配送先 CSV（契約 /delivery/stops/import の列定義）の端末内検証。
/// サーバーの dryRun 結果が正であり、これは取込前に明らかな誤りを知らせるための事前確認。
public enum StopCSV {
    public static let columns = ["address", "latitude", "longitude", "time_start", "time_end", "priority", "service_minutes", "recipient_name", "recipient_phone", "package_number", "note"]

    /// 日本語見出しの別名（Excel 等で作った表を受け付ける）
    static let aliases: [String: String] = [
        "住所": "address", "配達先住所": "address",
        "緯度": "latitude", "経度": "longitude",
        "開始時刻": "time_start", "指定開始": "time_start", "終了時刻": "time_end", "指定終了": "time_end",
        "優先度": "priority", "作業時間": "service_minutes", "作業分": "service_minutes",
        "受取人": "recipient_name", "受取人名": "recipient_name", "電話番号": "recipient_phone", "受取人電話": "recipient_phone",
        "荷物番号": "package_number", "伝票番号": "package_number", "メモ": "note", "備考": "note",
    ]

    public struct Row: Sendable, Hashable {
        /// データ行番号（見出しを 1 行目とした行番号。サーバーの row と同じ数え方）
        public var row: Int
        public var address: String
        public var values: [String: String]
    }

    public struct Issue: Sendable, Hashable {
        public var row: Int
        public var message: String
    }

    public struct Preview: Sendable, Hashable {
        public var rows: [Row]
        public var errors: [Issue]
        /// 同じファイル内の住所重複（row → 先に出現した row）
        public var localDuplicates: [Int: Int]
        /// サーバーへ送る正規化済み CSV（英語見出し）
        public var normalizedCSV: String

        public var validCount: Int { rows.count - Set(errors.map(\.row)).intersection(rows.map(\.row)).count }
    }

    public static func normalizeHeader(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let alias = aliases[trimmed] { return alias }
        return trimmed.lowercased().replacingOccurrences(of: " ", with: "_")
    }

    public static func preview(_ text: String) throws -> Preview {
        let table = try CSV.parse(text)
        guard let headerRow = table.first else { throw CSVError.empty }
        let header = headerRow.map(normalizeHeader)
        var errors: [Issue] = []
        guard header.contains("address") else {
            return Preview(rows: [], errors: [Issue(row: 1, message: "見出し行に address（住所）列がありません")], localDuplicates: [:], normalizedCSV: "")
        }
        let unknown = header.filter { !$0.isEmpty && !columns.contains($0) }
        if !unknown.isEmpty {
            errors.append(Issue(row: 1, message: "使用しない列があります: \(unknown.joined(separator: "、"))"))
        }

        var rows: [Row] = []
        var seen: [String: Int] = [:]
        var duplicates: [Int: Int] = [:]
        for (offset, raw) in table.dropFirst().enumerated() {
            let rowNumber = offset + 2
            var values: [String: String] = [:]
            for (i, name) in header.enumerated() where columns.contains(name) {
                values[name] = i < raw.count ? raw[i] : ""
            }
            if raw.count > header.count, raw[header.count...].contains(where: { !$0.isEmpty }) {
                errors.append(Issue(row: rowNumber, message: "列の数が見出しより多くなっています"))
            }
            let address = values["address"] ?? ""
            rows.append(Row(row: rowNumber, address: address, values: values))
            errors.append(contentsOf: validate(values, row: rowNumber))

            let key = AddressNormalizer.key(address)
            if !key.isEmpty {
                if let first = seen[key] { duplicates[rowNumber] = first } else { seen[key] = rowNumber }
            }
        }
        let normalized = CSV.build(header: columns, rows: rows.map { r in columns.map { r.values[$0] ?? "" } })
        return Preview(rows: rows, errors: errors, localDuplicates: duplicates, normalizedCSV: normalized)
    }

    static func validate(_ v: [String: String], row: Int) -> [Issue] {
        var issues: [Issue] = []
        let address = v["address"] ?? ""
        if address.count < 4 { issues.append(Issue(row: row, message: "住所が空欄または短すぎます")) }
        if address.count > 200 { issues.append(Issue(row: row, message: "住所が200文字を超えています")) }

        let lat = v["latitude"] ?? "", lon = v["longitude"] ?? ""
        if lat.isEmpty != lon.isEmpty {
            issues.append(Issue(row: row, message: "緯度と経度は両方入力してください"))
        } else if !lat.isEmpty {
            if let la = Double(lat), let lo = Double(lon), (-90...90).contains(la), (-180...180).contains(lo) {
                // OK
            } else {
                issues.append(Issue(row: row, message: "緯度・経度が正しくありません"))
            }
        }
        let start = v["time_start"] ?? "", end = v["time_end"] ?? ""
        let startMin = start.isEmpty ? nil : Validation.minutesFromHHMM(start)
        let endMin = end.isEmpty ? nil : Validation.minutesFromHHMM(end)
        if !start.isEmpty && startMin == nil { issues.append(Issue(row: row, message: "time_start は HH:MM 形式で入力してください")) }
        if !end.isEmpty && endMin == nil { issues.append(Issue(row: row, message: "time_end は HH:MM 形式で入力してください")) }
        if let s = startMin, let e = endMin, e <= s { issues.append(Issue(row: row, message: "指定時間の終了が開始より前です")) }

        if let p = v["priority"], !p.isEmpty {
            if let n = Int(p), (0...2).contains(n) {} else { issues.append(Issue(row: row, message: "priority は 0〜2 で入力してください")) }
        }
        if let m = v["service_minutes"], !m.isEmpty {
            if let n = Int(m), (0...120).contains(n) {} else { issues.append(Issue(row: row, message: "service_minutes は 0〜120 で入力してください")) }
        }
        if let phone = v["recipient_phone"], !phone.isEmpty, !Validation.isRecipientPhone(phone) {
            issues.append(Issue(row: row, message: "電話番号の形式が正しくありません"))
        }
        return issues
    }

    /// 取込用テンプレート
    public static var template: String {
        CSV.build(header: columns, rows: [])
    }
}

/// 住所の重複判定用キー（全角英数→半角、空白・ハイフン類の統一）
public enum AddressNormalizer {
    public static func key(_ address: String) -> String {
        let s = Validation.toHalfwidthASCII(address).lowercased()
        let dashes: Set<Character> = ["-", "‐", "‑", "–", "—", "−", "ー", "ｰ", "－"]
        var out = ""
        for ch in s {
            if ch.isWhitespace { continue }
            if dashes.contains(ch) {
                // 数字の間のハイフン類のみ統一（カタカナの長音は残す）
                if let last = out.last, last.isNumber { out.append("-"); continue }
                if ch == "ー" || ch == "ｰ" { out.append(ch); continue }
                out.append("-")
                continue
            }
            out.append(ch)
        }
        for suffix in ["丁目", "番地", "番", "号"] {
            out = out.replacingOccurrences(of: suffix, with: "-")
        }
        while out.contains("--") { out = out.replacingOccurrences(of: "--", with: "-") }
        while out.hasSuffix("-") { out.removeLast() }
        return out
    }
}
