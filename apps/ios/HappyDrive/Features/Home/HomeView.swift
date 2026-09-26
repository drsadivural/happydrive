import MapKit
import SwiftUI
import HappyDriveCore

@Observable
@MainActor
final class HomeViewModel {
    var state: LoadState<HomeSummary> = .idle
    var todayStops: [Stop] = []

    func load(env: AppEnvironment) async {
        if state.value == nil { state = .loading }
        // 位置は許可済みの場合のみ（おおよその位置で近隣案件を探す）
        var point: GeoPoint?
        if env.location.isAuthorized, let loc = await env.location.currentLocation(maxAge: 300) {
            point = GeoPoint(latitude: loc.coordinate.latitude, longitude: loc.coordinate.longitude)
        }
        let today = HDFormat.apiDate(Date())
        let api = env.api
        let location = point
        do {
            async let summary = api.home(location: location)
            async let stops = api.stops(date: today)
            let (s, st) = try await (summary, stops)
            state = .loaded(s)
            todayStops = st
        } catch {
            if state.value == nil {
                state = .failed(error.hdUserMessage)
            }
            // 取得済みの表示は残し、配送だけはキャッシュから補う
            if todayStops.isEmpty, let cached = env.deliveryCache.load(), cached.date == today {
                todayStops = cached.stops
            }
        }
    }
}

