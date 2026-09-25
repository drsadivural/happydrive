import CoreLocation
import Foundation
import Observation
import os
import HappyDriveCore

/// 位置情報（When In Use のみ。バックグラウンド追跡は行わない）
/// - 配送中は速度から運転中を判定して操作を抑止
/// - 業務中（traveling/checked_in/working）のみ限定共有に使用
@Observable
@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate {
    private(set) var authorization: CLAuthorizationStatus = .notDetermined
    private(set) var isPreciseAccuracy = true
    private(set) var lastLocation: CLLocation?
    private(set) var safety = DrivingSafetyState()

    @ObservationIgnored private let manager = CLLocationManager()
    @ObservationIgnored private var reasons: Set<String> = []
    @ObservationIgnored private var oneShotWaiters: [CheckedContinuation<CLLocation?, Never>] = []

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 10
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = true
        authorization = manager.authorizationStatus
        isPreciseAccuracy = manager.accuracyAuthorization == .fullAccuracy
    }

    var isAuthorized: Bool {
        authorization == .authorizedWhenInUse || authorization == .authorizedAlways
    }

    var isDenied: Bool {
        authorization == .denied || authorization == .restricted
    }

    /// 運転中（約10km/h超）。複雑な編集を無効にする。
    var isDriving: Bool { safety.isDriving }

    var currentPoint: GeoPoint? {
        guard let l = lastLocation else { return nil }
        return GeoPoint(latitude: l.coordinate.latitude, longitude: l.coordinate.longitude)
    }

    var statusText: String {
        switch authorization {
        case .notDetermined: return "未設定"
        case .denied: return "許可されていません"
        case .restricted: return "機能制限により利用できません"
        case .authorizedWhenInUse, .authorizedAlways:
            return isPreciseAccuracy ? "使用中のみ許可（正確な位置）" : "使用中のみ許可（おおよその位置）"
        @unknown default: return "不明"
        }
    }

    func requestWhenInUse() {
        if authorization == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
    }

    /// 継続更新の開始（理由ごとに参照カウント）
    func begin(_ reason: String) {
        reasons.insert(reason)
        if isAuthorized { manager.startUpdatingLocation() }
    }

    func end(_ reason: String) {
        reasons.remove(reason)
        if reasons.isEmpty {
            manager.stopUpdatingLocation()
            safety = DrivingSafetyState()
        }
    }

    /// 現在地を 1 回取得（30 秒以内の測位があればそれを使う）
    func currentLocation(maxAge: TimeInterval = 30) async -> CLLocation? {
        if let l = lastLocation, -l.timestamp.timeIntervalSinceNow < maxAge { return l }
        guard isAuthorized else { return nil }
        return await withCheckedContinuation { continuation in
            oneShotWaiters.append(continuation)
            if oneShotWaiters.count == 1 { manager.requestLocation() }
        }
    }

    private func resolveWaiters(_ location: CLLocation?) {
        let waiters = oneShotWaiters
        oneShotWaiters.removeAll()
        for w in waiters { w.resume(returning: location) }
    }

    // MARK: CLLocationManagerDelegate（メインスレッドで生成したため通知もメインスレッド）

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        let precise = manager.accuracyAuthorization == .fullAccuracy
        MainActor.assumeIsolated {
            self.authorization = status
            self.isPreciseAccuracy = precise
            if self.isAuthorized && !self.reasons.isEmpty {
                self.manager.startUpdatingLocation()
            }
            if !self.isAuthorized && status != .notDetermined {
                self.resolveWaiters(nil)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        MainActor.assumeIsolated {
            self.lastLocation = latest
            if latest.speed >= 0 {
                var s = self.safety
                s.update(speedMps: latest.speed, at: latest.timestamp)
                if s != self.safety { self.safety = s }
            }
            self.resolveWaiters(latest)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        MainActor.assumeIsolated {
            HDLog.location.error("location update failed")
            self.resolveWaiters(self.lastLocation)
        }
    }
}
