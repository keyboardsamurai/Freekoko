// swift-tools-version: 6.0
// freekoko-sidecar
//
// HTTP sidecar that wraps the upstream KokoroEngine actor and exposes
// POST /tts, GET /voices, GET /health on localhost:5002.

import PackageDescription

let package = Package(
    name: "freekoko-sidecar",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(
            name: "freekoko-sidecar",
            targets: ["FreekokoSidecar"]
        )
    ],
    dependencies: [
        // Upstream KokoroVoice package exposes KokoroVoiceShared (KokoroEngine,
        // Constants, VoiceConfiguration) and transitively pulls in KokoroSwift,
        // MLX, MisakiSwift, MLXUtilsLibrary.
        .package(path: "../upstream-kokoro"),
        .package(url: "https://github.com/hummingbird-project/hummingbird", from: "2.5.0"),
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.3.0"),
    ],
    targets: [
        .executableTarget(
            name: "FreekokoSidecar",
            dependencies: [
                .product(name: "KokoroVoiceShared", package: "upstream-kokoro"),
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/FreekokoSidecar"
        ),
        .testTarget(
            name: "FreekokoSidecarTests",
            dependencies: ["FreekokoSidecar"],
            path: "Tests/FreekokoSidecarTests"
        ),
    ]
)
