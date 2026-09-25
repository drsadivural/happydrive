// swift-tools-version:5.9
// HappyDriveCore — UIに依存しないロジック（モデル・APIクライアント・オフラインキュー・暗号化キャッシュ・CSV・書式）。
// Linux（swift test）と Apple プラットフォームの両方でビルドできることを前提とする。
import PackageDescription

let package = Package(
    name: "HappyDriveCore",
    defaultLocalization: "ja",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "HappyDriveCore", targets: ["HappyDriveCore"]),
    ],
    dependencies: [
        // Apple の CryptoKit と同一 API。Apple プラットフォームでは CryptoKit を再エクスポートする。
        .package(url: "https://github.com/apple/swift-crypto.git", "3.0.0" ..< "4.0.0"),
    ],
    targets: [
        .target(
            name: "HappyDriveCore",
            dependencies: [
                .product(name: "Crypto", package: "swift-crypto"),
            ],
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency"),
            ]
        ),
        .testTarget(
            name: "HappyDriveCoreTests",
            dependencies: ["HappyDriveCore"],
            resources: [.copy("Fixtures")],
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency"),
            ]
        ),
    ]
)
