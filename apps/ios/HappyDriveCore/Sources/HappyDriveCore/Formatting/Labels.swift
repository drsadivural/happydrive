import Foundation

/// 状態表示の色調（色だけで状態を伝えないよう、必ずラベルと SF Symbol と組み合わせる）
public enum StatusTone: String, Sendable {
    case neutral, info, success, warning, danger, job
}

/// 状態の表示（日本語ラベル + SF Symbols 名 + 色調）
public struct StatusPresentation: Sendable, Hashable {
    public var label: String
    public var symbol: String
    public var tone: StatusTone

    public init(_ label: String, _ symbol: String, _ tone: StatusTone) {
        self.label = label
        self.symbol = symbol
        self.tone = tone
    }
}

extension JobCategory {
    public var label: String {
        switch self {
        case .elderly_watch: return "高齢者見守り"
        case .life_support: return "生活支援"
        case .shopping_assist: return "買い物付き添い"
        case .corporate_task: return "企業依頼"
        case .community_info: return "地域情報"
        case .delivery_related: return "配送関連"
        case .personal_care: return "身体介護（要資格）"
        case .healthcare: return "医療関連（要資格）"
        case .unknown: return "その他"
        }
    }

    public var symbol: String {
        switch self {
        case .elderly_watch: return "person.2.fill"
        case .life_support: return "heart.fill"
        case .shopping_assist: return "cart.fill"
        case .corporate_task: return "building.2.fill"
        case .community_info: return "mappin.and.ellipse"
        case .delivery_related: return "shippingbox.fill"
        case .personal_care, .healthcare: return "cross.case.fill"
        case .unknown: return "briefcase.fill"
        }
    }
}

extension ContractType {
    /// 雇用と業務委託を明確に区別して表示する
    public var label: String {
        switch self {
        case .employment: return "雇用"
        case .contractor: return "業務委託"
        case .other_legal_review: return "その他（法務審査中）"
        case .unknown: return "契約区分不明"
        }
    }

    public var explanation: String {
        switch self {
        case .employment: return "発注者に雇用される短時間の仕事です。賃金は労働条件に従って支払われます。"
        case .contractor: return "発注者から業務を受託する契約です。報酬は取引条件に従って支払われます。"
        case .other_legal_review: return "契約区分を確認中のため受諾できません。"
        case .unknown: return "契約区分を確認できません。"
        }
    }

    public var presentation: StatusPresentation {
        switch self {
        case .employment: return StatusPresentation(label, "person.text.rectangle", .info)
        case .contractor: return StatusPresentation(label, "doc.text", .info)
        default: return StatusPresentation(label, "questionmark.circle", .warning)
        }
    }
}

extension AssignmentState {
    public var presentation: StatusPresentation {
        switch self {
        case .reserved: return StatusPresentation("仮予約（発注者の承認待ち）", "hourglass", .warning)
        case .accepted: return StatusPresentation("受諾済み", "checkmark.seal", .info)
        case .traveling: return StatusPresentation("移動中", "car.fill", .info)
        case .checked_in: return StatusPresentation("到着・チェックイン済み", "mappin.circle.fill", .info)
        case .working: return StatusPresentation("実行中", "figure.walk", .job)
        case .submitted: return StatusPresentation("報告済み（検収待ち）", "tray.and.arrow.up.fill", .info)
        case .needs_revision: return StatusPresentation("差戻し（再提出が必要）", "arrow.uturn.backward.circle", .warning)
        case .approved: return StatusPresentation("検収済み", "checkmark.circle.fill", .success)
        case .payable: return StatusPresentation("支払予定", "calendar.badge.clock", .success)
        case .paid: return StatusPresentation("振込済", "yensign.circle.fill", .success)
        case .cancelled: return StatusPresentation("キャンセル", "xmark.circle", .neutral)
        case .declined: return StatusPresentation("不承認", "xmark.octagon", .neutral)
        case .expired: return StatusPresentation("期限切れ", "clock.badge.xmark", .neutral)
        case .no_show: return StatusPresentation("無断欠勤として記録", "exclamationmark.triangle.fill", .danger)
        case .disputed: return StatusPresentation("運営が確認中", "exclamationmark.bubble", .warning)
        case .refunded: return StatusPresentation("返金済み", "arrow.uturn.left.circle", .neutral)
        case .unknown: return StatusPresentation("状態を確認中", "questionmark.circle", .neutral)
        }
    }
}

