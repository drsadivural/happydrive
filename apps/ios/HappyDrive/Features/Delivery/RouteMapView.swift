import MapKit
import SwiftUI
import HappyDriveCore

/// 番号付きピンと順番の線（直線で結んだ目安。道路上の経路ではない）
struct RouteMapView: View {
    let items: [RouteSummary.Item]
    var interactive = true
    var showsUserLocation = false

    private struct Pin: Identifiable {
        let id: String
        let order: Int
        let coordinate: CLLocationCoordinate2D
        let stop: Stop
    }

    private var located: [Pin] {
        items.compactMap { item in
            item.stop.location.map { Pin(id: item.id, order: item.order, coordinate: $0.coordinate, stop: item.stop) }
        }
    }

    var body: some View {
        Map(initialPosition: .automatic, interactionModes: interactive ? .all : []) {
            if located.count >= 2 {
                MapPolyline(coordinates: located.map(\.coordinate))
                    .stroke(HDColor.brandBlue, lineWidth: 4)
            }
            ForEach(located) { pin in
                Annotation("\(pin.order)", coordinate: pin.coordinate) {
                    NumberedPin(number: pin.order, status: pin.stop.status)
                        .accessibilityLabel("\(pin.order)番目 \(pin.stop.address) \(pin.stop.status.presentation.label)")
                }
                .annotationTitles(.hidden)
            }
            if showsUserLocation {
                UserAnnotation()
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .accessibilityElement(children: interactive ? .contain : .combine)
        .accessibilityLabel(interactive ? "配送ルートの地図" : "配送ルートの地図 \(located.count)件")
    }
}

struct NumberedPin: View {
    let number: Int
    var status: StopStatus = .ready

    private var color: Color {
        switch status {
        case .delivered: return HDColor.jobGreen
        case .failed: return HDColor.danger
        case .deferred: return HDColor.warning
        default: return HDColor.brandBlue
        }
    }

    var body: some View {
        ZStack {
            Circle().fill(color)
            Circle().stroke(.white, lineWidth: 3)
            if status == .delivered {
                Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.white)
            } else {
                Text("\(number)").font(.hd(.caption, .bold)).foregroundStyle(.white)
            }
        }
        .frame(width: 32, height: 32)
        .shadow(radius: 2)
    }
}

/// 1 地点の地図
struct SinglePointMap: View {
    let point: GeoPoint
    let title: String

    var body: some View {
        Map(initialPosition: .region(MKCoordinateRegion(center: point.coordinate, latitudinalMeters: 600, longitudinalMeters: 600))) {
            Marker(title, coordinate: point.coordinate)
                .tint(HDColor.brandBlue)
            UserAnnotation()
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .accessibilityLabel("\(title)の地図")
    }
}
