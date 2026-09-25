import Foundation
import Observation
import HappyDriveCore

/// 業務中（traveling / checked_in / working）のみの限定位置共有。
/// 発注者には最新 1 点のみ表示される（契約 /assignments/{id}/location）。
/// 報告送信後・利用者が停止した時・状態が変わった時に自動停止する。アプリがバックグラウンドの間は送信しない。
@Observable
@MainActor
final class LocationSharingController {
    private(set) var activeAssignmentId: String?
    private(set) var lastSentAt: Date?
    private(set) var lastError: String?

    @ObservationIgnored private let api: HappyDriveAPI
    @ObservationIgnored private let location: LocationService
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var pausedAssignmentId: String?

    /// 送信間隔（秒）
    let interval: TimeInterval = 60

    init(api: HappyDriveAPI, location: LocationService) {
        self.api = api
        self.location = location
    }

    var isSharing: Bool { activeAssignmentId != nil }

    func isSharing(_ assignmentId: String) -> Bool { activeAssignmentId == assignmentId }

    func start(assignmentId: String, state: AssignmentState) {
        guard state.allowsLocationSharing else { return }
        if activeAssignmentId == assignmentId { return }
        stop()
        activeAssignmentId = assignmentId
        lastError = nil
        location.requestWhenInUse()
        location.begin("share")
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.sendOnce(assignmentId: assignmentId)
                try? await Task.sleep(nanoseconds: UInt64((self?.interval ?? 60) * 1_000_000_000))
            }
        }
    }

    /// アプリがバックグラウンドへ移る時（位置は取得しない）
    func pause() {
        guard let id = activeAssignmentId else { return }
        stop()
        pausedAssignmentId = id
    }

    /// 前面に戻った時に共有を再開（業務状態は再開後の送信でサーバーが検証し、対象外なら 409 で停止）
    func resumeIfPaused() {
        guard let id = pausedAssignmentId else { return }
        pausedAssignmentId = nil
        start(assignmentId: id, state: .working)
    }

    func stop() {
        pausedAssignmentId = nil
        task?.cancel()
        task = nil
        if activeAssignmentId != nil {
            location.end("share")
        }
        activeAssignmentId = nil
    }

    /// 状態変化に追従（許可されない状態になったら停止）
    func sync(assignmentId: String, state: AssignmentState) {
        if activeAssignmentId == assignmentId && !state.allowsLocationSharing {
            stop()
        }
    }

    private func sendOnce(assignmentId: String) async {
        guard activeAssignmentId == assignmentId else { return }
        guard let loc = await location.currentLocation(maxAge: 60) else {
            lastError = location.isAuthorized ? "現在地を取得できません" : "位置情報の利用が許可されていません"
            return
        }
        do {
            try await api.shareLocation(
                assignmentId: assignmentId,
                location: GeoPoint(latitude: loc.coordinate.latitude, longitude: loc.coordinate.longitude),
                accuracyMeters: loc.horizontalAccuracy >= 0 ? loc.horizontalAccuracy : nil
            )
            lastSentAt = Date()
            lastError = nil
        } catch let error as APIError where error.status == 409 {
            // 業務状態が共有対象外になった
            stop()
        } catch {
            lastError = error.hdUserMessage
        }
    }
}
