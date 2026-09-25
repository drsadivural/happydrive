import Foundation
import Observation
import HappyDriveCore

@Observable
@MainActor
final class DeliveryViewModel {
    var date = Date()
    private(set) var stops: [Stop] = []
    private(set) var route: Route?
    private(set) var isLoading = false
    private(set) var loadedOnce = false
    var errorMessage: String?
    /// オフラインでキャッシュを表示している場合の保存時刻
    private(set) var cachedAt: Date?
    var busyMessage: String?

    var dateString: CalendarDateString { HDFormat.apiDate(date) }
    var isToday: Bool { dateString == HDFormat.apiDate(Date()) }
    var summary: RouteSummary { RouteSummary(route: route, stops: stops) }

    func load(env: AppEnvironment) async {
        isLoading = true
        defer {
            isLoading = false
            loadedOnce = true
        }
        let api = env.api
        let day = dateString
        do {
            async let s = api.stops(date: day)
            async let r = api.route(date: day)
            let (newStops, newRoute) = try await (s, r)
            stops = newStops
            route = newRoute
            cachedAt = nil
            errorMessage = nil
            saveCache(env: env)
        } catch {
            if let cache = env.deliveryCache.load(), cache.date == day {
                stops = cache.stops
                route = cache.route
                cachedAt = cache.savedAt
                errorMessage = nil
            } else {
                errorMessage = error.hdUserMessage
            }
            HDLog.error(HDLog.api, "delivery.load", error)
        }
    }

    /// 今日の停止順・住所・メモを暗号化キャッシュへ（圏外で参照するため）
    func saveCache(env: AppEnvironment) {
        guard isToday else { return }
        try? env.deliveryCache.save(DeliveryCacheSnapshot(date: dateString, stops: stops, route: route, savedAt: Date()))
    }

    /// 配送状態の送信後（または送信待ち時）に一覧を更新
    func apply(_ stop: Stop, env: AppEnvironment) {
        if let i = stops.firstIndex(where: { $0.id == stop.id }) {
            stops[i] = stop
        } else if stop.scheduledDate == dateString {
            stops.append(stop)
        }
        saveCache(env: env)
    }

    func remove(stopId: String, env: AppEnvironment) {
        stops.removeAll { $0.id == stopId }
        saveCache(env: env)
    }

    func setRoute(_ r: Route, env: AppEnvironment) {
        route = r
        saveCache(env: env)
    }

    func reorder(from source: IndexSet, to destination: Int, env: AppEnvironment) async {
        guard let routeId = route?.id else { return }
        let ids = summary.items.map(\.stop.id)
        let newOrder = RouteSummary.reordered(ids, from: Array(source), to: destination)
        guard newOrder != ids else { return }
        busyMessage = "順番を更新しています"
        defer { busyMessage = nil }
        do {
            let updated = try await env.api.reorderRoute(routeId: routeId, orderedStopIds: newOrder, idempotencyKey: IdempotencyKey.generate())
            setRoute(updated, env: env)
        } catch {
            errorMessage = error.hdUserMessage
        }
    }

    func startRoute(env: AppEnvironment) async {
        guard let routeId = route?.id else { return }
        busyMessage = "ルートを開始しています"
        defer { busyMessage = nil }
        do {
            let updated = try await env.api.startRoute(routeId: routeId, idempotencyKey: IdempotencyKey.generate())
            setRoute(updated, env: env)
            await load(env: env)
        } catch {
            errorMessage = error.hdUserMessage
        }
    }
}

extension AppEnvironment {
    /// 配送状態の記録（証跡を含む）。オフラインキュー経由で送り、送れなければ保留して端末上の表示だけ更新する。
    /// - Returns: 更新後の配送先と、保留になったかどうか
    func submitStopEvent(stop: Stop, event: StopEventRequest, photos: [PhotoAttachment] = [], signature: PhotoAttachment? = nil) async throws -> (stop: Stop, queued: Bool) {
        var mutation = try api.stopEventMutation(stopId: stop.id, event: event)
        let photoPending = photos.pending(purpose: .delivery_photo, deliveryStopId: stop.id)
        let signaturePending = (signature.map { [$0] } ?? []).pending(purpose: .signature, deliveryStopId: stop.id)
        mutation.attachments = photoPending.attachments + signaturePending.attachments
        let data = photoPending.data.merging(signaturePending.data) { a, _ in a }

        switch try await queue.submit(mutation, attachmentData: data) {
        case .sent(let response):
            if let updated = try? HDJSON.makeDecoder().decode(Stop.self, from: response.body) {
                return (updated, false)
            }
            return (stop.applyingLocally(event), false)
        case .queued:
            return (stop.applyingLocally(event), true)
        }
    }
}

extension Stop {
    /// 送信待ちの間に端末で表示する状態
    func applyingLocally(_ event: StopEventRequest) -> Stop {
        var s = self
        switch event.eventType {
        case .en_route: s.status = .en_route
        case .arrived: s.status = .arrived
        case .delivered:
            s.status = .delivered
            s.handoff = event.handoff?.rawValue
            s.completedAt = event.occurredAt
        case .failed:
            s.status = .failed
            s.failureReason = event.failureReason?.rawValue
            s.failureNote = event.failureNote
        case .deferred:
            s.status = .deferred
            s.failureReason = event.failureReason?.rawValue
            s.deferredUntil = event.deferredUntil
        }
        return s
    }
}
