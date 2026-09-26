import AVFoundation
import Foundation
import os
import WebRTC

/// 音声会話中のオーディオセッション。
/// - .playAndRecord / .voiceChat（Apple の音声処理＝エコーキャンセル・ノイズ抑制を有効化）
/// - Bluetooth は HFP（.allowBluetooth）のみ。A2DP はマイクが無いため使わない
/// - WebRTC の RTCAudioSession を手動モードにし、アプリが有効化してから音声ユニットを動かす（二重に設定しない）
/// - 終了時は .notifyOthersOnDeactivation で他アプリ（音楽等）に戻す
@MainActor
final class AudioSessionManager {
    enum Route: Equatable {
        case speaker, receiver, bluetooth, headphones, carAudio, other

        var label: String {
            switch self {
            case .speaker: return "スピーカー"
            case .receiver: return "受話口"
            case .bluetooth: return "Bluetooth"
            case .headphones: return "ヘッドホン"
            case .carAudio: return "車のオーディオ"
            case .other: return "その他"
            }
        }

        /// スピーカー/受話口の切り替えが意味を持つ経路か
        var isBuiltIn: Bool { self == .speaker || self == .receiver }
    }

    var onInterruptionBegan: (() -> Void)?
    var onRouteChanged: ((Route) -> Void)?
    var onMediaServicesReset: (() -> Void)?

    private(set) var isActive = false
    private var observers: [NSObjectProtocol] = []
    private let rtcSession = RTCAudioSession.sharedInstance()

    init() {
        // WebRTC が勝手に音声ユニットを起動しないよう手動モードにする（有効化は activate で行う）
        rtcSession.useManualAudio = true
        rtcSession.isAudioEnabled = false
        let webRTCConfig = RTCAudioSessionConfiguration.webRTC()
        webRTCConfig.category = AVAudioSession.Category.playAndRecord.rawValue
        webRTCConfig.mode = AVAudioSession.Mode.voiceChat.rawValue
        webRTCConfig.categoryOptions = Self.options(speaker: true)
        RTCAudioSessionConfiguration.setWebRTC(webRTCConfig)
    }

    private static func options(speaker: Bool) -> AVAudioSession.CategoryOptions {
        speaker ? [.allowBluetooth, .defaultToSpeaker] : [.allowBluetooth]
    }

    /// セッションを有効化し、WebRTC の音声入出力を開始する
    func activate(speaker: Bool) throws {
        guard !isActive else { return }
        rtcSession.lockForConfiguration()
        defer { rtcSession.unlockForConfiguration() }
        do {
            try rtcSession.setCategory(.playAndRecord, mode: .voiceChat, options: Self.options(speaker: speaker))
            try rtcSession.setActive(true)
            try? rtcSession.overrideOutputAudioPort(speaker ? .speaker : .none)
        } catch {
            HDLog.voice.error("audio session activate failed: \((error as NSError).code, privacy: .public)")
            throw error
        }
        isActive = true
        rtcSession.isAudioEnabled = true
        startObserving()
    }

    /// スピーカー / 受話口の切り替え（Bluetooth 等の外部経路が優先される）
    func setSpeaker(_ on: Bool) {
        guard isActive else { return }
        rtcSession.lockForConfiguration()
        defer { rtcSession.unlockForConfiguration() }
        do {
            try rtcSession.setCategory(.playAndRecord, mode: .voiceChat, options: Self.options(speaker: on))
            try rtcSession.overrideOutputAudioPort(on ? .speaker : .none)
        } catch {
            HDLog.voice.error("audio route change failed: \((error as NSError).code, privacy: .public)")
        }
        onRouteChanged?(currentRoute)
    }

    /// 音声を止めてセッションを解放する（何度呼んでもよい）
    func deactivate() {
        rtcSession.isAudioEnabled = false
        stopObserving()
        guard isActive else { return }
        isActive = false
        rtcSession.lockForConfiguration()
        defer { rtcSession.unlockForConfiguration() }
        do {
            // RTCAudioSession は無効化時に .notifyOthersOnDeactivation を付ける
            try rtcSession.setActive(false)
        } catch {
            HDLog.voice.error("audio session deactivate failed: \((error as NSError).code, privacy: .public)")
        }
    }

    var currentRoute: Route {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        guard let port = outputs.first?.portType else { return .other }
        switch port {
        case .builtInSpeaker: return .speaker
        case .builtInReceiver: return .receiver
        case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE: return .bluetooth
        case .headphones, .usbAudio: return .headphones
        case .carAudio: return .carAudio
        default: return .other
        }
    }

    // MARK: - 通知

    private func startObserving() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let type = raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            MainActor.assumeIsolated {
                if type == .began { self?.onInterruptionBegan?() }
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.onRouteChanged?(self.currentRoute)
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                // メディアサービスの再起動でセッションは無効になっている
                self.isActive = false
                self.rtcSession.isAudioEnabled = false
                self.onMediaServicesReset?()
            }
        })
    }

    private func stopObserving() {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
    }
}
