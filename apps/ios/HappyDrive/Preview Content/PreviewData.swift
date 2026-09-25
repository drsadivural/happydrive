#if DEBUG
import SwiftUI
import HappyDriveCore

/// Xcode プレビュー専用のサンプル（リリースビルドには含まれない）。実データや画面ロジックには使わない。
enum PreviewData {
    static var job: Job {
        let json = """
        {"id":"00000000-0000-0000-0000-000000000001","organizationId":"00000000-0000-0000-0000-000000000002","organizationName":"プレビュー事業者","organizationVerified":true,"title":"プレビュー用の案件","category":"shopping_assist","contractType":"contractor","status":"published","startsAt":"2026-09-26T06:00:00Z","endsAt":"2026-09-26T06:30:00Z","amountYen":900,"capacity":2,"remainingCapacity":1,"areaLabel":"横浜市中区","distanceKm":1.2,"description":"プレビュー表示のための説明文です。","requiredSkills":[],"cancellationPolicy":{"freeCancelHoursBefore":24,"lateCancelCompensationPercent":50,"text":"プレビュー"},"steps":[{"title":"手順1"}],"matchReasons":["近い","時間に合う"]}
        """
        // swiftlint:disable:next force_try
        return try! HDJSON.makeDecoder().decode(Job.self, from: Data(json.utf8))
    }

    static var stop: Stop {
        var s = Stop(id: "00000000-0000-0000-0000-000000000010", status: .en_route, address: "プレビュー用の住所 1-2-3", scheduledDate: "2026-09-26", location: GeoPoint(latitude: 35.4437, longitude: 139.6503), hasLocation: true, priority: 1)
        s.note = "プレビュー用のメモ"
        return s
    }
}

#Preview("案件カード") {
    JobCard(job: PreviewData.job)
        .padding()
        .hdScreenBackground()
}

#Preview("配送先の行") {
    List {
        StopRow(order: 1, stop: PreviewData.stop, leg: nil, violations: [])
    }
}

#Preview("状態バッジ") {
    VStack(alignment: .leading) {
        ForEach(AssignmentState.allCases, id: \.self) { s in
            StatusBadge(presentation: s.presentation)
        }
    }
    .padding()
}
#endif
