import Foundation
import SwiftUI
import HappyDriveCore

enum AppTab: Hashable {
    case home, delivery, jobs, learn, myPage
}

/// 画面遷移先（各タブの NavigationStack で共通に使う）
enum AppRoute: Hashable {
    case job(String)
    case assignment(String)
    case chat(assignmentId: String, title: String)
    case stop(String)
    case myAssignments
    case notifications
    case messages
    case earnings
    case payouts
    case results
    case skills
    case course(String)
    case accountSettings
    case verification
    case support
    case dailyReport
}

@Observable
@MainActor
final class AppRouter {
    var tab: AppTab = .home
    var homePath = NavigationPath()
    var deliveryPath = NavigationPath()
    var jobsPath = NavigationPath()
    var learnPath = NavigationPath()
    var myPagePath = NavigationPath()

    func push(_ route: AppRoute, on tab: AppTab? = nil) {
        let target = tab ?? self.tab
        self.tab = target
        switch target {
        case .home: homePath.append(route)
        case .delivery: deliveryPath.append(route)
        case .jobs: jobsPath.append(route)
        case .learn: learnPath.append(route)
        case .myPage: myPagePath.append(route)
        }
    }

    func popToRoot(_ tab: AppTab) {
        switch tab {
        case .home: homePath = NavigationPath()
        case .delivery: deliveryPath = NavigationPath()
        case .jobs: jobsPath = NavigationPath()
        case .learn: learnPath = NavigationPath()
        case .myPage: myPagePath = NavigationPath()
        }
    }

    /// 通知タップ等からの遷移
    func open(_ link: DeepLink) {
        switch link {
        case .assignment(let id):
            popToRoot(.jobs)
            push(.assignment(id), on: .jobs)
        case .assignmentChat(let id):
            popToRoot(.jobs)
            push(.assignment(id), on: .jobs)
            push(.chat(assignmentId: id, title: "メッセージ"), on: .jobs)
        case .job(let id):
            popToRoot(.jobs)
            push(.job(id), on: .jobs)
        case .stop(let id):
            popToRoot(.delivery)
            push(.stop(id), on: .delivery)
        case .earnings:
            popToRoot(.myPage)
            push(.earnings, on: .myPage)
        case .notifications:
            popToRoot(.home)
            push(.notifications, on: .home)
        case .verification:
            popToRoot(.myPage)
            push(.verification, on: .myPage)
        case .supportTickets:
            popToRoot(.myPage)
            push(.support, on: .myPage)
        }
    }
}
