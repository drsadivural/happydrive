import SwiftUI
import HappyDriveCore

// MARK: - 色調

extension StatusTone {
    var foreground: Color {
        switch self {
        case .neutral: return HDColor.textSecondary
        case .info: return HDColor.brandBlue
        case .success, .job: return HDColor.jobGreen
        case .warning: return HDColor.warning
        case .danger: return HDColor.danger
        }
    }

    var background: Color {
        switch self {
        case .neutral: return HDColor.border.opacity(0.5)
        case .info: return HDColor.brandBlueSoft
        case .success, .job: return HDColor.jobGreenSoft
        case .warning: return HDColor.warning.opacity(0.15)
        case .danger: return HDColor.danger.opacity(0.12)
        }
    }
}

extension JobCategory {
    var color: Color { HDCategoryStyle.style(for: rawValue).color }
}

// MARK: - カード

struct HDCard<Content: View>: View {
    var padding: CGFloat = HDSpacing.lg
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: HDSpacing.sm) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(padding)
        .background(HDColor.surface, in: RoundedRectangle(cornerRadius: HDRadius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: HDRadius.card, style: .continuous)
                .stroke(HDColor.border, lineWidth: 1)
        )
    }
}

/// 塗りつぶしの強調カード（本日の予定・今月の報酬・案件ヘッダー）
struct HDHeroCard<Content: View>: View {
    var color: Color = HDColor.brandBlue
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: HDSpacing.sm) {
            content
        }
        .foregroundStyle(HDColor.onBrand)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HDSpacing.lg + 4)
        .background(color, in: RoundedRectangle(cornerRadius: HDRadius.card, style: .continuous))
    }
}

struct SectionTitle: View {
    let title: String
    var trailing: AnyView? = nil

    init(_ title: String, trailing: AnyView? = nil) {
        self.title = title
        self.trailing = trailing
    }

    var body: some View {
        HStack {
            Text(title)
                .font(.hd(.title3, .bold))
                .foregroundStyle(HDColor.textPrimary)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            if let trailing { trailing }
        }
        .padding(.top, HDSpacing.sm)
    }
}

// MARK: - ボタン

struct HDPrimaryButtonStyle: ButtonStyle {
    var color: Color = HDColor.brandBlue
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.hd(.headline, .semibold))
            .multilineTextAlignment(.center)
            .foregroundStyle(HDColor.onBrand)
            .frame(maxWidth: .infinity, minHeight: 52)
            .padding(.horizontal, HDSpacing.md)
            .background(
                (isEnabled ? color : HDColor.textSecondary.opacity(0.5))
                    .opacity(configuration.isPressed ? 0.8 : 1),
                in: RoundedRectangle(cornerRadius: HDRadius.button, style: .continuous)
            )
            .contentShape(Rectangle())
    }
}

struct HDSecondaryButtonStyle: ButtonStyle {
    var color: Color = HDColor.brandBlue
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.hd(.headline, .semibold))
            .multilineTextAlignment(.center)
            .foregroundStyle(isEnabled ? color : HDColor.textSecondary)
            .frame(maxWidth: .infinity, minHeight: 48)
            .padding(.horizontal, HDSpacing.md)
            .background(
                HDColor.brandBlueSoft.opacity(configuration.isPressed ? 0.7 : 1),
                in: RoundedRectangle(cornerRadius: HDRadius.button, style: .continuous)
            )
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == HDPrimaryButtonStyle {
    static var hdPrimary: HDPrimaryButtonStyle { HDPrimaryButtonStyle() }
    static var hdJob: HDPrimaryButtonStyle { HDPrimaryButtonStyle(color: HDColor.jobGreen) }
    static var hdDanger: HDPrimaryButtonStyle { HDPrimaryButtonStyle(color: HDColor.danger) }
}

extension ButtonStyle where Self == HDSecondaryButtonStyle {
    static var hdSecondary: HDSecondaryButtonStyle { HDSecondaryButtonStyle() }
}

/// 送信中はスピナーを出すボタン内容
struct ProgressLabel: View {
    let title: String
    var systemImage: String? = nil
    var isLoading: Bool

    var body: some View {
        HStack(spacing: HDSpacing.sm) {
            if isLoading {
                ProgressView().tint(.white)
            } else if let systemImage {
                Image(systemName: systemImage).accessibilityHidden(true)
            }
            Text(title)
        }
    }
}

// MARK: - 状態表示（色だけに頼らずアイコン + 文字）

struct StatusBadge: View {
    let presentation: StatusPresentation
    var compact = false

