import PhotosUI
import SwiftUI
import UIKit
import HappyDriveCore

/// 添付予定の写真（EXIF を除いて再エンコード済み）
struct PhotoAttachment: Identifiable, Equatable {
    let id = UUID()
    let data: Data
    let thumbnail: UIImage
    let contentType: EvidenceContentType

    init?(image: UIImage) {
        guard let data = ImageTools.jpegData(from: image) else { return nil }
        self.data = data
        self.thumbnail = ImageTools.thumbnail(image)
        self.contentType = .jpeg
    }

    init(pngData: Data, preview: UIImage) {
        self.data = pngData
        self.thumbnail = ImageTools.thumbnail(preview)
        self.contentType = .png
    }

    static func == (a: PhotoAttachment, b: PhotoAttachment) -> Bool { a.id == b.id }

    /// オフラインキューに渡す一時ファイル名
    var fileName: String { "\(id.uuidString).\(contentType == .png ? "png" : "jpg")" }
}

/// カメラ撮影（UIImagePickerController）
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.onImage(image)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

/// 写真の追加（カメラ / ライブラリ）と一覧・削除
struct PhotoAttachmentPicker: View {
    @Binding var attachments: [PhotoAttachment]
    var maxCount = 4
    var title = "写真を追加"
    var privacyNote: String? = nil

    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showCamera = false
    @State private var loadError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: HDSpacing.sm) {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: HDSpacing.sm) {
                        ForEach(Array(attachments.enumerated()), id: \.element.id) { index, item in
                            ZStack(alignment: .topTrailing) {
                                Image(uiImage: item.thumbnail)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 88, height: 88)
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                    .accessibilityLabel("添付写真 \(index + 1)")
                                Button {
                                    attachments.removeAll { $0.id == item.id }
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.title3)
                                        .foregroundStyle(.white, .black.opacity(0.6))
                                        .frame(width: 44, height: 44)
                                }
                                .accessibilityLabel("写真 \(index + 1) を削除")
                                .offset(x: 12, y: -12)
                            }
                        }
                    }
                    .padding(.top, 12)
                }
            }

            if attachments.count < maxCount {
                HStack(spacing: HDSpacing.sm) {
                    if CameraPicker.isAvailable {
                        Button {
                            showCamera = true
                        } label: {
                            Label("撮影する", systemImage: "camera.fill")
                        }
                        .buttonStyle(.hdSecondary)
                    }
                    PhotosPicker(selection: $pickerItems, maxSelectionCount: maxCount - attachments.count, matching: .images) {
                        Label(CameraPicker.isAvailable ? "写真を選ぶ" : title, systemImage: "photo.on.rectangle")
                            .font(.hd(.headline, .semibold))
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(HDColor.brandBlueSoft, in: RoundedRectangle(cornerRadius: HDRadius.button))
                    }
                }
            }

            if let privacyNote {
                Label(privacyNote, systemImage: "hand.raised.fill")
                    .font(.hd(.footnote))
                    .foregroundStyle(HDColor.textSecondary)
            }
            if let loadError {
                Text(loadError).font(.hd(.footnote)).foregroundStyle(HDColor.danger)
            }
        }
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await load(items) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                if let a = PhotoAttachment(image: image) { attachments.append(a) }
            }
            .ignoresSafeArea()
        }
    }

    @MainActor
    private func load(_ items: [PhotosPickerItem]) async {
        loadError = nil
        for item in items {
            guard attachments.count < maxCount else { break }
            if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data), let a = PhotoAttachment(image: image) {
                attachments.append(a)
            } else {
                loadError = "写真を読み込めませんでした"
            }
        }
        pickerItems = []
    }
}

extension Array where Element == PhotoAttachment {
    /// オフラインキュー用の添付情報と一時データ
    func pending(purpose: EvidencePurpose, assignmentId: String? = nil, deliveryStopId: String? = nil) -> (attachments: [PendingAttachment], data: [String: Data]) {
        var list: [PendingAttachment] = []
        var data: [String: Data] = [:]
        for a in self {
            list.append(PendingAttachment(localFileName: a.fileName, contentType: a.contentType, purpose: purpose, assignmentId: assignmentId, deliveryStopId: deliveryStopId))
            data[a.fileName] = a.data
        }
        return (list, data)
    }
}
