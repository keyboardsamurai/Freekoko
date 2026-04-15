# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

Three projects in one tree, orchestrated by the root `Makefile`:

- `freekoko-sidecar/` — Swift 6 + Hummingbird 2 HTTP server on `localhost:5002`. Wraps the upstream KokoroEngine actor and exposes `/tts`, `/tts/stream`, `/voices`, `/health`.
- `freekoko-app/` — Electron 34 + React 19 + TypeScript (electron-vite 3.1, Vitest). Menubar GUI + supervisor for the sidecar + IPC bridge.
- `upstream-kokoro/` — vendored fork of `keyboardsamurai/kokoro-voice`. **Patched in place** (not a submodule); see "Upstream patches" below.

Design + rationale docs that future changes must stay consistent with:
- `.planning/ARCHITECTURE.md` — source of truth for IPC channels, supervisor lifecycle, risks (R1–R9).
- `freekoko-sidecar/NOTES.md` — MLX packaging quirks (MLXUtilsLibrary pin, duplicate-MLX fix, metallib).
- `freekoko-app/NOTES.md` — P2 deviations from spec (electron-vite version, tray icons, history path).

## Commands

Everything flows through the top-level `Makefile`. Common targets:

| Command | Notes |
| --- | --- |
| `make check-deps` | Verify Swift + Node 20+ + macOS + arm64. Run once on a new machine. |
| `make download-models` | Fetch ~326 MB of Kokoro weights + voice embeddings into `upstream-kokoro/Resources/`, checksum-verified against `scripts/model-checksums.txt`. |
| `make dev` | Swift debug build of sidecar + `electron-vite dev`. Sidecar runs on port 5002, renderer on Vite default 5173. |
| `make sidecar` | **Uses `xcodebuild`, not `swift build`.** Required because SPM's Cmlx target explicitly excludes `mlx/backend/metal/kernels` — `swift build` alone produces a binary that can't load GPU kernels. xcodebuild auto-compiles `.metal` files into `default.metallib` which the Makefile then stages at the SPM-style path. |
| `make app` | `npm ci && electron-vite build`. |
| `make dmg` | Full DMG via electron-builder. Requires model weights on disk (fails fast if missing). |
| `make dmg-dir` | Unpacked `.app` only — skips DMG staging, doesn't require model weights. |
| `make test` | `swift test` + `vitest run`. |
| `make clean` | Removes build artifacts. **Does not delete downloaded models.** |

Single-test invocations:

```bash
# Swift
cd freekoko-sidecar && swift test --filter TTSStreamHandlerTests
# Vitest
cd freekoko-app && npx vitest run src/components/AudioPlayer.test.tsx
cd freekoko-app && npm run typecheck      # both tsconfigs
cd freekoko-app && npm run lint           # eslint, --max-warnings 0
```

## Architecture (big picture)

```
Renderer (React 19, Zustand)
  │  window.electronAPI  (contextIsolation: true, preload.ts)
  ▼
Electron main
  ├── SidecarSupervisor   spawn/health/restart (backoff [500,1000,2000,5000,10000], 5/60s)
  ├── LogCapture          ndjson stdout → ring buffer(1000) + file + 'on:log-line'
  ├── SettingsStore       electron-store wrapper, emits 'on:settings-changed'
  ├── TrayMenu            idle/starting/running/stopping/crashed/port_in_use/error
  ├── HistoryStore        WAV files + index.json under userData/history
  └── IPC handlers.ts     one registrar; 25 channels defined in shared/types.ts IPC enum
  │  HTTP localhost:5002  (SidecarClient, Node fetch)
  ▼
Swift sidecar (Hummingbird 2)
  ├── Handlers/TTSHandler — /tts (WAV), /tts/stream (binary frames)
  ├── Engine/EngineWrapper — actor boundary to KokoroEngine
  └── upstream-kokoro → KokoroSwift → MLX Swift → Apple Silicon GPU
```

Key cross-cutting invariants:

- **Streaming wire protocol** (`/tts/stream`, `POST`): 16-byte preamble `[FKST|u32BE sampleRate|u32BE totalChunks|u32BE 0]` then per-chunk frames `[u32BE chunkIndex|u32BE pcmByteLen|Float32 LE PCM]`. **Sidecar emits speech-only PCM.** The 0.15 s × 24000 = 3600 zero samples between chunks are re-inserted twice client-side: main process adds them during WAV assembly for byte-identical parity with `/tts`, renderer adds them to `nextStartTime` for audible parity. One canonical silence duration, applied in two places, never in the wire protocol.
- **Streaming play/pause uses `AudioContext.suspend()/resume()`**, not `HTMLAudioElement`. `ctx.currentTime` freezes while suspended, so `currentTime = ctx.currentTime - startedAt` works in both states with no wall-clock bookkeeping. Buffers are `createBuffer(1, …, 24000) + copyToChannel + createBufferSource + start(nextStartTime)`.
- **History persistence must survive tab unmounts.** The `onTtsDone` → `useHistoryStore.getState().add()` subscription lives in `src/App.tsx`, **not** in `GenerateView.tsx`. AudioPlayer coordinates the static-playback handoff via refs (`pendingDoneItemRef`, `finalHandoffFiredRef`, `endedCountRef`) so the swap happens on the final `src.onended` after `tts:done`, never mid-stream.
- **IPC error contract.** Handlers return either a success payload or `IpcError` (`{ error: string, message?: string }`). Renderer wrappers in `src/lib/ipc.ts` use `isIpcError()` — don't bypass it by assuming success shape.

## Packaging (DMG) — non-obvious requirements

The packaged `.app` has several landmines. When touching electron-builder config or the afterPack hook, preserve all of these:

1. **`hardenedRuntime: false`** — MLX requires JIT, which hardened runtime blocks. This means freekoko **cannot be notarized**, by design. Users clear quarantine with `xattr -cr /Applications/freekoko.app`. Do not try to "fix" this.
2. **`LSUIElement: true`** — tray-only app, no dock icon. If the tray fails to render, the app is completely invisible.
3. **Tray PNGs must be in `extraResources`** (`resources/tray/*.png` → `Contents/Resources/tray/`). `TrayMenu.iconFor()` resolves via `process.resourcesPath/tray/`; missing → `nativeImage.createEmpty()` → invisible tray.
4. **`mlx.metallib` must be next to the sidecar binary** (`Contents/Resources/sidecar/mlx.metallib`). The Makefile copies it from the xcodebuild output; `build/after-pack.cjs` re-copies it into the packaged `.app`. Without this the sidecar crashes at launch with "Failed to load the default metallib".
5. **Swift resource bundles must be next to the sidecar binary.** `KokoroSwift` uses `Bundle.module` at runtime. `build/after-pack.cjs` scans both the SPM release dir and the Xcode release dir for `*.bundle` directories and copies each into `Contents/Resources/sidecar/`, then ad-hoc re-signs them. Missing → `Fatal error: unable to find bundle named KokoroSwift_KokoroSwift`.
6. **`build/after-pack.cjs`** also runs `install_name_tool` + ad-hoc `codesign --entitlements build/entitlements.mac.plist` on the sidecar so dylibs resolve from inside the `.app` and launchd accepts the binary.

## Upstream patches (be careful)

`upstream-kokoro/` is vendored, not a submodule, and contains local edits — do not clobber with an upstream pull without preserving these:

- `upstream-kokoro/Package.swift` pins `mlalma/MLXUtilsLibrary` to `exact: "0.0.6"`. HEAD removed `BenchmarkTimer`, which KokoroSwift still references. See `freekoko-sidecar/NOTES.md` §1.
- `upstream-kokoro/LocalPackages/MisakiSwift/` is a full vendored copy of MisakiSwift 1.0.6 with its product flipped to `type: .static`.
- `upstream-kokoro/LocalPackages/kokoro-ios/Package.swift` — KokoroSwift product is `type: .static` and consumes MisakiSwift via `.package(path: "../MisakiSwift")` instead of the URL pin.

Rationale: both libraries statically link `mlx-swift`. When both were `.dynamic`, dyld registered MLX Objective-C classes twice and the sidecar ran with two independent Metal buffer pools — this contributed to a `[metal::malloc] Resource limit (499000) exceeded` crash on long generations. Flipping both to `.static` absorbs every MLX consumer into the single sidecar executable. Reverting either product to `.dynamic` brings the duplicate-class warnings back. See `freekoko-sidecar/NOTES.md` §2.

## Conventions

- **Local-only networking.** Sidecar binds `127.0.0.1`. Do not introduce outbound network calls (freekoko is fully offline post-install).
- **No new dependencies that require a signing certificate.** Everything must work unsigned.
- **All new IPC channels go through `shared/types.ts` `IPC` enum + `preload.ts` + `src/lib/ipc.ts`.** Keep the three in sync.
- **`shared/types.ts` is the contract file** consumed by main, renderer, and tests. Treat it like a protocol — additive changes only, and bump both sides in the same commit.
