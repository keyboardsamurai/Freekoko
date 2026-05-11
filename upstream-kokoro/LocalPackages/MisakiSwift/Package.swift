// swift-tools-version: 6.2
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
  name: "MisakiSwift",
  platforms: [
    .iOS(.v18), .macOS(.v15)
  ],
  products: [
    // freekoko fork: .static (was .dynamic upstream) so MisakiSwift's code
    // and its statically-linked copy of mlx-swift get absorbed into the
    // single consumer dylib (libKokoroSwift.dylib). Upstream shipped this
    // as a dynamic library, which caused MLX ObjC classes to be
    // registered twice at dyld load (once from libMisakiSwift.dylib, once
    // from libKokoroSwift.dylib), triggering "Class X is implemented in
    // both" warnings and two independent Metal buffer caches that
    // exhausted the allocator mid-stream.
    .library(
      name: "MisakiSwift",
      type: .static,
      targets: ["MisakiSwift"]
    ),
  ],
  dependencies: [
    .package(url: "https://github.com/ml-explore/mlx-swift", exact: "0.30.2"),
    .package(url: "https://github.com/mlalma/MLXUtilsLibrary.git", exact: "0.0.6")
  ],
  targets: [
    .target(
      name: "MisakiSwift",
      dependencies: [
        .product(name: "MLX", package: "mlx-swift"),
        .product(name: "MLXNN", package: "mlx-swift"),
        .product(name: "MLXUtilsLibrary", package: "MLXUtilsLibrary")
     ],
     resources: [
      .copy("../../Resources/")
     ]
    ),
    .testTarget(
      name: "MisakiSwiftTests",
      dependencies: ["MisakiSwift"]
    ),
  ]
)
