import SwiftUI
import HappyDriveCore

struct RootView: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        Group {
            switch env.session.phase {
            case .launching:
                SplashView()
            case .signedOut:
                AuthFlowView()
            case .signedIn:
                if env.session.needsOnboardingScreen {
                    OnboardingFlowView()
                } else {
                    MainTabView()
                }
            }
        }
        .task {
            await env.session.bootstrap()
            env.syncPending()
        }
        .alert(
            "送信できなかった操作があります",
            isPresented: Binding(get: { !env.droppedMutations.isEmpty }, set: { if !$0 { env.droppedMutations.removeAll() } })
        ) {
            Button("OK", role: .cancel) { env.droppedMutations.removeAll() }
        } message: {
            Text(droppedSummary)
        }
    }

    private var droppedSummary: String {
        env.droppedMutations.map { d in
            let what: String
            switch d.mutation.kind {
            case .stopEvent: what = "配送の記録"
            case .assignmentEvent: what = "業務の記録"
            case .other: what = "操作"
            }
            return "・\(what)（\(HDFormat.dateTime(d.mutation.createdAt))）: \(d.error.userMessage)"
        }.joined(separator: "\n") + "\n\n内容を確認して、必要であれば操作し直してください。"
    }
}

struct SplashView: View {
    var body: some View {
        VStack(spacing: HDSpacing.xl) {
            Wordmark(height: 64)
            ProgressView("読み込み中…")
                .font(.hd(.subheadline))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .hdScreenBackground()
    }
}

struct MainTabView: View {
    @Environment(AppEnvironment.self) private var env

    var body: some View {
        @Bindable var router = env.router
        TabView(selection: $router.tab) {
            NavigationStack(path: $router.homePath) {
                HomeView().withAppRoutes()
            }
            .tabItem { Label("ホーム", systemImage: "house.fill") }
            .tag(AppTab.home)

            NavigationStack(path: $router.deliveryPath) {
                DeliveryView().withAppRoutes()
            }
            .tabItem { Label("配送", systemImage: "shippingbox.fill") }
            .tag(AppTab.delivery)

            NavigationStack(path: $router.jobsPath) {
                JobSearchView().withAppRoutes()
            }
            .tabItem { Label("案件", systemImage: "briefcase.fill") }
            .tag(AppTab.jobs)

            NavigationStack(path: $router.learnPath) {
                LearningHomeView().withAppRoutes()
            }
            .tabItem { Label("学ぶ", systemImage: "book.fill") }
            .tag(AppTab.learn)

            NavigationStack(path: $router.myPagePath) {
                MyPageView().withAppRoutes()
            }
            .tabItem { Label("マイページ", systemImage: "person.crop.circle.fill") }
            .tag(AppTab.myPage)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            OfflineBanner(isOnline: env.network.isOnline, pendingCount: env.pendingMutations.count)
        }
        .fullScreenCover(isPresented: $router.isVoiceAssistantPresented) {
            VoiceConversationView()
        }
    }
}

/// 全タブ共通の遷移先
struct AppRouteDestination: View {
    let route: AppRoute

    var body: some View {
        switch route {
        case .job(let id): JobDetailView(jobId: id)
        case .assignment(let id): AssignmentWorkflowView(assignmentId: id)
        case .chat(let id, let title): ChatView(assignmentId: id, title: title)
        case .stop(let id): StopDetailView(stopId: id)
        case .myAssignments: MyAssignmentsView()
        case .notifications: NotificationsView()
        case .messages: MessagesListView()
        case .earnings: EarningsView()
        case .payouts: PayoutsView()
        case .results: ResultsView()
        case .skills: SkillsView()
        case .course(let id): CourseDetailView(courseId: id)
        case .accountSettings: AccountSettingsView()
        case .verification: VerificationCenterView()
        case .support: SupportView()
        case .dailyReport: DailyReportView()
        }
    }
}

extension View {
    func withAppRoutes() -> some View {
        navigationDestination(for: AppRoute.self) { route in
            AppRouteDestination(route: route)
        }
    }
}
