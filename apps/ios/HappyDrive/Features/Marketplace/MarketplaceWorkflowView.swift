import SwiftUI
import HappyDriveCore
import CoreImage.CIFilterBuiltins
import VisionKit
import Vision
import AVFoundation

struct MarketplaceAcceptView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let request: MarketplaceRequest
    let supplierId: String
    @State private var staffId = ""
    @State private var members: [Member] = []
    private struct Member: Decodable, Sendable, Identifiable { let id: String; let familyName: String; let givenName: String }
    @State private var busy = false
    @State private var error: String?
    @State private var key = IdempotencyKey.generate()
    var body: some View {
        Form {
            Section(request.title) { Text(request.areaCode); Text(HDFormat.dateTime(request.startsAt)); Text("受諾前は詳細住所を表示しません。") }
            Section("担当者を指定") {
                if members.isEmpty { Text("担当者を読み込んでいます…") }
                Picker("担当者", selection: $staffId) { ForEach(members) { member in Text("\(member.familyName) \(member.givenName)").tag(member.id) } }
                Text("資格・対応時間・予定を確認して受諾します。")
            }
            if let error { Text(error).foregroundStyle(HDColor.danger) }
            Button("条件を確認して受諾") { Task { await accept() } }.disabled(busy || staffId.isEmpty || !env.network.isOnline)
        }.navigationTitle("依頼を受諾").task {
            do {
                let result: MarketplaceList<Member> = try await env.api.client.send(.get("/marketplace/suppliers/\(APIClient.pathComponent(supplierId))/members"))
                members = result.items
                staffId = members.first(where: { $0.id == env.session.user?.id })?.id ?? members.first?.id ?? ""
            } catch { self.error = error.hdUserMessage }
        }
    }
    private func accept() async {
        guard !busy else { return };busy = true;defer {busy = false}
        do { let _:MarketplaceResult = try await env.api.client.send(try .json(.post,"/marketplace/requests/\(APIClient.pathComponent(request.id))/accept",body:["supplierId":supplierId,"staffId":staffId],idempotencyKey:key));dismiss() }
        catch { self.error = error.hdUserMessage }
    }
}

struct MarketplaceServiceForm: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let supplierId: String
    @State private var name = ""
    @State private var category = "shopping_assist"
    @State private var details = ""
    @State private var area = ""
    @State private var minutes = 60
    @State private var pricePolicy = ""
    @State private var busy = false
    @State private var error: String?
    @State private var key = IdempotencyKey.generate()
    var body: some View {
        Form {
            TextField("サービス名",text:$name)
            Picker("カテゴリ",selection:$category) { Text("買い物支援").tag("shopping_assist");Text("配送").tag("delivery");Text("訪問・見守り").tag("companionship");Text("家事支援").tag("household_help") }
            TextField("説明",text:$details,axis:.vertical)
            TextField("地域コード（カンマ区切り）",text:$area)
            Stepper("所要時間 \(minutes)分",value:$minutes,in:1...1440)
            TextField("価格・見積方法",text:$pricePolicy,axis:.vertical)
            if let error { Text(error).foregroundStyle(HDColor.danger) }
            Button("審査を申請") { Task { await submit() } }.disabled(busy || name.isEmpty || details.isEmpty || area.isEmpty || pricePolicy.isEmpty)
        }.navigationTitle("サービス登録")
    }
    private struct Input:Encodable { let name:String;let category:String;let description:String;let areaCodes:[String];let durationMinutes:Int;let pricePolicy:String }
    private func submit() async {
        guard !busy else{return};busy = true;defer{busy = false}
        do { let _:MarketplaceResult = try await env.api.client.send(try .json(.post,"/marketplace/suppliers/\(APIClient.pathComponent(supplierId))/services",body:Input(name:name,category:category,description:details,areaCodes:area.split(separator:",").map{String($0).trimmingCharacters(in:.whitespaces)},durationMinutes:minutes,pricePolicy:pricePolicy),idempotencyKey:key));dismiss() }
        catch { self.error = error.hdUserMessage }
    }
}