extension StopStatus {
    public var presentation: StatusPresentation {
        switch self {
        case .draft: return StatusPresentation("位置未確定", "mappin.slash", .warning)
        case .ready: return StatusPresentation("配達予定", "shippingbox", .neutral)
        case .en_route: return StatusPresentation("配達中", "car.fill", .info)
        case .arrived: return StatusPresentation("到着", "mappin.circle.fill", .info)
        case .delivered: return StatusPresentation("配達完了", "checkmark.circle.fill", .success)
        case .failed: return StatusPresentation("未配達", "xmark.circle.fill", .danger)
        case .deferred: return StatusPresentation("再配達", "arrow.uturn.right.circle", .warning)
        case .unknown: return StatusPresentation("状態を確認中", "questionmark.circle", .neutral)
        }
    }
}

extension EarningState {
    /// 報酬の状態。即時払いを示唆しない表現に限定する。
    public var presentation: StatusPresentation {
        switch self {
        case .estimated: return StatusPresentation("見込み", "clock", .neutral)
        case .pending: return StatusPresentation("確定待ち", "hourglass", .warning)
        case .payable: return StatusPresentation("支払予定", "calendar.badge.clock", .info)
        case .paid: return StatusPresentation("振込済", "checkmark.circle.fill", .success)
        case .failed: return StatusPresentation("振込失敗", "exclamationmark.triangle.fill", .danger)
        case .reversed: return StatusPresentation("取消", "arrow.uturn.left.circle", .neutral)
        case .unknown: return StatusPresentation("状態を確認中", "questionmark.circle", .neutral)
        }
    }

    public var explanation: String {
        switch self {
        case .estimated: return "受諾時の条件による見込み額です。検収後に確定します。"
        case .pending: return "発注者の検収・確認を待っています。"
        case .payable: return "確定しました。振込予定日に指定口座へ振り込まれます。"
        case .paid: return "指定口座へ振り込まれました。"
        case .failed: return "振込に失敗しました。口座情報を確認してください。運営が再振込を手配します。"
        case .reversed: return "取消・返金により減額されました。"
        case .unknown: return ""
        }
    }
}

extension PayoutStatus {
    public var presentation: StatusPresentation {
        switch self {
        case .requested: return StatusPresentation("振込予定", "calendar.badge.clock", .info)
        case .processing: return StatusPresentation("振込処理中", "arrow.triangle.2.circlepath", .info)
        case .paid: return StatusPresentation("振込済", "checkmark.circle.fill", .success)
        case .failed: return StatusPresentation("振込失敗", "exclamationmark.triangle.fill", .danger)
        case .unknown: return StatusPresentation("状態を確認中", "questionmark.circle", .neutral)
        }
    }
}

extension VerificationStatus {
    public var presentation: StatusPresentation {
        switch self {
        case .unsubmitted: return StatusPresentation("本人確認 未申請", "person.crop.circle.badge.questionmark", .warning)
        case .pending: return StatusPresentation("本人確認 審査中", "hourglass", .info)
        case .verified: return StatusPresentation("本人確認済み", "checkmark.shield.fill", .success)
        case .rejected: return StatusPresentation("本人確認 再提出が必要", "exclamationmark.shield.fill", .danger)
        case .unknown: return StatusPresentation("本人確認 状態不明", "questionmark.circle", .neutral)
        }
    }
}

