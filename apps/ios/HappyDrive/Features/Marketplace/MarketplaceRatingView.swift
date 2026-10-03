import SwiftUI
import HappyDriveCore
struct MarketplaceRatingView: View {
 @Environment(AppEnvironment.self) private var env
 let requestId: String
 let canRate: Bool
 @State private var score = 5
 @State private var comment = ""
 @State private var rating: Rating?
 @State private var busy = false
 @State private var error: String?
 private struct Rating: Decodable, Sendable { let score: Int; let comment: String? }
 private struct Response: Decodable, Sendable { let rating: Rating? }
 private var path: String { "/marketplace/requests/\(APIClient.pathComponent(requestId))/rating" }
 var body: some View { Section("サービスの評価") {
  if let rating { Text("\(rating.score) / 5"); if let comment = rating.comment { Text(comment) } }
  else if canRate { Picker("評価",selection:$score) { ForEach(1...5,id:\.self) { Text("\($0) / 5").tag($0) } }; TextField("コメント（任意）",text:$comment,axis:.vertical); Button("評価を送信") { Task { await submit() } }.disabled(busy || comment.count > 1000) }
  else { Text("評価はまだありません。") }
  if let error { Text(error).foregroundStyle(HDColor.danger) }
 }.task { do { let r: Response = try await env.api.client.send(.get(path)); rating = r.rating } catch { self.error = error.hdUserMessage } } }
 private func submit() async { guard !busy else { return }; busy = true; error = nil; defer { busy = false }; do { struct Input: Encodable { let score: Int; let comment: String }; let _: MarketplaceResult = try await env.api.client.send(try .json(.post,path,body:Input(score:score,comment:comment),idempotencyKey:IdempotencyKey.generate())); let r: Response = try await env.api.client.send(.get(path)); rating = r.rating } catch { self.error = error.hdUserMessage } }
}
