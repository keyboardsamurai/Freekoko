SIDECAR_DIR   := freekoko-sidecar
APP_DIR       := freekoko-app
UPSTREAM_DIR  := upstream-kokoro
RESOURCES_SRC := $(UPSTREAM_DIR)/Resources
SIDECAR_BIN   := $(SIDECAR_DIR)/.build/arm64-apple-macosx/release/freekoko-sidecar

.PHONY: all sidecar sidecar-release app dmg dmg-dir dev clean check-deps download-models test help

help:
	@echo "freekoko — open-source Kokoro TTS desktop app"
	@echo ""
	@echo "Targets:"
	@echo "  make check-deps       Verify Swift + Node.js prerequisites"
	@echo "  make download-models  Fetch Kokoro weights + voice embeddings (~326 MB)"
	@echo "  make sidecar          Build Swift HTTP server (release, arm64)"
	@echo "  make app              Build Electron app bundle"
	@echo "  make dev              Run sidecar + Electron in dev mode"
	@echo "  make test             Run unit tests in both projects"
	@echo "  make dmg              Produce distributable .dmg"
	@echo "  make dmg-dir          Produce unpacked .app only (smoke test)"
	@echo "  make clean            Remove build artifacts"

all: check-deps sidecar app

sidecar:
	@echo "Building Swift sidecar (Release arm64 via xcodebuild)..."
	# We use xcodebuild rather than `swift build -c release` because xcodebuild
	# automatically compiles MLX's .metal shaders into default.metallib (the
	# runtime Metal shader library). SPM's Cmlx target explicitly excludes
	# those sources (see mlx-swift/Package.swift: "see PrepareMetalShaders --
	# don't build the kernels in place"), so `swift build` alone would produce
	# a binary that can't load its GPU kernels and logs "MLX error: Failed to
	# load the default metallib" on launch. xcodebuild is slower but correct.
	cd $(SIDECAR_DIR) && xcodebuild \
	  -scheme freekoko-sidecar \
	  -configuration Release \
	  -derivedDataPath .build/xcode-release \
	  -destination 'platform=macOS,arch=arm64' \
	  -quiet \
	  build
	# Stage the binary and renamed metallib at the SPM-style path that
	# electron-builder's extraResources entry and afterPack hook already
	# expect. This keeps the release pipeline agnostic of whether SPM or
	# xcodebuild produced the artifacts.
	@mkdir -p $(SIDECAR_DIR)/.build/arm64-apple-macosx/release
	cp $(SIDECAR_DIR)/.build/xcode-release/Build/Products/Release/freekoko-sidecar \
	   $(SIDECAR_BIN)
	cp $(SIDECAR_DIR)/.build/xcode-release/Build/Products/Release/mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib \
	   $(SIDECAR_DIR)/.build/arm64-apple-macosx/release/mlx.metallib
	@test -x $(SIDECAR_BIN) || { echo "ERROR: sidecar binary missing at $(SIDECAR_BIN)"; exit 1; }
	@test -f $(SIDECAR_DIR)/.build/arm64-apple-macosx/release/mlx.metallib || \
	  { echo "ERROR: mlx.metallib missing"; exit 1; }
	@echo "Binary: $(SIDECAR_BIN)"
	@echo "Verifying binary is relocatable (no build-tree absolute paths)..."
	@otool -L $(SIDECAR_BIN) | awk 'NR>1 && $$1 !~ /^@rpath/ && $$1 !~ /^\/usr\// && $$1 !~ /^\/System\//' | \
	  { grep -q . && echo "WARN: absolute dylib paths remain (afterPack will rewrite)"; true; } || true

# Alias kept for clarity; matches the naming convention used in the P6 brief.
sidecar-release: sidecar

app:
	@echo "Building Electron app..."
	cd $(APP_DIR) && npm ci && npm run build

dmg: sidecar app
	@test -f $(RESOURCES_SRC)/kokoro-v1_0.safetensors || \
	  { echo "ERROR: Model weights not found. Run: make download-models"; exit 1; }
	@test -x $(SIDECAR_BIN) || \
	  { echo "ERROR: release sidecar missing at $(SIDECAR_BIN)"; exit 1; }
	cd $(APP_DIR) && npm run package:mac
	@echo "DMG ready in $(APP_DIR)/dist/"

# Produces an unpacked .app for smoke-testing electron-builder config.
# Does NOT produce a DMG. Does NOT require model weights — electron-builder
# will warn on missing extraResources and continue.
dmg-dir: sidecar app
	cd $(APP_DIR) && npm run package:mac:dir
	@echo "Unpacked .app ready in $(APP_DIR)/dist/mac-arm64/"

dev:
	@echo "Starting dev environment (Ctrl-C to quit)..."
	@trap 'kill 0' INT; \
	  (cd $(SIDECAR_DIR) && swift build && \
	   .build/debug/freekoko-sidecar \
	     --port 5002 \
	     --resources-dir ../$(RESOURCES_SRC)) & \
	  (cd $(APP_DIR) && npm run dev) & \
	  wait

test:
	cd $(SIDECAR_DIR) && swift test
	cd $(APP_DIR) && npm test

download-models:
	@bash scripts/download-models.sh

clean:
	-cd $(SIDECAR_DIR) && swift package clean
	-cd $(APP_DIR) && rm -rf dist/ out/ node_modules/.cache

check-deps:
	@command -v swift >/dev/null 2>&1 || { echo "ERROR: Swift not found (install Xcode Command Line Tools)"; exit 1; }
	@command -v node  >/dev/null 2>&1 || { echo "ERROR: Node.js not found"; exit 1; }
	@node -e "if(parseInt(process.version.slice(1))<20)process.exit(1)" || \
	  { echo "ERROR: Node.js 20+ required (you have $$(node -v))"; exit 1; }
	@test "$$(uname -s)" = "Darwin" || { echo "ERROR: macOS required"; exit 1; }
	@test "$$(uname -m)" = "arm64"  || { echo "ERROR: Apple Silicon required (MLX dependency)"; exit 1; }
	@echo "Prerequisites OK: $$(sw_vers -productVersion) / $$(uname -m)"
