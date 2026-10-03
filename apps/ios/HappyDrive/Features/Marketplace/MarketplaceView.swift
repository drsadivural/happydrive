import SwiftUI
import HappyDriveCore
import CoreImage.CIFilterBuiltins
import VisionKit
import Vision

struct MarketplaceRootView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var mode = "customer"
    @State private var section = "home"
    @State private var account: MarketplaceAccount?
    @State private var catalog: [MarketplaceService] = []
    @State private var requests: [MarketplaceRequest] = []
    @State private var services: [MarketplaceService] = []
    @State private var feed: [MarketplaceRequest] = []
    @State private var supplierId = ""
    @State private var loading = true
    @State private var busy = false
    @State private var error: String?
    @State private var showDelivery = false
    @State private var showPhoneLogin = false
    @State private var familyName = ""
    @State private var givenName = ""
    @State private var address = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Wordmark(height: 40)
                    Text(mode == "customer" ? "毎日の暮らしに、頼れる支援を。" : "供給者ワークスペース")
                        .font(.title2.bold())
                    Picker("利用モード", selection: $mode) {
                        Text("顧客").tag("customer")
                        Text("供給者").tag("supplier")
                    }.pickerStyle(.segmented)
                    Picker("表示", selection: $section) {
                        Text("ホーム").tag("home")
                        Text(mode == "customer" ? "サービス" : "募集中").tag("catalog")
                        Text("依頼履歴").tag("requests")
                        Text("アカウント").tag("account")
                    }.pickerStyle(.segmented)
                }
                if loading { ProgressView("読み込み中…") }
                if let error { Section { Text(error).foregroundStyle(HDColor.danger); Button("再読み込み") { Task { await load() } } } }
                if mode == "supplier", let suppliers = account?.suppliers, !suppliers.isEmpty {
                    Picker("供給者", selection: $supplierId) { ForEach(suppliers) { Text($0.legalName).tag($0.id) } }
                }
                if section == "home" {
                    Section("暮らしのサポート") {
                        Label("買い物・訪問・配送などのサービス", systemImage: "heart.fill")
                        Text("審査済みの事業者が日々の暮らしを支えます。")
                        Button("サービス・依頼を見る") { section = "catalog" }
                    }
                    Section("進行中の依頼") {
                        if requests.isEmpty { Text("依頼はまだありません。") }
                        ForEach(requests) { request in requestLink(request) }
                    }
                    Section { Button("配送ワークスペースを開く") { showDelivery = true } }
                }
                if section == "catalog" {
                    if mode == "customer" {
                        Section("利用できるサービス") {
                            if catalog.isEmpty { Text("サービスの準備中です。公開後に表示されます。") }
                            ForEach(catalog) { service in
                                NavigationLink { MarketplacePostView(service: service).environment(env) } label: {
                                    VStack(alignment: .leading, spacing: 8) {
                                        Text(service.name).font(.headline)
                                        Text(service.description).font(.body)
                                        Text(service.supplierName ?? "").font(.caption).foregroundStyle(.secondary)
                                        Text("\(service.durationMinutes)分 · \(service.pricePolicy)").font(.caption)
                                    }.padding(.vertical, 8)
                                }
                            }
                        }
                    } else {
                        Section("募集中の依頼") {
                            if feed.isEmpty { Text("対応可能な依頼はありません。") }
                            ForEach(feed) { request in
                                NavigationLink { MarketplaceAcceptView(request: request, supplierId: supplierId).environment(env) } label: {
                                    VStack(alignment: .leading) { Text(request.title).font(.headline); Text(request.areaCode); Text(HDFormat.dateTime(request.startsAt)) }
                                }
                            }
                        }
                        Section("登録サービス") {
                            ForEach(services) { service in VStack(alignment: .leading) { Text(service.name); Text(service.status == "published" ? "公開中" : "審査中").foregroundStyle(.secondary) } }
                            if !supplierId.isEmpty { NavigationLink("サービスを登録") { MarketplaceServiceForm(supplierId: supplierId).environment(env) } }
                        }
                    }
                }
                if section == "requests" { Section("依頼履歴") { if requests.isEmpty { Text("依頼はまだありません。") }; ForEach(requests) { request in requestLink(request) } } }
                if section == "account" {
                    Section("プロフィール") {
                        GoogleSignInButton(link: true)
                        if let profile = account?.profile { Text("\(profile.familyName) \(profile.givenName)") }
                        else {
                            Button("電話番号をSMSで確認") { showPhoneLogin = true }
                            TextField("姓", text: $familyName).textContentType(.familyName)
                            TextField("名", text: $givenName).textContentType(.givenName)
                            TextField("住所", text: $address).textContentType(.fullStreetAddress)
                            Button("顧客プロフィールを保存") { Task { await register() } }.disabled(busy || familyName.isEmpty || givenName.isEmpty || address.isEmpty)
                        }
                    }
                    Section("会員プラン") {
                        plan("ベーシック", 1900, "月5件")
                        plan("スタンダード", 4900, "月12件")
                        plan("ケア", 9900, "月間上限なし・1日2件")
                        Text("顧客は初回30日無料、供給者は初回7日無料。個別サービス料金・契約条件の確定後にお申込みいただけます。")
                        if let sub = account?.subscription { Text("契約: \(sub.planCode)"); if let end = sub.trialEndsAt { Text("無料期間終了: \(HDFormat.dateTime(end))") } }
                    }
                    Section {
                        NavigationLink("アカウント設定・退会") { AccountSettingsView() }
                        Button("配送・企業の機能を開く") { showDelivery = true }
                    }
                }
            }
            .navigationTitle("HappyDrive")
            .refreshable { await load() }
            .task { await load() }
            .onChange(of: supplierId) { Task { await loadSupplier() } }
            .sheet(isPresented: $showPhoneLogin, onDismiss: { Task { await load() } }) { MarketplacePhoneLogin().environment(env) }
            .fullScreenCover(isPresented: $showDelivery) {
                MainTabView().environment(env).safeAreaInset(edge: .top) { Button("暮らしの支援に戻る") { showDelivery = false }.padding().frame(maxWidth: .infinity).background(.regularMaterial) }
            }
        }
    }
    private func requestLink(_ request: MarketplaceRequest) -> some View {
        NavigationLink { MarketplaceRequestView(requestId: request.id).environment(env) } label: {
            VStack(alignment: .leading, spacing: 6) { Text(request.title).font(.headline); Text(MarketplaceStatus.label(request.status)).foregroundStyle(.secondary); Text(HDFormat.dateTime(request.startsAt)).font(.caption) }
        }
    }
    private func plan(_ name: String, _ price: Int, _ limit: String) -> some View { VStack(alignment: .leading) { Text(name).font(.headline); Text("¥\(price.formatted())/月 · \(limit)") } }
    private func load() async {
        loading = true; error = nil; defer { loading = false }
        do {
            async let a: MarketplaceAccount = env.api.client.send(.get("/marketplace/me"))
            async let c: MarketplaceList<MarketplaceService> = env.api.client.send(.get("/marketplace/catalog"))
            async let r: MarketplaceList<MarketplaceRequest> = env.api.client.send(.get("/marketplace/requests"))
            let result = try await (a,c,r); account = result.0; catalog = result.1.items; requests = result.2.items
            if supplierId.isEmpty { supplierId = account?.suppliers.first?.id ?? "" }
            await loadSupplier()
        } catch { self.error = error.hdUserMessage }
    }
    private func loadSupplier() async {
        guard !supplierId.isEmpty else { services = []; feed = []; return }
        do {
            let id = APIClient.pathComponent(supplierId)
            async let s: MarketplaceList<MarketplaceService> = env.api.client.send(.get("/marketplace/suppliers/\(id)/services"))
            async let f: MarketplaceList<MarketplaceRequest> = env.api.client.send(.get("/marketplace/suppliers/\(id)/feed"))
            let result = try await (s,f); services = result.0.items; feed = result.1.items
        } catch { self.error = error.hdUserMessage }
    }
    @State private var registrationKey = IdempotencyKey.generate()
    private func register() async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do {
            let _: MarketplaceResult = try await env.api.client.send(try .json(.put,"/marketplace/customer",body:["familyName":familyName,"givenName":givenName,"address":address],idempotencyKey:registrationKey))
            registrationKey = IdempotencyKey.generate(); await load()
        } catch { self.error = error.hdUserMessage }
    }
}

