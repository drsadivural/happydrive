import Foundation

/// 入力検証（契約の pattern と一致させる）
public enum Validation {
    /// 全角英数字・記号（U+FF01〜U+FF5E）と全角空白を半角に
    public static func toHalfwidthASCII(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for u in s.unicodeScalars {
            if (0xFF01...0xFF5E).contains(u.value), let h = Unicode.Scalar(u.value - 0xFEE0) {
                out.append(h)
            } else if u.value == 0x3000 {
                out.append(" ")
            } else {
                out.append(u)
            }
        }
        return String(out)
    }

    /// 電話番号を契約形式（^(\+81|0)[0-9]{9,10}$）に正規化。空白・ハイフン・括弧を除去。
    public static func normalizePhone(_ raw: String) -> String {
        let half = toHalfwidthASCII(raw)
        return String(half.filter { $0.isASCII && ($0.isNumber || $0 == "+") })
    }

    public static func isValidPhone(_ normalized: String) -> Bool {
        matches(normalized, #"^(\+81|0)[0-9]{9,10}$"#)
    }

    /// 配送先受取人の電話（契約 NewStop.recipientPhone）
    public static func isRecipientPhone(_ raw: String) -> Bool {
        matches(raw, #"^[0-9+\-]{10,15}$"#)
    }

    public static func isValidOTP(_ code: String) -> Bool {
        matches(code, #"^[0-9]{6}$"#)
    }

    /// OTP 入力欄の整形（全角→半角、数字以外除去、6 桁まで）
    public static func sanitizeOTP(_ raw: String) -> String {
        String(toHalfwidthASCII(raw).filter { $0.isASCII && $0.isNumber }.prefix(6))
    }

    /// ひらがなをカタカナへ（フリガナ入力の補助）
    public static func hiraganaToKatakana(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for u in s.unicodeScalars {
            if (0x3041...0x3096).contains(u.value), let k = Unicode.Scalar(u.value + 0x60) {
                out.append(k)
            } else {
                out.append(u)
            }
        }
        return String(out)
    }

    /// 契約 ProfileInput.legalNameKana: ^[ァ-ヶー　 ]+$
    public static func isKatakanaName(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 100 && matches(s, "^[ァ-ヶー　 ]+$")
    }

    /// 契約 BankAccountInput.holderNameKana: ^[ァ-ヶー　 ()（）.．]+$
    public static func isBankHolderKana(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 60 && matches(s, "^[ァ-ヶー　 ()（）.．]+$")
    }

    public static func isPostalCode(_ s: String) -> Bool {
        matches(s, #"^[0-9]{3}-?[0-9]{4}$"#)
    }

    public static func isInvoiceNumber(_ s: String) -> Bool {
        matches(s, #"^T[0-9]{13}$"#)
    }

    public static func isBankCode(_ s: String) -> Bool { matches(s, #"^[0-9]{4}$"#) }
    public static func isBranchCode(_ s: String) -> Bool { matches(s, #"^[0-9]{3}$"#) }
    public static func isAccountNumber(_ s: String) -> Bool { matches(s, #"^[0-9]{7}$"#) }

    /// "HH:MM" → 0 時からの分（不正なら nil）
    public static func minutesFromHHMM(_ s: String) -> Int? {
        let parts = s.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count <= 2, parts[1].count == 2,
              let h = Int(parts[0]), let m = Int(parts[1]), (0...23).contains(h), (0...59).contains(m) else { return nil }
        return h * 60 + m
    }

    public static func matches(_ s: String, _ pattern: String) -> Bool {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return false }
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return re.firstMatch(in: s, options: [], range: range) != nil
    }
}
