import SwiftUI
import HappyDriveCore

/// 会話の文字起こし（ストリーミングで更新）。
/// 最下部を見ている間は自動で最新へスクロールし、上へ戻って読んでいる間は動かさずに「最新へ」を出す。
struct VoiceTranscriptView: View {
    let items: [VoiceTranscriptItem]

    @State private var isAtBottom = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let bottomID = "voice-transcript-bottom"

    /// 最後の発話の文字数も含めて変化を検知する（ストリーミング中の追従）
    private var changeKey: String {
        guard let last = items.last else { return "empty" }
        return "\(items.count)-\(last.id)-\(last.text.count)-\(last.isFinal)"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: HDSpacing.md) {
                    ForEach(items) { item in
                        VoiceTranscriptBubble(item: item)
                            .id(item.id)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomID)
                        .onAppear { isAtBottom = true }
                        .onDisappear { isAtBottom = false }
                }
                .padding(.horizontal, HDSpacing.lg)
                .padding(.vertical, HDSpacing.md)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: changeKey) { _, _ in
                guard isAtBottom else { return }
                scrollToBottom(proxy, animated: false)
            }
            .onAppear { scrollToBottom(proxy, animated: false) }
            .overlay(alignment: .bottomTrailing) {
                if !isAtBottom && !items.isEmpty {
                    Button {
                        scrollToBottom(proxy, animated: true)
                    } label: {
                        Label("最新へ", systemImage: "arrow.down")
                            .font(.hd(.subheadline, .semibold))
                            .foregroundStyle(HDColor.onBrand)
                            .padding(.horizontal, HDSpacing.lg)
                            .frame(minHeight: 44)
                            .background(HDColor.brandBlue, in: Capsule())
                            .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
                    }
                    .buttonStyle(.plain)
                    .padding(HDSpacing.lg)
                    .accessibilityIdentifier("voiceJumpToLatestButton")
                    .accessibilityHint("最新の発言まで移動します")
                    .transition(.opacity)
                }
            }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        if animated && !reduceMotion {
            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
        } else {
            proxy.scrollTo(Self.bottomID, anchor: .bottom)
        }
    }
}

/// 1 発話の吹き出し（あなた / AI のラベル付き）
struct VoiceTranscriptBubble: View {
    let item: VoiceTranscriptItem

    private var isUser: Bool { item.role == .user }

    private var displayText: String {
        let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty && isUser { return "聞き取り中…" }
        return text
    }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: HDSpacing.xs) {
            HStack(spacing: HDSpacing.xs) {
                Image(systemName: isUser ? (item.source == .text ? "keyboard" : "person.fill") : "sparkles")
                    .accessibilityHidden(true)
                Text(item.role.label)
            }
            .font(.hd(.caption, .semibold))
            .foregroundStyle(HDColor.textSecondary)

            Text(displayText)
                .font(.hd(.body))
                .foregroundStyle(isUser ? HDColor.onBrand : HDColor.textPrimary)
                .italic(item.text.isEmpty)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, HDSpacing.md)
                .padding(.vertical, HDSpacing.sm + 2)
                .background(
                    isUser ? AnyShapeStyle(HDColor.brandBlue) : AnyShapeStyle(HDColor.surface),
                    in: RoundedRectangle(cornerRadius: HDRadius.card, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: HDRadius.card, style: .continuous)
                        .stroke(isUser ? Color.clear : HDColor.border, lineWidth: 1)
                )

            if item.interrupted {
                Label("途中で止めました", systemImage: "hand.raised.fill")
                    .font(.hd(.caption))
                    .foregroundStyle(HDColor.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        .padding(isUser ? .leading : .trailing, HDSpacing.xxl)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var s = "\(item.role.label): \(displayText)"
        if item.interrupted { s += "（途中で止めました）" }
        return s
    }
}