struct MarketplacePhoneLogin: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var phone = ""
    @State private var code = ""
    @State private var sent = false
    @State private var busy = false
    @State private var error: String?
    @State private var resendAt = Date.distantPast
    var body: some View {
        NavigationStack {
            Form {
                if env.session.phase != .signedIn { Section { GoogleSignInButton(onSuccess: { dismiss() }) } }
                Section(env.session.phase == .signedIn ? "電話番号を確認" : "電話番号でログイン") {
                    TextField("09012345678",text:$phone).keyboardType(.phonePad).textContentType(.telephoneNumber).disabled(sent)
                    if sent { TextField("SMSの6桁の確認コード",text:$code).keyboardType(.numberPad).textContentType(.oneTimeCode) }
                    if let error { Text(error).foregroundStyle(HDColor.danger) }
                    Button(sent ? "ログイン" : "確認コードを送信") { Task { await submit() } }.disabled(busy || phone.isEmpty || (sent && code.count != 6))
                    if sent { Button("番号を変更・再送信") { if Date() >= resendAt { sent = false; code = "" } else { error = "再送信まで少しお待ちください" } } }
                }
            }.navigationTitle("ログイン・電話番号の確認").toolbar { Button("閉じる") { dismiss() } }
        }
    }
    private func submit() async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do {
            if sent { let result = try await (env.session.phase == .signedIn ? env.api.linkPhone(phone:phone,code:code,deviceName:SessionStore.deviceName) : env.api.verifyOTP(phone:phone,code:code,deviceName:SessionStore.deviceName)); env.session.signedIn(result); dismiss() }
            else { let r = try await env.api.requestOTP(phone:phone); sent = true; resendAt = Date().addingTimeInterval(TimeInterval(r.resendAfterSeconds)) }
        } catch { self.error = error.hdUserMessage }
    }
}

