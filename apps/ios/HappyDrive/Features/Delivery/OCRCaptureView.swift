import PhotosUI
import SwiftUI
import HappyDriveCore

/// 写真（伝票など）から住所を端末内で読み取り、ドライバーが確認・修正してから候補検索へ進む。
/// 画像はサーバーへ送信しない。
struct OCRCaptureView: View {
    @Environment(\.dismiss) private var dismiss
    let date: CalendarDateString
    let onSaved: (Stop) -> Void

    @State private var image: UIImage?
    @State private var lines: [String] = []
    @State private var selected: Set<Int> = []
    @State private var text = ""
    @State private var isRecognizing = false
    @State private var errorMessage: String?
    @State private var showCamera = false
    @State private var pickerItem: PhotosPickerItem?
    @State private var goToAddStop = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if CameraPicker.isAvailable {
                        Button {
                            showCamera = true
                        } label: {
                            Label("伝票を撮影する", systemImage: "camera.fill")
                        }
                    }
                    PhotosPicker(selection: $pickerItem, matching: .images) {
                        Label("写真を選ぶ", systemImage: "photo.on.rectangle")
                    }
                } footer: {
                    Text("文字の認識は端末内で行い、画像は送信しません。認識結果は必ず確認・修正してください。")
                }

                if let image {
                    Section {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 200)
                            .accessibilityLabel("読み取りに使った写真")
                    }
                }

                if isRecognizing {
                    Section { ProgressView("文字を読み取っています…") }
                }

                if !lines.isEmpty {
                    Section {
                        ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                            Button {
                                toggle(index)
                            } label: {
                                HStack {
                                    Image(systemName: selected.contains(index) ? "checkmark.square.fill" : "square")
                                        .foregroundStyle(HDColor.brandBlue)
                                        .accessibilityHidden(true)
                                    Text(line).foregroundStyle(HDColor.textPrimary)
                                }
                                .frame(minHeight: 44, alignment: .leading)
                            }
                            .accessibilityAddTraits(selected.contains(index) ? .isSelected : [])
                        }
                    } header: {
                        Text("読み取った行（住所の行を選択）")
                    }

                    Section {
                        TextField("住所", text: $text, axis: .vertical)
                            .lineLimit(2...4)
                            .accessibilityLabel("確認・修正した住所")
                        Button("この住所で候補を検索") { goToAddStop = true }
                            .buttonStyle(.hdPrimary)
                            .disabled(text.trimmingCharacters(in: .whitespaces).count < 4)
                    } header: {
                        Text("住所の確認・修正")
                    } footer: {
                        Text("誤認識がないか確認してください。次の画面で地図の候補を選んで位置を確定します。")
                    }
                }

                if let errorMessage {
                    Section { NoticeBox(kind: .danger, text: errorMessage) }
                }
            }
            .navigationTitle("写真から住所を読み取る")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { img in
                    Task { await recognize(img) }
                }
                .ignoresSafeArea()
            }
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data) {
                        await recognize(img)
                    } else {
                        errorMessage = "写真を読み込めませんでした"
                    }
                    pickerItem = nil
                }
            }
            .sheet(isPresented: $goToAddStop) {
                AddStopView(date: date, source: .ocr, initialAddress: text.trimmingCharacters(in: .whitespacesAndNewlines)) { stop in
                    onSaved(stop)
                    dismiss()
                }
            }
        }
    }

    private func toggle(_ index: Int) {
        if selected.contains(index) { selected.remove(index) } else { selected.insert(index) }
        text = selected.sorted().map { lines[$0] }.joined(separator: " ")
    }

    private func recognize(_ img: UIImage) async {
        image = img
        lines = []
        selected = []
        text = ""
        errorMessage = nil
        isRecognizing = true
        defer { isRecognizing = false }
        do {
            let result = try await TextRecognizer.recognizeLines(in: img)
            lines = result
            if result.isEmpty {
                errorMessage = "文字を読み取れませんでした。明るい場所で伝票全体が写るように撮影してください。"
            } else if let guess = result.firstIndex(where: Self.looksLikeAddress) {
                selected = [guess]
                text = result[guess]
            }
        } catch {
            errorMessage = "文字を読み取れませんでした。"
        }
    }

    /// 住所らしい行（都道府県・市区町村・番地の手がかり）
    static func looksLikeAddress(_ line: String) -> Bool {
        let markers = ["都", "道", "府", "県", "市", "区", "町", "村", "丁目", "番地"]
        return markers.contains { line.contains($0) } && line.contains(where: \.isNumber)
    }
}
