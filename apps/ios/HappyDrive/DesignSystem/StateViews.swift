import SwiftUI
import HappyDriveCore

/// 画面の読込状態
enum LoadState<Value> {
    case idle
    case loading
    case loaded(Value)
    case failed(String)

    var value: Value? {
        if case .loaded(let v) = self { return v }
        return nil
    }

    var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }

    var errorMessage: String? {
        if case .failed(let m) = self { return m }
        return nil
    }
}

struct LoadingStateView: View {
    var message = "読み込み中…"

    var body: some View {
        VStack(spacing: HDSpacing.md) {
            ProgressView()
            Text(message)
                .font(.hd(.subheadline))
                .foregroundStyle(HDColor.textSecondary)
        }
        .frame(maxWidth: .infinity, minHeight: 160)
        .accessibilityElement(children: .combine)
    }
}

struct ErrorStateView: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label("読み込めませんでした", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            if let retry {
                Button("再試行", action: retry)
                    .buttonStyle(.borderedProminent)
                    .frame(minHeight: 44)
            }
        }
    }
}

struct EmptyStateView: View {
    let title: String
    let systemImage: String
    var message: String? = nil

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            if let message { Text(message) }
        }
    }
}

/// LoadState に応じて 読込中 / 失敗+再試行 / 内容 を出し分ける
struct LoadStateContainer<Value, Content: View>: View {
    let state: LoadState<Value>
    let retry: () -> Void
    @ViewBuilder let content: (Value) -> Content

    var body: some View {
        switch state {
        case .idle, .loading:
            LoadingStateView()
        case .failed(let message):
            ErrorStateView(message: message, retry: retry)
        case .loaded(let value):
            content(value)
        }
    }
}

/// 圏外バナー（送信待ちの件数も表示）
struct OfflineBanner: View {
    let isOnline: Bool
    let pendingCount: Int

    var body: some View {
        if !isOnline || pendingCount > 0 {
            HStack(spacing: HDSpacing.sm) {
                Image(systemName: isOnline ? "arrow.triangle.2.circlepath" : "wifi.slash")
                    .accessibilityHidden(true)
                Text(text)
                    .font(.hd(.footnote, .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .foregroundStyle(HDColor.onBrand)
            .padding(.horizontal, HDSpacing.lg)
            .padding(.vertical, HDSpacing.sm)
            .background(isOnline ? HDColor.brandBlue : HDColor.navy)
            .accessibilityElement(children: .combine)
        }
    }

    private var text: String {
        if !isOnline {
            return pendingCount > 0
                ? "圏外です。送信待ち\(pendingCount)件は通信が回復すると自動で送信します。"
                : "圏外です。表示は最後に取得した情報です。"
        }
        return "送信待ちの操作が\(pendingCount)件あります。順番に送信しています。"
    }
}

/// 運転中の操作抑止
struct DrivingLockModifier: ViewModifier {
    let isDriving: Bool

    func body(content: Content) -> some View {
        content
            .disabled(isDriving)
            .overlay(alignment: .top) {
                if isDriving {
                    Label(DrivingSafetyState.lockMessage, systemImage: "car.fill")
                        .font(.hd(.subheadline, .bold))
                        .foregroundStyle(HDColor.onBrand)
                        .padding(HDSpacing.md)
                        .frame(maxWidth: .infinity)
                        .background(HDColor.warning, in: RoundedRectangle(cornerRadius: HDRadius.button))
                        .padding(HDSpacing.sm)
                        .accessibilityAddTraits(.isStaticText)
                }
            }
    }
}

extension View {
    func drivingLocked(_ isDriving: Bool) -> some View {
        modifier(DrivingLockModifier(isDriving: isDriving))
    }
}

/// 権限が拒否されている場合の案内（設定アプリへのリンク付き）
struct PermissionDeniedView: View {
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: HDSpacing.sm) {
            Label(title, systemImage: "location.slash")
                .font(.hd(.headline, .bold))
            Text(message)
                .font(.hd(.subheadline))
                .foregroundStyle(HDColor.textSecondary)
            Button("設定を開く") { SystemSettings.open() }
                .buttonStyle(.hdSecondary)
        }
        .padding(HDSpacing.lg)
        .background(HDColor.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: HDRadius.card))
    }
}

/// エラーをアラートで表示するための小さな型
struct AlertMessage: Identifiable {
    let id = UUID()
    let title: String
    let message: String

    init(title: String = "エラー", message: String) {
        self.title = title
        self.message = message
    }

    init(error: Error) {
        self.title = "エラー"
        self.message = error.hdUserMessage
    }
}

extension View {
    func hdAlert(_ item: Binding<AlertMessage?>) -> some View {
        alert(
            item.wrappedValue?.title ?? "エラー",
            isPresented: Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } }),
            presenting: item.wrappedValue
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { a in
            Text(a.message)
        }
    }
}