struct HomeView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var model = HomeViewModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: HDSpacing.lg) {
                header
                if let blocker = env.session.acceptBlocker, env.session.user != nil {
                    onboardingBanner(blocker)
                }
                switch model.state {
                case .idle, .loading:
                    LoadingStateView()
                case .failed(let message):
                    ErrorStateView(message: message) { Task { await model.load(env: env) } }
                case .loaded(let summary):
                    todayCard(summary)
                    routeCard(summary)
                    if !summary.todayAssignments.isEmpty {
                        assignmentsSection(summary.todayAssignments)
                    }
                    nearbySection(summary.nearbyJobs)
                }
            }
            .padding(HDSpacing.lg)
            // 右下の「音声で話す」ボタンに最後の項目が隠れないように
            .padding(.bottom, 72)
        }
        .overlay(alignment: .bottomTrailing) {
            // 最小化した会話のミニアバターと重ならないよう、表示中は隠す（ミニアバターから開ける）
            if !env.showsVoiceMiniAvatar {
                VoiceAssistantLaunchButton()
                    .padding(HDSpacing.lg)
            }
        }
        .hdScreenBackground()
        .toolbar(.hidden, for: .navigationBar)
        .refreshable { await model.load(env: env) }
        .task { await model.load(env: env) }
    }

    // MARK: 見出し

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: HDSpacing.xs) {
                Text(HDFormat.greeting())
                    .font(.hd(.title, .bold))
                    .foregroundStyle(HDColor.textPrimary)
                Wordmark(height: 40)
                Text("今日の予定を確認して、出発しましょう")
                    .font(.hd(.subheadline))
                    .foregroundStyle(HDColor.textSecondary)
            }
            Spacer()
            HStack(spacing: 0) {
                IconBadgeButton(systemImage: "bell", label: "通知", badge: model.state.value?.unreadNotificationCount ?? 0) {
                    env.router.push(.notifications, on: .home)
                }
                IconBadgeButton(systemImage: "bubble.left.and.bubble.right", label: "メッセージ") {
                    env.router.push(.messages, on: .home)
                }
            }
        }
    }

    private func onboardingBanner(_ text: String) -> some View {
        Button {
            env.router.push(.verification, on: .myPage)
        } label: {
            HStack {
                NoticeBox(kind: .warning, text: text)
                Image(systemName: "chevron.right").foregroundStyle(HDColor.textSecondary).accessibilityHidden(true)
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint("登録状況を開きます")
    }

    // MARK: 本日の予定

    private func todayCard(_ s: HomeSummary) -> some View {
        Button {
            env.router.tab = .delivery
        } label: {
            HDHeroCard {
                Text("本日の予定")
                    .font(.hd(.subheadline, .medium))
                    .opacity(0.9)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: HDSpacing.xl) {
                        Text("配送 \(s.todayStopCount)件").font(.hd(.title2, .bold))
                        Text("案件 \(s.todayAssignments.count)件").font(.hd(.title2, .bold))
                    }
                    VStack(alignment: .leading) {
                        Text("配送 \(s.todayStopCount)件").font(.hd(.title2, .bold))
                        Text("案件 \(s.todayAssignments.count)件").font(.hd(.title2, .bold))
                    }
                }
                if s.todayStopCount > 0 {
                    Text("配達完了 \(s.todayCompletedStopCount) / \(s.todayStopCount)")
                        .font(.hd(.subheadline))
                }
                Text("予定報酬 \(HDFormat.yen(s.expectedEarningsYen))")
                    .font(.hd(.headline, .bold))
                Text("受諾済み案件の確定条件の合計です（配送の売上は含みません）")
                    .font(.hd(.caption))
                    .opacity(0.85)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("配送タブを開きます")
    }

    // MARK: 本日のルート

    private func routeCard(_ s: HomeSummary) -> some View {
        let summary = RouteSummary(route: s.todayRoute, stops: model.todayStops)
        return Button {
            env.router.tab = .delivery
        } label: {
            HDCard {
                HStack {
                    Text("本日のルート").font(.hd(.title3, .bold)).foregroundStyle(HDColor.textPrimary)
                    Spacer()
                    if summary.hasRoute {
                        Text(summary.headline).font(.hd(.footnote)).foregroundStyle(HDColor.textSecondary)
                    }
                }
                if summary.hasRoute {
                    RouteMapView(items: summary.items, interactive: false)
                        .frame(height: 180)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                } else {
                    Label(model.todayStops.isEmpty ? "今日の配送先はまだありません" : "ルートは未作成です。配送タブで作成できます", systemImage: "map")
                        .font(.hd(.subheadline))
                        .foregroundStyle(HDColor.textSecondary)
                        .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint("配送タブを開きます")
    }

    // MARK: 今日の案件

    private func assignmentsSection(_ list: [Assignment]) -> some View {
        VStack(alignment: .leading, spacing: HDSpacing.sm) {
            SectionTitle("今日の案件")
            ForEach(list) { a in
                Button {
                    env.router.push(.assignment(a.id), on: .jobs)
                } label: {
                    AssignmentRow(assignment: a)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: 近くの案件

    private func nearbySection(_ jobs: [Job]) -> some View {
        VStack(alignment: .leading, spacing: HDSpacing.sm) {
            SectionTitle("近くのHappy案件", trailing: AnyView(
                Button("すべて見る") { env.router.tab = .jobs }
                    .font(.hd(.subheadline, .semibold))
                    .frame(minHeight: 44)
            ))
            if jobs.isEmpty {
                HDCard {
                    Text(env.location.isAuthorized ? "近くに募集中の案件はありません" : "位置情報がオフのため近くの案件を表示できません。案件タブでエリア名から探せます。")
                        .font(.hd(.subheadline))
                        .foregroundStyle(HDColor.textSecondary)
                }
            }
            ForEach(jobs) { job in
                Button {
                    env.router.push(.job(job.id), on: .home)
                } label: {
                    CompactJobCard(job: job)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// ホームの近隣案件カード（タイトル・地域・所要・距離・緑の金額）
struct CompactJobCard: View {
    let job: Job

    var body: some View {
        HDCard {
            HStack(alignment: .center, spacing: HDSpacing.md) {
                VStack(alignment: .leading, spacing: HDSpacing.xs) {
                    Text(job.title)
                        .font(.hd(.headline, .bold))
                        .foregroundStyle(HDColor.textPrimary)
                    Text(meta)
                        .font(.hd(.subheadline))
                        .foregroundStyle(HDColor.textSecondary)
                }
                Spacer(minLength: HDSpacing.sm)
                PricePill(amountYen: job.amountYen)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("案件の詳細を開きます")
    }

    private var meta: String {
        var parts = [job.areaLabel, HDFormat.duration(minutes: job.effectiveDurationMinutes)]
        if let d = job.distanceKm { parts.append(HDFormat.distance(km: d)) }
        return parts.joined(separator: " • ")
    }
}

/// 割当の一覧行
struct AssignmentRow: View {
    let assignment: Assignment

    var body: some View {
        HDCard {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: HDSpacing.xs) {
                    Text(assignment.job?.title ?? "案件")
                        .font(.hd(.headline, .bold))
                        .foregroundStyle(HDColor.textPrimary)
                    if let job = assignment.job {
                        Text("\(HDFormat.schedule(job.startsAt, job.endsAt)) ・ \(job.areaLabel ?? job.organizationName)")
                            .font(.hd(.subheadline))
                            .foregroundStyle(HDColor.textSecondary)
                    }
                    StatusBadge(presentation: assignment.state.presentation, compact: true)
                }
                Spacer()
                if let amount = assignment.acceptedAmountYen {
                    Text(HDFormat.yen(amount))
                        .font(.hd(.headline, .bold))
                        .foregroundStyle(HDColor.jobGreen)
                }
                Image(systemName: "chevron.right")
                    .foregroundStyle(HDColor.textSecondary)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// AIアシスタント（音声会話）を開く浮きボタン
struct VoiceAssistantLaunchButton: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        Button {
            env.router.openVoiceAssistant()
        } label: {
            HStack(spacing: HDSpacing.sm) {
                Image(systemName: env.voice.state.isActive ? "waveform" : "mic.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .accessibilityHidden(true)
                Text("音声で話す")
                    .font(.hd(.headline, .bold))
            }
            .foregroundStyle(HDColor.onBrand)
            .padding(.horizontal, HDSpacing.xl)
            .frame(minHeight: 56)
            .background(HDColor.brandBlue, in: Capsule())
            .shadow(color: HDColor.navy.opacity(0.25), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("voiceAssistantButton")
        .accessibilityLabel("音声で話す")
        .accessibilityHint("HappyDrive AIアシスタントと音声で会話します")
    }
}
