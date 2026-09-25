import os
import SwiftUI
import UIKit
import HappyDriveCore

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    lazy var environment = AppEnvironment()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        HDFontRegistry.registerIfNeeded()
        environment.start()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        environment.push.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        HDLog.app.error("APNs registration failed")
    }
}

@main
struct HappyDriveApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appDelegate.environment)
                .tint(HDColor.brandBlue)
        }
        .onChange(of: scenePhase) { _, phase in
            let env = appDelegate.environment
            switch phase {
            case .active:
                env.syncPending()
                env.locationSharing.resumeIfPaused()
                Task { await env.push.refreshRegistrationIfAuthorized() }
            case .background:
                // バックグラウンドでは位置を取得しない（When In Use のみ）ため共有を止める
                env.locationSharing.pause()
            default:
                break
            }
        }
    }
}