struct MarketplacePostView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let service: MarketplaceService
    @State private var title = ""
    @State private var details = ""
    @State private var address = ""
    @State private var area = ""
    @State private var start = Date().addingTimeInterval(3600)
    @State private var end = Date().addingTimeInterval(7200)
    @State private var busy = false
    @State private var error: String?
    @State private var key = IdempotencyKey.generate()
    var body: some View {
        Form {
            Section(service.name) { Text(service.pricePolicy); Text("投稿時に依頼枠を予約し、完了QRの確認後に消費します。") }
            Section("依頼の内容") {
                TextField("タイトル",text:$title)
                TextField("内容・注意事項",text:$details,axis:.vertical)
                TextField("現場住所",text:$address).textContentType(.fullStreetAddress)
                Picker("対象地域",selection:$area) { ForEach(service.areaCodes,id:\.self) { Text($0).tag($0) } }
                DatePicker("開始",selection:$start,in:Date()...)
                DatePicker("終了",selection:$end,in:start...)
            }
            Section {
                Text("サービス料金・契約条件の確定後に受付を開始します。")
                if let error { Text(error).foregroundStyle(HDColor.danger) }
                Button("依頼を投稿") { Task { await post() } }.disabled(busy || title.isEmpty || details.isEmpty || address.isEmpty || area.isEmpty || !env.network.isOnline)
            }
        }.navigationTitle("依頼する").onAppear { area = service.areaCodes.first ?? "" }
    }
    private struct Input: Encodable { let serviceId:String;let title:String;let details:String;let address:String;let areaCode:String;let startsAt:Date;let endsAt:Date }
    private func post() async {
        guard !busy else { return };busy = true;error = nil;defer { busy = false }
        do {
            let _:MarketplaceResult = try await env.api.client.send(try .json(.post,"/marketplace/requests",body:Input(serviceId:service.id,title:title,details:details,address:address,areaCode:area,startsAt:start,endsAt:end),idempotencyKey:key))
            dismiss()
        } catch { self.error = error.hdUserMessage }
    }
}
