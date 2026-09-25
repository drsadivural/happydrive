import Foundation
import MapKit
import Observation
import UIKit
import Vision
import HappyDriveCore

/// 写真の縮小と再エンコード。再描画により EXIF（撮影位置など）を含めない。
enum ImageTools {
    static func jpegData(from image: UIImage, maxDimension: CGFloat = 2048, quality: CGFloat = 0.8) -> Data? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, maxDimension / max(size.width, size.height))
        let target = CGSize(width: floor(size.width * scale), height: floor(size.height * scale))
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        var q = quality
        var data = rendered.jpegData(compressionQuality: q)
        // 契約上限（15MB）を超えないよう画質を下げる
        while let d = data, d.count > EvidenceHashing.maxByteSize, q > 0.3 {
            q -= 0.15
            data = rendered.jpegData(compressionQuality: q)
        }
        return data
    }

    static func thumbnail(_ image: UIImage, side: CGFloat = 160) -> UIImage {
        let scale = side / max(image.size.width, image.size.height, 1)
        let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        return UIGraphicsImageRenderer(size: target).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }
}

/// 端末内の文字認識（Vision、日本語）。画像はサーバーへ送らない。
enum TextRecognizer {
    static func recognizeLines(in image: UIImage) async throws -> [String] {
        guard let cgImage = image.cgImage else { return [] }
        let orientation = CGImagePropertyOrientation(image.imageOrientation)
        return try await Task.detached(priority: .userInitiated) {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["ja-JP", "en-US"]
            request.usesLanguageCorrection = true
            try VNImageRequestHandler(cgImage: cgImage, orientation: orientation).perform([request])
            let observations = request.results ?? []
            // 上の行から順に並べる（Vision の座標は左下原点）
            return observations
                .sorted { $0.boundingBox.minY > $1.boundingBox.minY }
                .compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
        }.value
    }
}

extension CGImagePropertyOrientation {
    init(_ o: UIImage.Orientation) {
        switch o {
        case .up: self = .up
        case .down: self = .down
        case .left: self = .left
        case .right: self = .right
        case .upMirrored: self = .upMirrored
        case .downMirrored: self = .downMirrored
        case .leftMirrored: self = .leftMirrored
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}

/// 住所の候補（地図で確認してから確定する）
struct AddressCandidate: Identifiable, Hashable {
    let id = UUID()
    let title: String
    let address: String
    let coordinate: CLLocationCoordinate2D

    var point: GeoPoint { GeoPoint(latitude: coordinate.latitude, longitude: coordinate.longitude) }

    static func == (a: AddressCandidate, b: AddressCandidate) -> Bool { a.id == b.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    /// 日本の住所表記（都道府県→市区町村→町名→番地）
    static func format(_ p: CLPlacemark) -> String {
        var parts: [String] = []
        for part in [p.administrativeArea, p.locality, p.subLocality, p.thoroughfare, p.subThoroughfare] {
            if let part, !part.isEmpty, parts.last != part { parts.append(part) }
        }
        return parts.joined()
    }
}

/// 住所入力の補完（MKLocalSearchCompleter）と候補の座標解決（MKLocalSearch / CLGeocoder）
@Observable
@MainActor
final class AddressSearchService: NSObject, MKLocalSearchCompleterDelegate {
    private(set) var suggestions: [MKLocalSearchCompletion] = []
    private(set) var isSearching = false
    @ObservationIgnored private let completer = MKLocalSearchCompleter()

    override init() {
        super.init()
        completer.delegate = self
        completer.resultTypes = [.address, .pointOfInterest]
        // 日本全域
        completer.region = MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 36.2, longitude: 138.25), span: MKCoordinateSpan(latitudeDelta: 20, longitudeDelta: 20))
    }

    func update(query: String) {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.count < 2 {
            suggestions = []
            completer.cancel()
            return
        }
        completer.queryFragment = q
    }

    func resolve(_ completion: MKLocalSearchCompletion) async throws -> [AddressCandidate] {
        isSearching = true
        defer { isSearching = false }
        let response = try await MKLocalSearch(request: MKLocalSearch.Request(completion: completion)).start()
        return response.mapItems.compactMap { item in
            let address = AddressCandidate.format(item.placemark)
            return AddressCandidate(title: item.name ?? completion.title, address: address.isEmpty ? completion.title : address, coordinate: item.placemark.coordinate)
        }
    }

    /// 入力文字列をそのまま住所として検索
    func geocode(_ text: String) async throws -> [AddressCandidate] {
        isSearching = true
        defer { isSearching = false }
        let placemarks = try await CLGeocoder().geocodeAddressString(text, in: nil, preferredLocale: Locale(identifier: "ja_JP"))
        return placemarks.compactMap { p in
            guard let loc = p.location else { return nil }
            let address = AddressCandidate.format(p)
            return AddressCandidate(title: p.name ?? text, address: address.isEmpty ? text : address, coordinate: loc.coordinate)
        }
    }

    nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        let results = completer.results
        MainActor.assumeIsolated {
            self.suggestions = Array(results.prefix(8))
        }
    }

    nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        MainActor.assumeIsolated {
            self.suggestions = []
        }
    }
}

/// Apple マップで経路案内
@MainActor
enum AppleMaps {
    static func navigate(to point: GeoPoint, name: String) {
        let item = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: point.latitude, longitude: point.longitude)))
        item.name = name
        item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
    }
}

extension GeoPoint {
    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
}
