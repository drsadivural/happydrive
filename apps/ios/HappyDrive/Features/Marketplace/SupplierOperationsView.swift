import SwiftUI
import PhotosUI
import UIKit
import HappyDriveCore

private struct SupplierApplication: Codable, Sendable {
    var businessCategory = ""; var registrationNumber: String?; var areaCodes: [String] = []; var openingHours = ""; var insuranceSummary = ""; var contactEmail = ""; var description = ""
}
private struct ApplicationViewData: Decodable, Sendable { let reviewStatus: String; let application: SupplierApplication?; let evidenceIds: [String]; let reviewReason: String? }
private struct SupplierStaff: Decodable, Sendable, Identifiable { let id: String; let familyName: String; let givenName: String; let role: String }
private struct StaffInvite: Decodable, Sendable, Identifiable { let id: String; let phone: String; let expiresAt: Date; let acceptedAt: Date?; let revokedAt: Date? }
private struct StaffSchedule: Decodable, Sendable, Identifiable { let id: String; let staffName: String; let startsAt: Date; let endsAt: Date }

struct SupplierOperationsView: View {
    @Environment(AppEnvironment.self) private var env
    let supplierId: String
    let role: String
    @State private var staff: [SupplierStaff] = []
    @State private var invitations: [StaffInvite] = []
    @State private var schedule: [StaffSchedule] = []
    @State private var application = SupplierApplication()
    @State private var docs: [String] = []
    @State private var reviewStatus = ""
    @State private var reviewReason: String?
    @State private var areas = ""
    @State private var photo: PhotosPickerItem?
    @State private var phone = ""
    @State private var inviteRole = "staff"
    @State private var token = ""
    @State private var selectedStaff = ""
    @State private var startsAt = Date()
    @State private var endsAt = Date().addingTimeInterval(3600)
    @State private var error: String?
    @State private var busy = false
    @State private var removing: SupplierStaff?
    @State private var showRemoval = false
    @State private var removalReason = ""
    private var manage: Bool { role == "owner" || role == "manager" }
    private var path: String { "/marketplace/suppliers/\(APIClient.pathComponent(supplierId))" }
    var body: some View {
        Form {
            if let error { Section { Text(error).foregroundStyle(HDColor.danger); Button("再読み込み") { Task { await load() } } } }
            if manage {
                Section("事業者の申請") {
                    Text(reviewStatus == "approved" ? "承認済み" : reviewStatus == "rejected" ? "差戻し" : "審査待ち")
                    if let reviewReason { Text(reviewReason) }
                    if reviewStatus != "approved" {
                        TextField("事業分類", text: $application.businessCategory)
                        TextField("登録番号（任意）", text: Binding(get: { application.registrationNumber ?? "" }, set: { application.registrationNumber = $0.isEmpty ? nil : $0 }))
                        TextField("作業エリアコード（カンマ区切り）", text: $areas)
                        TextField("営業時間", text: $application.openingHours)
                        TextField("保険・安全管理", text: $application.insuranceSummary, axis: .vertical)
                        TextField("連絡先メール", text: $application.contactEmail).textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                        TextField("事業内容・訪問方法", text: $application.description, axis: .vertical)
                        PhotosPicker("審査書類の写真を追加", selection: $photo, matching: .images).disabled(busy)
                        Text("登録済みの書類: \(docs.count)件")
                        Button("申請を提出") { Task { await submitApplication() } }.disabled(busy || docs.isEmpty || application.businessCategory.isEmpty || areas.isEmpty || application.openingHours.isEmpty || application.insuranceSummary.isEmpty || application.contactEmail.isEmpty || application.description.isEmpty)
                    }
                }
                Section("担当者の招待") {
                    Text("相手は招待された電話番号をSMSで確認してから参加します。")
                    TextField("招待する電話番号", text: $phone).keyboardType(.phonePad)
                    Picker("権限", selection: $inviteRole) { Text("担当者").tag("staff"); if role == "owner" { Text("管理者").tag("manager") } }
                    Button("招待コードを作成") { Task { await invite() } }.disabled(busy || phone.isEmpty)
                    if !token.isEmpty { Text(token).textSelection(.enabled); Button("招待コードをコピー") { UIPasteboard.general.string = token }; Text("7日以内に招待した相手へ安全に共有してください。") }
                    ForEach(invitations) { invite in HStack { Text(invite.phone); Spacer(); if invite.acceptedAt != nil { Text("参加済み") } else if invite.revokedAt != nil { Text("無効") } else { Button("取消", role: .destructive) { Task { await change("/invitations/\(invite.id)/revoke", body: [String:String]()) } }.disabled(busy) } } }
                }
                Section("担当者") { ForEach(staff) { member in VStack(alignment: .leading) { Text("\(member.familyName) \(member.givenName)"); Text(member.role == "owner" ? "オーナー" : member.role == "manager" ? "管理者" : "担当者").font(.caption); if member.role != "owner", role == "owner" || member.role == "staff" { Button("参加を解除",role:.destructive) { removing = member; removalReason = ""; showRemoval = true }.disabled(busy) } } } }
            }
            Section("対応時間") {
                if schedule.isEmpty { Text("対応時間は未登録です。") }
                ForEach(schedule) { entry in VStack(alignment: .leading) { Text(entry.staffName); Text("\(HDFormat.dateTime(entry.startsAt))〜\(HDFormat.dateTime(entry.endsAt))"); if manage { Button("この対応時間を削除", role: .destructive) { Task { await change("/availability/\(entry.id)/remove", body: [String:String]()) } }.disabled(busy) } } }
                if manage {
                    Picker("担当者", selection: $selectedStaff) { ForEach(staff) { Text("\($0.familyName) \($0.givenName)").tag($0.id) } }
                    DatePicker("開始", selection: $startsAt)
                    DatePicker("終了", selection: $endsAt, in: startsAt...)
                    Button("対応時間を登録") { Task { await addAvailability() } }.disabled(busy || selectedStaff.isEmpty || startsAt >= endsAt)
                }
            }
        }.navigationTitle("申請・担当者・予定").task { await load() }.refreshable { await load() }
        .task(id: photo) { await uploadPhoto() }
        .alert("担当者の参加を解除",isPresented:$showRemoval,presenting:removing) { member in TextField("解除理由",text:$removalReason); Button("解除",role:.destructive) { Task { await change("/members/\(APIClient.pathComponent(member.id))/deactivate",body:["reason":removalReason]) } }.disabled(removalReason.isEmpty); Button("戻る",role:.cancel) {} } message: { _ in Text("担当中の依頼がある場合は運営へ引継ぎを相談してください。") }
    }
    private func load() async {
        do {
            let s: MarketplaceList<StaffSchedule> = try await env.api.client.send(.get(path + "/availability")); schedule = s.items
            if manage {
                let m: MarketplaceList<SupplierStaff> = try await env.api.client.send(.get(path + "/members")); staff = m.items; selectedStaff = staff.first?.id ?? ""
                let i: MarketplaceList<StaffInvite> = try await env.api.client.send(.get(path + "/invitations")); invitations = i.items
                let a: ApplicationViewData = try await env.api.client.send(.get(path + "/application")); reviewStatus = a.reviewStatus; reviewReason = a.reviewReason; docs = a.evidenceIds
                if let value = a.application { application = value; areas = value.areaCodes.joined(separator: ",") }
            }
        } catch { self.error = error.hdUserMessage }
    }
    private func change<Input: Encodable>(_ suffix: String, body: Input, method: HTTPMethod = .post) async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do { let _: MarketplaceResult = try await env.api.client.send(try .json(method, path + suffix, body: body, idempotencyKey: IdempotencyKey.generate())); await load() }
        catch { self.error = error.hdUserMessage }
    }
    private func submitApplication() async {
        var value = application; value.areaCodes = areas.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        struct Input: Encodable { let businessCategory: String; let registrationNumber: String?; let areaCodes: [String]; let openingHours: String; let insuranceSummary: String; let contactEmail: String; let description: String; let evidenceIds: [String] }
        await change("/application", body: Input(businessCategory: value.businessCategory, registrationNumber: value.registrationNumber, areaCodes: value.areaCodes, openingHours: value.openingHours, insuranceSummary: value.insuranceSummary, contactEmail: value.contactEmail, description: value.description, evidenceIds: docs), method: .put)
    }
    private func invite() async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do { struct Result: Decodable { let token: String }; let r: Result = try await env.api.client.send(try .json(.post, path + "/invitations", body: ["phone":phone,"role":inviteRole], idempotencyKey: IdempotencyKey.generate())); token = r.token; await load() }
        catch { self.error = error.hdUserMessage }
    }
    private func addAvailability() async {
        struct Input: Encodable { let staffId: String; let startsAt: Date; let endsAt: Date }
        await change("/availability", body: Input(staffId:selectedStaff,startsAt:startsAt,endsAt:endsAt))
    }
    private func uploadPhoto() async {
        guard let photo else { return }; busy = true; error = nil; defer { busy = false }
        do {
            guard let data = try await photo.loadTransferable(type: Data.self), let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.85), jpeg.count <= 15_000_000 else { error = "15MB以内の写真を選択してください"; return }
            let evidence = try await env.api.uploadEvidence(data:jpeg,contentType:.jpeg,purpose:.identity_document)
            docs.append(evidence.id)
        } catch { self.error = error.hdUserMessage }
    }
}

