import PencilKit
import SwiftUI
import UIKit

/// 受領サイン（指でも書ける PencilKit キャンバス）
struct SignatureCanvas: UIViewRepresentable {
    @Binding var drawing: PKDrawing

    func makeUIView(context: Context) -> PKCanvasView {
        let view = PKCanvasView()
        view.drawingPolicy = .anyInput
        view.tool = PKInkingTool(.pen, color: .black, width: 4)
        view.backgroundColor = .white
        view.isOpaque = true
        view.overrideUserInterfaceStyle = .light
        view.delegate = context.coordinator
        view.accessibilityLabel = "サイン記入欄"
        return view
    }

    func updateUIView(_ uiView: PKCanvasView, context: Context) {
        if uiView.drawing != drawing {
            uiView.drawing = drawing
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, PKCanvasViewDelegate {
        let parent: SignatureCanvas
        init(_ parent: SignatureCanvas) { self.parent = parent }

        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            parent.drawing = canvasView.drawing
        }
    }
}

struct SignaturePadView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var drawing = PKDrawing()
    let onSave: (PhotoAttachment) -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: HDSpacing.lg) {
                Text("受取人の方に枠内へサインしていただいてください")
                    .font(.hd(.subheadline))
                    .foregroundStyle(HDColor.textSecondary)
                SignatureCanvas(drawing: $drawing)
                    .frame(height: 240)
                    .clipShape(RoundedRectangle(cornerRadius: HDRadius.card))
                    .overlay(RoundedRectangle(cornerRadius: HDRadius.card).stroke(HDColor.border, lineWidth: 1))
                HStack {
                    Button("書き直す") { drawing = PKDrawing() }
                        .buttonStyle(.hdSecondary)
                    Button("サインを保存") { save() }
                        .buttonStyle(.hdPrimary)
                        .disabled(drawing.strokes.isEmpty)
                }
                Spacer()
            }
            .padding(HDSpacing.lg)
            .navigationTitle("受領サイン")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { dismiss() }
                }
            }
        }
    }

    private func save() {
        let bounds = drawing.bounds.insetBy(dx: -20, dy: -20)
        guard !bounds.isEmpty else { return }
        // 白背景の PNG として保存
        let format = UIGraphicsImageRendererFormat.default()
        format.opaque = true
        format.scale = 2
        let image = UIGraphicsImageRenderer(size: bounds.size, format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: bounds.size))
            // ダークモードでも黒で描く
            let traits = UITraitCollection(userInterfaceStyle: .light)
            traits.performAsCurrent {
                drawing.image(from: bounds, scale: 2).draw(in: CGRect(origin: .zero, size: bounds.size))
            }
        }
        guard let png = image.pngData() else { return }
        onSave(PhotoAttachment(pngData: png, preview: image))
        dismiss()
    }
}
