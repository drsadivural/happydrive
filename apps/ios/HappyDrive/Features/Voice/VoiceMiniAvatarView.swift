import SwiftUI
import HappyDriveCore
import HappyAvatarKit

/// 音声会話を最小化している間、タブ画面（地図・ナビを含む）の上に出す小さなアバター。
/// - タップで全画面の音声画面に戻る。× で会話を終了する
/// - マイクが使われていることを常に表示する（プライバシー）
/// - ドラッグで上下・左右（端に吸着）に動かせる。地図の操作ボタンなどを隠さないように
struct VoiceMiniAvatarOverlay: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// 吸着している側
    @State private var onLeadingEdge = false
    /// 既定の位置（右下・タブバーの上）からの上方向のずれ
    @State private var liftFromBottom: CGFloat = 0
    @GestureState private var dragTranslation: CGSize = .zero

    /// 吹き出し全体のおおよその大きさ（アバター 88pt＋マイク表示）
    private static let bubbleSize = CGSize(width: 104, height: 124)
    /// タブバー（49pt）＋余白
    private static let bottomClearance: CGFloat = 49 + HDSpacing.md
    private static let edgeInset: CGFloat = HDSpacing.lg

    var body: some View {
        if env.showsVoiceMiniAvatar, let avatar = env.voice.avatar {
            GeometryReader { geo in
                VoiceMiniAvatarBubble(
                    service: env.voice,
                    avatar: avatar,
                    onOpen: { env.router.openVoiceAssistant() },
                    onEnd: { env.voice.close() },
                    onMoveToOtherSide: { withMotion { onLeadingEdge.toggle() } }
                )
                .position(restingCenter(in: geo.size))
                .offset(dragTranslation)
                .gesture(
                    DragGesture(minimumDistance: 8)
                        .updating($dragTranslation) { value, state, _ in state = value.translation }
                        .onEnded { value in settle(after: value, in: geo.size) }
                )
            }
            .transition(.opacity.combined(with: .scale(scale: 0.8, anchor: .bottomTrailing)))
        }
    }

    // MARK: 位置

    private func restingCenter(in size: CGSize) -> CGPoint {
        let half = Self.bubbleSize
        let x = onLeadingEdge ? Self.edgeInset + half.width / 2 : size.width - Self.edgeInset - half.width / 2
        let lowest = size.height - Self.bottomClearance - half.height / 2
        let y = min(lowest, max(lowestAllowedTop(in: size), lowest - liftFromBottom))
        return CGPoint(x: x, y: y)
    }

    /// 画面上部（ナビゲーションバー・オフラインのお知らせ）にかからない最も高い位置
    private func lowestAllowedTop(in size: CGSize) -> CGFloat {
        min(size.height / 2, 96 + Self.bubbleSize.height / 2)
    }

    private func settle(after value: DragGesture.Value, in size: CGSize) {
        let current = restingCenter(in: size)
        let droppedX = current.x + value.translation.width
        let droppedY = current.y + value.translation.height
        let lowest = size.height - Self.bottomClearance - Self.bubbleSize.height / 2
        let clampedY = min(lowest, max(lowestAllowedTop(in: size), droppedY))
        withMotion {
            onLeadingEdge = droppedX < size.width / 2
            liftFromBottom = lowest - clampedY
        }
    }

    private func withMotion(_ change: () -> Void) {
        if reduceMotion {
            change()
        } else {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.8), change)
        }
    }
}

/// ミニアバター本体（アバター・終了ボタン・マイク表示）
struct VoiceMiniAvatarBubble: View {
    let service: RealtimeVoiceService
    let avatar: HappyAvatarController
    let onOpen: () -> Void
    let onEnd: () -> Void
    let onMoveToOtherSide: () -> Void

    var body: some View {
        VStack(spacing: HDSpacing.xs) {
            ZStack(alignment: .topTrailing) {
                Button(action: onOpen) {
                    HappyAvatarView(controller: avatar, mode: .mini)
                        .padding(HDSpacing.sm)
                        .frame(width: 88, height: 88)
                        .background(HDColor.surface, in: Circle())
                        .overlay(Circle().stroke(VoiceStateStyle.color(for: service.state), lineWidth: 3))
                        .shadow(color: HDColor.navy.opacity(0.25), radius: 10, y: 4)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Happy AI、\(service.statusText)。タップで音声画面を開く")
                .accessibilityIdentifier("voiceMiniAvatar")
                .accessibilityAction(named: "反対側へ移動", onMoveToOtherSide)

                Button(action: onEnd) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(HDColor.onBrand)
                        .frame(width: 26, height: 26)
                        .background(HDColor.danger, in: Circle())
                        .overlay(Circle().stroke(HDColor.surface, lineWidth: 2))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .offset(x: 14, y: -14)
                .accessibilityLabel("音声会話を終了")
                .accessibilityIdentifier("voiceMiniEndButton")
            }
            micStatus
        }
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    }

    /// マイクの状態（色だけでなくアイコンと文字で。使用中は赤い点）
    private var micStatus: some View {
        let (text, symbol, color, dot) = micPresentation
        return HStack(spacing: 4) {
            if dot {
                Circle().fill(color).frame(width: 6, height: 6).accessibilityHidden(true)
            }
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .bold))
                .accessibilityHidden(true)
            Text(text)
                .font(.hd(.caption2, .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(color)
        .padding(.horizontal, HDSpacing.sm)
        .padding(.vertical, 3)
        .background(HDColor.surface, in: Capsule())
        .overlay(Capsule().stroke(color.opacity(0.4), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
        .accessibilityIdentifier("voiceMiniMicIndicator")
    }

    private var micPresentation: (String, String, Color, Bool) {
        if service.isMicrophoneCapturing {
            return ("マイク使用中", "mic.fill", HDColor.danger, true)
        }
        if service.state.error != nil {
            return ("接続エラー", "exclamationmark.triangle.fill", HDColor.danger, false)
        }
        if service.state.isBusyConnecting {
            return ("接続中…", "antenna.radiowaves.left.and.right", HDColor.warning, false)
        }
        if service.isTextMode {
            return ("マイクはオフ", "keyboard", HDColor.textSecondary, false)
        }
        return ("マイクはオフ", "mic.slash.fill", HDColor.danger, false)
    }
}