struct SupplierRegistrationView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var legalName = ""; @State private var address = ""; @State private var type = "company"; @State private var error: String?; @State private var busy = false
    var body: some View { Form { TextField("事業者名",text:$legalName); Picker("事業区分",selection:$type) { Text("法人").tag("company"); Text("個人事業主").tag("sole_proprietor") }; TextField("所在地",text:$address); if let error { Text(error).foregroundStyle(HDColor.danger) }; Button("事業者を登録して申請へ") { Task { busy = true; defer { busy = false }; do { let _: MarketplaceResult = try await env.api.client.send(try .json(.post,"/marketplace/suppliers",body:["legalName":legalName,"supplierType":type,"address":address],idempotencyKey:IdempotencyKey.generate())); dismiss() } catch { self.error = error.hdUserMessage } } }.disabled(busy || legalName.isEmpty || address.isEmpty) }.navigationTitle("供給者の登録") }
}
struct SupplierJoinView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var token = ""; @State private var error: String?; @State private var busy = false
    var body: some View { Form { Text("招待された電話番号をSMSで確認し、顧客プロフィールを登録してから参加してください。"); TextField("招待コード",text:$token).textInputAutocapitalization(.never).autocorrectionDisabled(); if let error { Text(error).foregroundStyle(HDColor.danger) }; Button("招待された事業者に参加") { Task { busy = true; defer { busy = false }; do { let _: MarketplaceResult = try await env.api.client.send(try .json(.post,"/marketplace/suppliers/join",body:["token":token],idempotencyKey:IdempotencyKey.generate())); dismiss() } catch { self.error = error.hdUserMessage } } }.disabled(busy || token.count != 43) }.navigationTitle("事業者の招待") }
}