extension SkillStatus {
    public var presentation: StatusPresentation {
        switch self {
        case .pending: return StatusPresentation("確認中", "hourglass", .info)
        case .verified: return StatusPresentation("有効", "checkmark.seal.fill", .success)
        case .rejected: return StatusPresentation("不承認", "xmark.seal", .danger)
        case .expired: return StatusPresentation("期限切れ", "clock.badge.xmark", .warning)
        case .unknown: return StatusPresentation("状態不明", "questionmark.circle", .neutral)
        }
    }
}

extension TicketStatus {
    public var presentation: StatusPresentation {
        switch self {
        case .open: return StatusPresentation("受付済み", "tray.fill", .info)
        case .answered: return StatusPresentation("回答あり", "text.bubble.fill", .success)
        case .closed: return StatusPresentation("完了", "checkmark.circle", .neutral)
        case .unknown: return StatusPresentation("状態不明", "questionmark.circle", .neutral)
        }
    }
}

extension FailureReason {
    public var label: String {
        switch self {
        case .absent: return "不在"
        case .address_unknown: return "住所不明"
        case .refused: return "受取拒否"
        case .damaged: return "破損"
        case .access_denied: return "立入不可（オートロック等）"
        case .time_window_missed: return "指定時間に間に合わない"
        case .other: return "その他"
        }
    }
}

extension HandoffType {
    public var label: String {
        switch self {
        case .in_person: return "手渡し"
        case .safe_place: return "置き配"
        case .delivery_box: return "宅配ボックス"
        case .neighbor: return "近隣の方へ預け"
        }
    }

    public var symbol: String {
        switch self {
        case .in_person: return "hand.raised.fill"
        case .safe_place: return "door.left.hand.closed"
        case .delivery_box: return "archivebox.fill"
        case .neighbor: return "person.2.fill"
        }
    }
}

extension VehicleType {
    public var label: String {
        switch self {
        case .kei_van: return "軽バン"
        case .kei_truck: return "軽トラック"
        case .car: return "乗用車"
        case .motorbike: return "バイク"
        case .bicycle: return "自転車"
        case .none: return "車両なし（徒歩等）"
        case .unknown: return "不明"
        }
    }
}

extension BankAccountType {
    public var label: String {
        switch self {
        case .ordinary: return "普通"
        case .checking: return "当座"
        case .savings: return "貯蓄"
        case .unknown: return "不明"
        }
    }
}

extension SupportCategory {
    public var label: String {
        switch self {
        case .account: return "アカウント"
        case .payment: return "報酬・振込"
        case .job: return "案件"
        case .delivery: return "配送"
        case .safety: return "安全"
        case .privacy: return "個人情報"
        case .other: return "その他"
        case .unknown: return "その他"
        }
    }
}

extension ReportReason {
    public var label: String {
        switch self {
        case .harassment: return "嫌がらせ"
        case .fraud: return "詐欺の疑い"
        case .unsafe: return "安全上の問題"
        case .illegal: return "違法な内容"
        case .spam: return "スパム"
        case .privacy: return "個人情報の問題"
        case .other: return "その他"
        }
    }
}

extension RouteViolationType {
    public var label: String {
        switch self {
        case .time_window_late: return "指定時間に遅れる見込み"
        case .break_unplaced: return "休憩を入れられません"
        case .priority_late: return "優先配達が遅れる見込み"
        case .unknown: return "制約違反"
        }
    }
}

extension JobSort {
    public var label: String {
        switch self {
        case .recommended: return "おすすめ順"
        case .distance: return "近い順"
        case .starts_at: return "開始が早い順"
        case .amount: return "報酬が高い順"
        }
    }
}

extension EvidencePurpose {
    public var label: String {
        switch self {
        case .work_photo: return "作業写真"
        case .delivery_photo: return "配達写真"
        case .signature: return "受領サイン"
        case .identity_document: return "本人確認書類"
        case .skill_document: return "資格証"
        case .message_attachment: return "メッセージ添付"
        }
    }
}

/// 優先度（0=通常 1=高 2=最優先）
public enum StopPriorityLabel {
    public static func label(_ p: Int) -> String {
        switch p {
        case 2: return "最優先"
        case 1: return "高"
        default: return "通常"
        }
    }
}
