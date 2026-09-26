// swift-tools-version: 5.9
// HappyAvatarKit — HappyDrive の音声アシスタント用アバター（SwiftUI）。
// - 状態・口の動き・感情のロジック（HappyAvatarController / HappyVoiceAvatarBridge）は Foundation + Observation のみで、
//   Linux の `swift test` でも検証できる。
// - 表示（HappyAvatarView / HappyVoiceScreen）は SwiftUI が使える環境（iOS 17 / macOS 14）でだけコンパイルする。
// - @Observable / @Bindable を使うため iOS 17 以上。
import PackageDescription

let package = Package(
    name: "HappyAvatarKit",
    defaultLocalization: "ja",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "HappyAvatarKit", targets: ["HappyAvatarKit"]),
    ],
    targets: [
        .target(
            name: "HappyAvatarKit",
            path: "Sources/HappyAvatarKit",
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency"),
            ]
        ),
        .testTarget(
            name: "HappyAvatarKitTests",
            dependencies: ["HappyAvatarKit"],
            path: "Tests/HappyAvatarKitTests",
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency"),
            ]
        ),
    ]
)
