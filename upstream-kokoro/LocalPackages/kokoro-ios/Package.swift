// swift-tools-version: 6.2
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
  name: "KokoroSwift",
  platforms: [
    .iOS(.v18), .macOS(.v15)
  ],
  products: [
    // freekoko fork: .static (was .dynamic upstream). With MisakiSwift
    // already flipped to .static, making KokoroSwift static too absorbs
    // every MLX consumer into the sidecar executable. Result: one MLX
    // copy, registered once by dyld — zero "Class X implemented in both"
    // warnings. The executable gets larger (no shared dylib), but that's
    // fine for a local sidecar that never shares its MLX with anything
    // else in the app bundle.
    .library(
      name: "KokoroSwift",
      type: .static,
      targets: ["KokoroSwift"]
    ),
  ],
  dependencies: [
    .package(url: "https://github.com/ml-explore/mlx-swift", from: "0.29.1"),
    // .package(url: "https://github.com/mlalma/eSpeakNGSwift", from: "1.0.1"),
    // freekoko fork: MisakiSwift vendored locally with type: .static so it
    // merges into libKokoroSwift.dylib instead of producing a second dylib
    // that redundantly embeds MLX. See ../MisakiSwift/Package.swift for
    // the rationale + freekoko-sidecar/NOTES.md §2.
    .package(path: "../MisakiSwift"),
    .package(url: "https://github.com/mlalma/MLXUtilsLibrary.git", from: "0.0.6")
  ],
  targets: [
    .target(
      name: "KokoroSwift",
      dependencies: [
        .product(name: "MLX", package: "mlx-swift"),
        .product(name: "MLXNN", package: "mlx-swift"),
        .product(name: "MLXRandom", package: "mlx-swift"),
        .product(name: "MLXFFT", package: "mlx-swift"),
        // .product(name: "eSpeakNGLib", package: "eSpeakNGSwift"),
        .product(name: "MisakiSwift", package: "MisakiSwift"),
        .product(name: "MLXUtilsLibrary", package: "MLXUtilsLibrary")
      ],
      resources: [
       .copy("../../Resources/")
      ]
    ),
    .testTarget(
      name: "KokoroSwiftTests",
      dependencies: ["KokoroSwift"]
    ),
  ]
)