struct MarketplaceRequestView: View {
    @Environment(AppEnvironment.self) private var env
    let requestId: String
    @State private var request: MarketplaceRequest?
    @State private var error: String?
    @State private var busy = false
    @State private var token: CompletionToken?
    @State private var showScanner = false
    @State private var reason = ""
    @State private var showReason = false
    @State private var reasonAction = "dispute"
    @State private var keys: [String:String] = [:]
    @State private var message = ""
    @State private var messages: [Message] = []
    private struct Message:Decodable,Sendable,Identifiable {let id:String;let body:String;let createdAt:Date}
    private var path:String { "/marketplace/requests/\(APIClient.pathComponent(requestId))" }
    var body: some View {
        List {
            if let request {
                Section(request.title) {
                    Text(MarketplaceStatus.label(request.status)).font(.headline)
                    Text(HDFormat.dateTime(request.startsAt))
                    if let address = request.address { Text(address).textSelection(.enabled); if let url = URL(string:"https://maps.apple.com/?q=\(address.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed) ?? "")") { Link("Appleマップで案内",destination:url) } }
                    if let details = request.details { Text(details) }
                    if let supplier = request.supplierName { Text(supplier) }
                }
                if request.staffId == env.session.user?.id {
                    Section("作業の進行") {
                        if let next = MarketplaceStatus.next(request.status) { Button("\(MarketplaceStatus.label(next))に進む") { Task { await mutate("status",body:["status":next]) } }.disabled(busy || !env.network.isOnline) }
                        if request.status == "awaiting_customer_confirmation" { Button("顧客の完了QRを読み取る") { Task { await startScanner() } }.disabled(busy || !env.network.isOnline) }
                    }
                }
                if request.customerId == env.session.user?.id, request.status == "awaiting_customer_confirmation" {
                    Section("作業内容の確認") {
                        Text("内容を確認したら、担当者にQRを提示してください。読み取りが完了すると依頼枠を消費します。")
                        Button("確認して完了QRを表示") { Task { await issue() } }.disabled(busy || !env.network.isOnline)
                        if let token { CompletionQRView(token:token) }
                    }
                }
                if request.status == "open", request.customerId == env.session.user?.id { Button("依頼をキャンセル",role:.destructive) { reasonAction = "cancel";showReason = true } }
                if ["accepted","en_route","arrived","in_progress","awaiting_customer_confirmation"].contains(request.status ?? "") { Button("サポートに相談") { reasonAction = "dispute";showReason = true } }
                Section("メッセージ") {
                    ForEach(messages) { item in VStack(alignment:.leading) { Text(item.body);Text(HDFormat.dateTime(item.createdAt)).font(.caption).foregroundStyle(.secondary) } }
                    TextField("メッセージ",text:$message,axis:.vertical)
                    Button("送信") { Task { await mutate("messages",body:["body":message]);if error == nil {message = ""} } }.disabled(busy || message.isEmpty || !env.network.isOnline)
                }
            } else if error == nil { ProgressView("依頼を読み込み中…") }
            if let error { Text(error).foregroundStyle(HDColor.danger);Button("再読み込み") { Task { await load() } } }
        }.navigationTitle("依頼の詳細").task { await load() }.refreshable { await load() }
        .sheet(isPresented:$showScanner) { NavigationStack { CompletionScanner(onScan:{raw in showScanner = false;Task { await scan(raw) }},onError:{value in showScanner = false;error = value}).ignoresSafeArea().navigationTitle("完了QRを読み取る").toolbar {Button("閉じる") {showScanner = false}} } }
        .alert("サポート・キャンセル",isPresented:$showReason) { TextField("理由",text:$reason);Button("送信") { Task {await mutate(reasonAction,body:["reason":reason]);reason = ""} };Button("戻る",role:.cancel) {} } message: {Text("状況を入力してください。受諾後のキャンセルはサポートが確認します。")}
    }
    private func load() async {
        error = nil
        do { request = try await env.api.client.send(.get(path));let result:MarketplaceList<Message> = try await env.api.client.send(.get(path+"/messages"));messages = result.items }
        catch { self.error = error.hdUserMessage }
    }
    private func mutate(_ action:String,body:[String:String]) async {
        guard !busy,env.network.isOnline else{return};busy = true;error = nil;defer{busy = false}
        let scope = action + (String(data:(try? JSONSerialization.data(withJSONObject:body,options:.sortedKeys)) ?? Data(),encoding:.utf8) ?? "")
        let key = keys[scope] ?? IdempotencyKey.generate();keys[scope] = key
        do { let _:MarketplaceResult = try await env.api.client.send(try .json(.post,path+"/"+action,body:body,idempotencyKey:key));keys.removeValue(forKey:scope);token = nil;await load() }
        catch { self.error = error.hdUserMessage }
    }
    private func issue() async {
        guard !busy,env.network.isOnline else{return};busy = true;error = nil;defer{busy = false}
        do { token = try await env.api.client.send(.bodyless(.post,path+"/completion-token",idempotencyKey:IdempotencyKey.generate())) }
        catch { self.error = error.hdUserMessage }
    }
    private func startScanner() async {
        let allowed: Bool
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            allowed = await AVCaptureDevice.requestAccess(for: .video)
        } else { allowed = AVCaptureDevice.authorizationStatus(for: .video) == .authorized }
        if allowed { showScanner = true } else { error = "カメラへのアクセスを許可してください。設定から変更できます。" }
    }
    private func scan(_ raw:String) async {
        guard let payload = CompletionPayload.parse(raw),payload.requestId == requestId else {error = "この依頼の完了QRではありません";return}
        await mutate("confirm",body:["token":payload.token])
    }
}

