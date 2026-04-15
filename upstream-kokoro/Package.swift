// swift-tools-version: 6.0
// Package.swift - For testing shared components without Xcode project

import PackageDescription

let package = Package(
    name: "KokoroVoice",
    platforms: [
        .macOS(.v15),
        .iOS(.v18)
    ],
    products: [
        .library(
            name: "KokoroVoiceShared",
            targets: ["KokoroVoiceShared"]
        ),
        .library(
            name: "KokoroVoiceExtension",
            targets: ["KokoroVoiceExtension"]
        ),
    ],
    dependencies: [
        // Use local patched version (removed MLXFast import, now part of MLX)
        .package(path: "LocalPackages/kokoro-ios"),
        // NOTE: pinned to 0.0.6 (rather than branch: "main") because
        // MLXUtilsLibrary's main branch / 0.0.7 removed BenchmarkTimer,
        // which KokoroSwift still references. Upstream KokoroVoice's
        // branch-based pin causes the version chosen during SPM
        // resolution to differ from what KokoroSwift actually needs.
        // See freekoko-sidecar/NOTES.md for details.
        .package(url: "https://github.com/mlalma/MLXUtilsLibrary.git", exact: "0.0.6"),
    ],
    targets: [
        // Shared library with constants, voice configuration, and engine wrapper
        .target(
            name: "KokoroVoiceShared",
            dependencies: [
                .product(name: "KokoroSwift", package: "kokoro-ios"),
                .product(name: "MLXUtilsLibrary", package: "MLXUtilsLibrary"),
            ],
            path: "Shared"
        ),

        // Extension with SSML parser and Audio Unit
        .target(
            name: "KokoroVoiceExtension",
            dependencies: [
                "KokoroVoiceShared",
                .product(name: "KokoroSwift", package: "kokoro-ios"),
            ],
            path: "KokoroVoiceExtension",
            exclude: [
                "Info.plist",
                "KokoroVoiceExtension.entitlements"
            ]
        ),

        // Unit tests
        .testTarget(
            name: "SSMLParserTests",
            dependencies: ["KokoroVoiceExtension"],
            path: "Tests/SSMLParserTests"
        ),

        .testTarget(
            name: "VoiceConfigurationTests",
            dependencies: ["KokoroVoiceShared"],
            path: "Tests/VoiceConfigurationTests"
        ),

        .testTarget(
            name: "StreamingAudioBufferTests",
            dependencies: ["KokoroVoiceShared"],
            path: "Tests/StreamingAudioBufferTests"
        ),
    ]
)