    var body: some View {
        Label {
            Text(presentation.label)
        } icon: {
            Image(systemName: presentation.symbol)
                .accessibilityHidden(true)
        }
        .font(.hd(compact ? .caption : .subheadline, .semibold))
        .foregroundStyle(presentation.tone.foreground)
        .padding(.horizontal, HDSpacing.md)
        .padding(.vertical, HDSpacing.xs + 2)
        .background(presentation.tone.background, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("状態: \(presentation.label)")
    }
}

/// 金額ピル（案件は緑）
struct PricePill: View {
    let amountYen: Int
    var color: Color = HDColor.jobGreen

    var body: some View {
        Text(HDFormat.yen(amountYen))
            .font(.hd(.headline, .bold))
            .foregroundStyle(HDColor.onBrand)
            .padding(.horizontal, HDSpacing.lg)
            .frame(minHeight: 36)
            .background(color, in: Capsule())
            .accessibilityLabel("報酬 \(HDFormat.yenSpoken(amountYen))")
    }
}

struct CategoryTag: View {
    let category: JobCategory

    var body: some View {
        Label(category.label, systemImage: category.symbol)
            .font(.hd(.caption, .semibold))
            .foregroundStyle(category.color)
            .padding(.horizontal, HDSpacing.sm)
            .padding(.vertical, 4)
            .background(category.color.opacity(0.12), in: Capsule())
            .accessibilityLabel("カテゴリ \(category.label)")
    }
}

struct ChipButton: View {
    let title: String
    let isSelected: Bool
    var color: Color = HDColor.brandBlue
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.hd(.subheadline, .semibold))
                .foregroundStyle(isSelected ? HDColor.onBrand : color)
                .padding(.horizontal, HDSpacing.lg)
                .frame(minHeight: 44)
                .background(isSelected ? color : color.opacity(0.1), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct InfoRow: View {
    let title: String
    let value: String
    var systemImage: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: HDSpacing.sm) {
            if let systemImage {
                Image(systemName: systemImage)
                    .foregroundStyle(HDColor.textSecondary)
                    .frame(width: 20)
                    .accessibilityHidden(true)
            }
            Text(title)
                .font(.hd(.subheadline))
                .foregroundStyle(HDColor.textSecondary)
            Spacer(minLength: HDSpacing.sm)
            Text(value)
                .font(.hd(.subheadline, .medium))
                .foregroundStyle(HDColor.textPrimary)
                .multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

/// 注意書き（警告・情報）
struct NoticeBox: View {
    enum Kind { case info, warning, danger, success }
    let kind: Kind
    let text: String

    private var tone: StatusTone {
        switch kind {
        case .info: return .info
        case .warning: return .warning
        case .danger: return .danger
        case .success: return .success
        }
    }

    private var symbol: String {
        switch kind {
        case .info: return "info.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .danger: return "exclamationmark.octagon.fill"
        case .success: return "checkmark.circle.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: HDSpacing.sm) {
            Image(systemName: symbol)
                .foregroundStyle(tone.foreground)
                .accessibilityHidden(true)
            Text(text)
                .font(.hd(.subheadline))
                .foregroundStyle(HDColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(HDSpacing.md)
        .background(tone.background, in: RoundedRectangle(cornerRadius: HDRadius.button, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// ワードマーク（権利者提供の正式ロゴに差し替えるまで参照画像を使用）
struct Wordmark: View {
    var height: CGFloat = 44

    var body: some View {
        Image("Wordmark")
            .resizable()
            .scaledToFit()
            .frame(height: height)
            .accessibilityLabel("HappyDrive")
    }
}

/// アイコンボタン（通知ベルなど。44pt 以上のタップ領域）
struct IconBadgeButton: View {
    let systemImage: String
    let label: String
    var badge: Int = 0
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: systemImage)
                    .font(.title2)
                    .foregroundStyle(HDColor.textPrimary)
                    .frame(width: 44, height: 44)
                if badge > 0 {
                    Text(badge > 99 ? "99+" : "\(badge)")
                        .font(.hd(.caption2, .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 20, minHeight: 20)
                        .background(HDColor.danger, in: Capsule())
                        .offset(x: 4, y: -2)
                }
            }
        }
        .accessibilityLabel(badge > 0 ? "\(label)、未読\(badge)件" : label)
    }
}

extension View {
    /// 画面背景
    func hdScreenBackground() -> some View {
        background(HDColor.background.ignoresSafeArea())
    }
}