private struct CompletionQRView: View {
    let token: CompletionToken
    var body: some View {
        TimelineView(.periodic(from:.now,by:1)) { context in
            if token.isExpired(at:context.date) { Text("QRの有効期限が切れました。もう一度表示してください。").foregroundStyle(HDColor.warning) }
            else if let image = qrImage {
                Image(uiImage:image).interpolation(.none).resizable().scaledToFit().frame(maxWidth:280).padding(16).background(.white).accessibilityLabel("担当者に提示する完了確認QR")
                Text("有効期限まで \(max(0,Int(token.expiresAt.timeIntervalSince(context.date))))秒")
            } else { Text("QRを作成できません。再発行してください。") }
        }
    }
    private var qrImage:UIImage? {
        guard let data = token.qrPayload else{return nil}
        let filter = CIFilter.qrCodeGenerator();filter.message = data;filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by:CGAffineTransform(scaleX:8,y:8)),let image = CIContext().createCGImage(output,from:output.extent) else{return nil}
        return UIImage(cgImage:image)
    }
}

private struct CompletionScanner:UIViewControllerRepresentable {
    let onScan:(String)->Void
    let onError:(String)->Void
    func makeCoordinator()->Coordinator { Coordinator(onScan:onScan) }
    func makeUIViewController(context:Context)->DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes:[.barcode(symbologies:[.qr])],qualityLevel:.balanced,recognizesMultipleItems:false,isHighFrameRateTrackingEnabled:false,isPinchToZoomEnabled:true,isGuidanceEnabled:true,isHighlightingEnabled:true)
        vc.delegate = context.coordinator
        guard DataScannerViewController.isSupported,DataScannerViewController.isAvailable else{DispatchQueue.main.async{onError("カメラを利用できません。設定でカメラへのアクセスを許可してください。")};return vc}
        do{try vc.startScanning()}catch{DispatchQueue.main.async{onError("QR読取を開始できません。カメラ設定を確認してください。")}}
        return vc
    }
    func updateUIViewController(_ uiViewController:DataScannerViewController,context:Context) {}
    static func dismantleUIViewController(_ uiViewController:DataScannerViewController,coordinator:Coordinator) { uiViewController.stopScanning() }
    final class Coordinator:NSObject,DataScannerViewControllerDelegate {
        let onScan:(String)->Void
        private var scanned = false
        init(onScan:@escaping(String)->Void){self.onScan = onScan}
        func dataScanner(_ dataScanner:DataScannerViewController,didAdd addedItems:[RecognizedItem],allItems:[RecognizedItem]) {
            guard !scanned else{return}
            for item in addedItems {if case .barcode(let barcode) = item,let value = barcode.payloadStringValue {scanned = true;dataScanner.stopScanning();onScan(value);return}}
        }
    }
}
