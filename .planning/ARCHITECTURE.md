# freekoko — Architecture Blueprint
**Version:** 1.0  
**Date:** 2026-04-14  
**Status:** Authoritative design document — drives all implementation

---

## 0. Grounding: What We Know From the Upstream Codebase

Key facts extracted from `/Users/tag/Documents/workspace-playground/freekoko/upstream-kokoro/`:

| Fact | Source | Value |
|---|---|---|
| Primary inference API | `Shared/KokoroEngine.swift:282` | `actor KokoroEngine.generateAudio(text:voiceId:speed:) async throws -> [Float]` |
| Audio sample rate | `Shared/Constants.swift:78` | 24000 Hz, mono |
| Max token count | `LocalPackages/.../KokoroTTS.swift:383` | 510 tokens (~400 English chars) |
| Model file | `Shared/KokoroEngine.swift:167` | `kokoro-v1_0.safetensors` |
| Voice embedding formats | `Shared/KokoroEngine.swift:195–260` | `voices/*.safetensors` (preferred), `voices.npz`, `voices/*.npy` |
| Voice count | `Shared/Constants.swift:119–169` | 36 voices across 5 languages |
| Platform | `LocalPackages/kokoro-ios/Package.swift:8` | macOS 15+, Apple Silicon (MLX) |
| WAV encoding pattern | `KokoroVoice/VoiceManager.swift:202–238` | RIFF header + Int16 PCM, 16-bit, little-endian |
| Language detection | `Shared/KokoroEngine.swift:71–80` | Voice prefix: `a`→en-US, `b`→en-GB, `e`→es-ES, `i`→it-IT, `p`→pt-BR |
| Config file | `LocalPackages/kokoro-ios/Resources/config.json` | Loaded via `Bundle.module` inside KokoroSwift |
| Engine concurrency | `Shared/KokoroEngine.swift:114` | Swift `actor` — serializes all `generateAudio` calls |

`KokoroEngine` already handles all concurrency correctly. The sidecar wraps it, never duplicates it.

---

## 1. Directory Layout

```
freekoko/                                        ← repo root
├── .planning/
│   └── ARCHITECTURE.md
├── Makefile                                     ← top-level orchestration
├── README.md
│
├── upstream-kokoro/                             ← upstream Swift repo (git submodule)
│   ├── Shared/
│   │   ├── KokoroEngine.swift                   ← actor used directly by sidecar
│   │   ├── Constants.swift                      ← voice catalog, sample rate
│   │   └── VoiceConfiguration.swift
│   ├── LocalPackages/kokoro-ios/                ← KokoroSwift MLX inference library
│   │   ├── Package.swift
│   │   ├── Resources/config.json
│   │   └── Sources/KokoroSwift/
│   └── Resources/                              ← model weights (git-ignored, downloaded)
│       ├── kokoro-v1_0.safetensors
│       ├── voices/                              ← 36 × .safetensors
│       └── config.json
│
├── freekoko-sidecar/                           ← NEW: Swift CLI HTTP server
│   ├── Package.swift
│   ├── Sources/
│   │   └── FreekokoSidecar/
│   │       ├── main.swift                      ← entry point, arg parsing, server start
│   │       ├── Server.swift                    ← Hummingbird app, route registration
│   │       ├── Handlers/
│   │       │   ├── TTSHandler.swift
│   │       │   ├── VoicesHandler.swift
│   │       │   └── HealthHandler.swift
│   │       ├── Audio/
│   │       │   ├── WAVEncoder.swift            ← [Float] → RIFF WAV Data (no AVFoundation)
│   │       │   └── TextChunker.swift           ← sentence-boundary splitting
│   │       ├── Engine/
│   │       │   └── EngineWrapper.swift         ← KokoroEngine.shared lifecycle
│   │       ├── Logging/
│   │       │   └── JSONLogger.swift            ← newline-delimited JSON to stdout
│   │       └── Models/
│   │           ├── TTSRequest.swift
│   │           ├── TTSErrorResponse.swift
│   │           └── VoiceInfo.swift
│   └── Tests/
│       └── FreekokoSidecarTests/
│           ├── WAVEncoderTests.swift
│           └── TextChunkerTests.swift
│
└── freekoko-app/                               ← NEW: Electron desktop app
    ├── package.json
    ├── tsconfig.json
    ├── tsconfig.node.json
    ├── vite.config.ts
    ├── electron-builder.yml
    ├── .env.development
    │
    ├── electron/                               ← main process (Node.js + TypeScript)
    │   ├── main.ts                             ← app lifecycle, BrowserWindow, tray
    │   ├── preload.ts                          ← contextBridge IPC exposure
    │   ├── types.ts                            ← shared TypeScript interfaces
    │   ├── sidecar/
    │   │   ├── SidecarSupervisor.ts
    │   │   ├── SidecarClient.ts               ← HTTP fetch wrappers for /tts /voices /health
    │   │   └── LogCapture.ts                  ← stdout line parser → ring buffer + file
    │   ├── store/
    │   │   └── SettingsStore.ts               ← electron-store typed wrapper
    │   ├── history/
    │   │   └── HistoryStore.ts                ← JSON index + WAV file management
    │   ├── tray/
    │   │   └── TrayMenu.ts
    │   └── ipc/
    │       └── handlers.ts                    ← all ipcMain.handle() registrations
    │
    ├── src/                                   ← renderer process (React + TypeScript)
    │   ├── main.tsx
    │   ├── App.tsx                            ← shell layout, tab navigation
    │   ├── views/
    │   │   ├── GenerateView.tsx
    │   │   ├── HistoryView.tsx
    │   │   ├── LogsView.tsx
    │   │   └── SettingsView.tsx
    │   ├── components/
    │   │   ├── VoiceSelector.tsx              ← grouped optgroup select
    │   │   ├── SpeedSlider.tsx
    │   │   ├── AudioPlayer.tsx                ← HTML5 audio with WAV blob URL
    │   │   ├── HistoryItem.tsx
    │   │   ├── LogLine.tsx
    │   │   └── StatusBadge.tsx
    │   ├── store/
    │   │   ├── useAppStore.ts                 ← Zustand: server status, voices, settings
    │   │   ├── useHistoryStore.ts
    │   │   └── useLogsStore.ts                ← 1000-line ring buffer
    │   ├── hooks/
    │   │   ├── useSidecar.ts
    │   │   └── useVoices.ts
    │   ├── lib/
    │   │   └── ipc.ts                         ← typed window.electronAPI wrappers
    │   └── styles/
    │       └── global.css
    │
    └── resources/
        ├── icons/
        │   ├── tray-idle.png                  ← 22×22 grey microphone
        │   ├── tray-running.png               ← 22×22 green microphone
        │   ├── tray-starting.png              ← 22×22 yellow microphone
        │   ├── tray-error.png                 ← 22×22 red microphone
        │   └── AppIcon.icns
        └── entitlements.mac.plist
```

### Upstream dependency strategy

`upstream-kokoro/` is a **git submodule** pinned to a specific commit. `freekoko-sidecar/Package.swift` references it as `.package(path: "../upstream-kokoro")`. The KokoroVoice Xcode app target and the AudioUnit extension are never linked — only the `KokoroVoiceShared` target (containing `KokoroEngine`, `Constants`, `VoiceConfiguration`) and the `KokoroSwift` library (MLX inference) are linked. Model weights in `upstream-kokoro/Resources/` are git-ignored and downloaded separately via `make download-models`.

---

## 2. Swift Sidecar Design

### 2.1 HTTP Library: Hummingbird 2

**Decision: Hummingbird 2.** Not SwiftNIO directly, not Vapor.

Hummingbird 2 is a complete rewrite built on Swift structured concurrency — its request handlers are `async` functions with no `EventLoopFuture` bridging required. This aligns perfectly with `KokoroEngine`'s `actor` isolation: the handler awaits the actor directly, Swift's cooperative scheduler manages the rest. Vapor adds ORM, templating, and session infrastructure that is dead weight for a 3-endpoint CLI server. Writing SwiftNIO HTTP framing by hand requires 500+ lines of boilerplate for correct chunked encoding and keep-alive handling. Hummingbird 2 adds approximately 200KB to the compiled binary and accepts connections within 50ms of startup.

`freekoko-sidecar/Package.swift` dependency:

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "freekoko-sidecar",
  platforms: [.macOS(.v15)],
  dependencies: [
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
      ]
    ),
    .testTarget(
      name: "FreekokoSidecarTests",
      dependencies: ["FreekokoSidecar"]
    ),
  ]
)
```

### 2.2 Startup Arguments

```
freekoko-sidecar [options]

  --port <INT>            HTTP listen port (default: 5002)
  --resources-dir <PATH>  Absolute path containing:
                            kokoro-v1_0.safetensors
                            voices/
                            config.json
                          Required at runtime; no default in production
  --log-json              Emit newline-delimited JSON to stdout
                          (human-readable text if omitted — for local dev)
  --version               Print version string and exit
```

Implemented with `swift-argument-parser`. The binary fails fast with a clear message if `--resources-dir` is not provided and the default development path does not exist.

### 2.3 Request/Response Schemas

**POST /tts**

Request (`Content-Type: application/json`):
```json
{ "text": "Hello, world.", "voice": "af_heart", "speed": 1.0 }
```

- `text`: required, 1–8000 UTF-8 characters. Outside range → 400.
- `voice`: optional, default `"af_heart"`. Unknown ID → 400 (explicit failure; no silent fallback).
- `speed`: optional, float, clamped server-side to [0.5, 2.0], default 1.0.

Success response (200 OK, `Content-Type: audio/wav`):
- Binary: RIFF/WAVE PCM 16-bit signed little-endian, 24000 Hz, mono.
- `X-Freekoko-Voice: af_heart`
- `X-Freekoko-Duration-Ms: 342`
- `X-Freekoko-Sample-Count: 82176`

Error responses (`Content-Type: application/json`):
```json
{ "error": "voice_not_found",    "message": "Voice 'xyz' is not available." }
{ "error": "text_too_long",      "message": "Text exceeds 8000 character limit." }
{ "error": "text_empty",         "message": "Text field is required and must not be empty." }
{ "error": "synthesis_failed",   "message": "Engine error: tooManyTokens" }
{ "error": "model_not_loaded",   "message": "Model is still loading, retry shortly." }
{ "error": "request_timeout",    "message": "Synthesis exceeded 30-second limit." }
```

HTTP status codes: 200, 400 (validation), 503 (model loading or timeout), 500 (unexpected).

**GET /voices**

```json
{
  "voices": [
    { "id": "af_heart", "name": "Heart", "language": "en-US",
      "language_name": "American English", "gender": "Female", "quality": "A" }
  ],
  "total": 36
}
```

Only voices with confirmed loaded embeddings are returned — filtered via `KokoroEngine.shared.isVoiceAvailable(id)` at startup. Missing embedding files are silently excluded so the UI never shows voices that will fail synthesis.

**GET /health**

```json
{ "status": "ok",      "model_loaded": true,  "voices_loaded": 36, "version": "1.0.0", "uptime_seconds": 142 }
{ "status": "loading", "model_loaded": false, "voices_loaded": 0,  "version": "1.0.0", "uptime_seconds": 8   }
```

HTTP 200 when `model_loaded: true`. HTTP 503 while loading. Electron polls this endpoint at 2-second intervals to detect ready state.

### 2.4 WAV Encoder

`Audio/WAVEncoder.swift` is a pure Swift implementation with no AVFoundation dependency. AVFoundation requires Objective-C runtime initialization and framework linking that is inappropriate for a CLI tool. The implementation follows the exact pattern proven in `KokoroVoice/VoiceManager.swift:202–238`:

1. Clamp each `Float` sample to `[-1.0, 1.0]`.
2. Multiply by 32767.0 and truncate to `Int16`.
3. Write 44-byte RIFF header: `RIFF` chunk (file size as `UInt32 LE`), `WAVE` FourCC, `fmt ` subchunk (audio format=1/PCM, channels=1, sampleRate=24000, byteRate=48000, blockAlign=2, bitsPerSample=16), `data` subchunk header with sample byte count.
4. Append all `Int16` samples as little-endian bytes using `withUnsafeBytes`.
5. Return `Data`.

A 10-second clip at 24kHz = 480,000 bytes (~470KB). Fits in memory without streaming write for v1.

### 2.5 Text Chunking

`KokoroTTS.Constants.maxTokenCount = 510`. English prose at normal punctuation density maps approximately 1.2 tokens per character, so 400 characters ≈ 480 tokens — safe headroom below the limit. The target chunk size is 400 characters.

`Audio/TextChunker.swift` algorithm:

1. Reject empty or whitespace-only input.
2. Use `NaturalLanguage.NLTokenizer(unit: .sentence)` to produce sentence boundaries.
3. Accumulate sentences into a working chunk. When appending the next sentence would exceed 400 characters, emit the current chunk and start a new one.
4. If a single sentence exceeds 400 characters (long technical strings, no internal punctuation), split at the nearest comma or semicolon before position 400, then at the nearest space before 400.
5. Return `[String]`.

Each chunk produces one `KokoroEngine.generateAudio()` call. The resulting `[Float]` arrays are concatenated before WAV encoding — no silence padding, no crossfade. The model produces natural prosodic silence at sentence boundaries through duration prediction. No chunk produces audible seams for normally punctuated English.

**Retry on `tooManyTokens`:** Catch `KokoroTTSError.tooManyTokens`, halve the chunk size, re-split, retry. Stop recursing below 50 characters; at that point return 500 `synthesis_failed`.

The API accepts up to 8000 characters. Worst case: 20 chunks × 300ms = 6 seconds of total processing. The `tts:progress` IPC event keeps the UI informed.

### 2.6 Concurrency Model

`KokoroEngine` is a Swift `actor` — all `generateAudio` calls are serialized through actor isolation. MLX inference is not thread-safe and shares a single GPU command queue; the actor serialization is correct and necessary.

The sidecar does not parallelize TTS requests. Hummingbird 2 handles concurrent HTTP connections via Swift structured concurrency (one `Task` per request). Each `Task` awaits the actor in natural arrival order. Concurrent API callers experience queuing, not rejection. A request waiting more than 30 seconds returns 503 `request_timeout` (enforced with `withDeadline` or `Task` cancellation in `TTSHandler`).

No DispatchQueue, no semaphore, no thread pool — pure Swift concurrency throughout. This is deliberate; any manual threading around MLX causes data races.

### 2.7 Log Format

When `--log-json` is active (always set by Electron), each event is one JSON object per line on stdout:

```
{"ts":"2026-04-14T10:23:41.123Z","level":"info","msg":"server_started","port":5002}
{"ts":"2026-04-14T10:23:53.420Z","level":"info","msg":"model_loaded","voices":36}
{"ts":"2026-04-14T10:24:10.312Z","level":"info","msg":"request_complete","method":"POST","path":"/tts","voice":"af_heart","chars":42,"ms":312,"status":200}
{"ts":"2026-04-14T10:24:20.001Z","level":"warn","msg":"request_error","error":"voice_not_found","status":400,"ms":1}
{"ts":"2026-04-14T10:24:30.500Z","level":"info","msg":"request_complete","method":"GET","path":"/health","status":200,"ms":1}
{"ts":"2026-04-14T10:30:00.000Z","level":"info","msg":"shutdown_complete"}
```

Fixed fields on every line: `ts` (ISO 8601 ms precision UTC), `level`, `msg`. Additional context fields vary by event type. Electron parses each line with `JSON.parse()`; lines that fail to parse (e.g., Swift crash traces) are wrapped as `{ ts, level: "error", msg: rawLine }`.

Human-readable format (no `--log-json`, development):
```
[10:23:41.123] INFO  server_started port=5002
[10:24:10.312] INFO  POST /tts  af_heart  42ch  312ms  200
[10:24:20.001] WARN  request_error  voice_not_found  400  1ms
```

### 2.8 Graceful Shutdown

SIGTERM is caught via `withTaskCancellationHandler` on the top-level task. On receipt:
1. Hummingbird stops accepting new connections (built-in `gracefulShutdown`).
2. In-flight requests drain for up to 5 seconds.
3. Final `{"level":"info","msg":"shutdown_complete"}` written to stdout.
4. Exit 0.

Electron sends SIGTERM, then waits 6 seconds before SIGKILL.

### 2.9 Model Loading at Startup

`main.swift` calls `EngineWrapper.initialize(resourcesDir:)` before the Hummingbird server's `run()` call. The wrapper calls `await KokoroEngine.shared.loadModel(from: resourcesURL)`. The HTTP server binds immediately; handlers check `EngineWrapper.isReady` and return 503 until the actor sets `isLoaded = true`. Loading takes 5–15 seconds on first launch (safetensors deserialization + MLX weight layout). A startup log line `model_loaded` is emitted when ready. Electron's health-check supervisor handles the loading window by retrying with exponential backoff.

---

## 3. Electron App Design

### 3.1 Stack: Electron 34 + TypeScript 5 + React 19 + Vite 6

**Decision: Electron with React.** Not Tauri. Not vanilla HTML.

Tauri v2 requires Rust plugins for anything beyond simple HTTP — process supervision with signal handling, stdout streaming, per-line JSON parsing, and file system operations are trivial in Node.js and complex in Tauri's IPC boundary. Electron's main process runs in Node.js where `child_process.spawn`, `readline`, `fs`, and `net` are all first-class APIs used by the sidecar supervisor. React with Vite produces sub-100ms hot-reload for renderer changes and is the most widely understood frontend stack for open-source contributors. The Electron bundle overhead (~150MB) is immaterial when the model weights alone require ~330MB.

Key package versions (in `freekoko-app/package.json`):
- `electron`: `^34.0.0`
- `react` / `react-dom`: `^19.0.0`
- `typescript`: `^5.5.0`
- `vite`: `^6.0.0`
- `electron-vite`: `^2.3.0` (handles main/preload/renderer build targets in one config)
- `zustand`: `^5.0.0`
- `electron-store`: `^10.0.0`

### 3.2 Process Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Electron Main Process                        │
│   Node.js 20 — full OS access, no sandbox                      │
│                                                                 │
│  SidecarSupervisor ──► child_process.spawn(freekoko-sidecar)   │
│  SidecarClient     ──► fetch() to localhost:5002               │
│  SettingsStore     ──► electron-store → userData/settings.json │
│  HistoryStore      ──► userData/history/{index.json, *.wav}    │
│  LogCapture        ──► child stdout → ring buffer + log files  │
│  TrayMenu          ──► Tray + ContextMenu, state-driven        │
│                                                                 │
│  ipcMain.handle() registrations (electron/ipc/handlers.ts)     │
└──────────────────────────────┬──────────────────────────────────┘
              contextBridge    │   (preload.ts)
┌──────────────────────────────▼──────────────────────────────────┐
│                    Renderer Process (React)                       │
│   Chromium sandbox — window.electronAPI.* only                   │
│                                                                  │
│  useAppStore (Zustand)   — server status, voices, settings       │
│  useHistoryStore         — history entries                       │
│  useLogsStore            — 1000-line in-memory ring buffer       │
│                                                                  │
│  GenerateView / HistoryView / LogsView / SettingsView            │
└──────────────────────────────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│             freekoko-sidecar (Swift binary)                       │
│             HTTP on localhost:5002                                │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 IPC Channel Registry

All channels use `domain:verb`. Renderer-to-main are `ipcMain.handle()` (invoke/handle). Main-to-renderer pushes are `webContents.send()` prefixed `on:`.

| Channel | Direction | Payload In | Payload Out |
|---|---|---|---|
| `server:start` | R→M | `{}` | `ServerStatus` |
| `server:stop` | R→M | `{}` | `ServerStatus` |
| `server:restart` | R→M | `{}` | `ServerStatus` |
| `server:status` | R→M | `{}` | `ServerStatus` |
| `on:server-status` | M→R push | — | `ServerStatus` |
| `tts:generate` | R→M | `TtsRequest` | `TtsResult` |
| `on:tts-progress` | M→R push | — | `TtsProgress` |
| `voices:list` | R→M | `{}` | `VoiceInfo[]` |
| `settings:get` | R→M | `{}` | `AppSettings` |
| `settings:set` | R→M | `Partial<AppSettings>` | `AppSettings` |
| `on:settings-changed` | M→R push | — | `AppSettings` |
| `history:list` | R→M | `{ limit: number; offset: number }` | `HistoryEntry[]` |
| `history:delete` | R→M | `{ id: string }` | `void` |
| `history:save-wav` | R→M | `{ id: string }` | `{ savedPath: string }` |
| `logs:list` | R→M | `{ limit: number }` | `LogLine[]` |
| `on:log-line` | M→R push | — | `LogLine` |
| `shell:open-url` | R→M | `{ url: string }` | `void` |

Shared type definitions in `electron/types.ts` (imported via `import type` in preload; copied into `src/lib/ipc.ts` for renderer — avoids bundling Node.js types into Chromium):

```typescript
interface ServerStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  pid?: number;
  port: number;
  errorMessage?: string;
}
interface TtsRequest { text: string; voice: string; speed: number; }
interface TtsResult {
  id: string; wavPath: string; durationMs: number;
  sampleCount: number; voice: string; textPreview: string;
}
interface TtsProgress { chunkIndex: number; totalChunks: number; }
interface VoiceInfo {
  id: string; name: string; language: string; languageName: string;
  gender: 'Female' | 'Male'; quality: 'A' | 'B';
}
interface AppSettings {
  port: number; outputDir: string; defaultVoice: string;
  defaultSpeed: number; launchOnLogin: boolean; autoStartServer: boolean;
}
interface HistoryEntry {
  id: string; ts: string; voice: string; textPreview: string;
  wavPath: string; durationMs: number; sampleCount: number;
}
interface LogLine {
  ts: string; level: 'debug' | 'info' | 'warn' | 'error';
  msg: string; [key: string]: unknown;
}
```

### 3.4 Sidecar Supervisor

`electron/sidecar/SidecarSupervisor.ts` — class instantiated once in `main.ts`.

**Binary path resolution:**
```typescript
const binary = app.isPackaged
  ? path.join(process.resourcesPath, 'sidecar', 'freekoko-sidecar')
  : path.join(__dirname, '../../freekoko-sidecar/.build/debug/freekoko-sidecar');

const resourcesDir = app.isPackaged
  ? path.join(process.resourcesPath, 'kokoro')
  : path.join(__dirname, '../../upstream-kokoro/Resources');
```

**Spawn:** `child_process.spawn(binary, ['--port', String(port), '--resources-dir', resourcesDir, '--log-json'], { stdio: ['ignore', 'pipe', 'pipe'] })`. State → `starting`.

**Health polling:** `setInterval` at 2000ms issues `GET http://localhost:{port}/health` with a 1-second `AbortController` timeout. First response with `model_loaded: true` clears the interval, transitions state → `running`, broadcasts `on:server-status`. Five consecutive failures → state `error`, triggers restart with backoff.

**Crash recovery:** `child.on('exit')` — if `this.intentionalStop === false`, schedule restart. Backoff: 2s, 4s, 8s, 16s, 30s (capped). `restartAttempts` resets to 0 after 60 seconds of stable `running`. Exception: if last seen log contained `"error":"port_in_use"`, do not retry — transition to permanent `error` state with message "Port {port} is already in use. Change port in Settings."

**Stop:** Send SIGTERM. Set `intentionalStop = true`. Await `exit` event with 6-second timeout. On timeout: SIGKILL.

**Log capture:** Delegates to `LogCapture.ts`. `child.stdout` and `child.stderr` both pipe into `LogCapture`.

### 3.5 State Management

**Renderer (Zustand):**

`store/useAppStore.ts`: `{ serverStatus: ServerStatus; voices: VoiceInfo[]; settings: AppSettings }` — subscribed to `on:server-status` and `on:settings-changed` IPC pushes via `useSidecar.ts` hook.

`store/useHistoryStore.ts`: `{ entries: HistoryEntry[]; isLoading: boolean }` — loaded on mount via `history:list`, updated on generation and deletion.

`store/useLogsStore.ts`: `{ lines: LogLine[] }` with a fixed max of 1000 entries — `append()` splices from the front when over limit. Subscribed to `on:log-line` IPC pushes.

Zustand over `useReducer + Context` because the same `serverStatus` is consumed by `StatusBadge` in the nav bar, the Generate button disabled state, the tray menu (main process side), and the Settings form — at completely different tree depths and across process boundaries. Zustand's subscribe-anywhere model and minimal API surface suits this better than prop drilling or deeply nested Context providers.

**Main process (electron-store):**

`electron/store/SettingsStore.ts` wraps `electron-store` with typed schema and defaults:

```typescript
const defaults: AppSettings = {
  port: 5002,
  outputDir: app.getPath('music'),
  defaultVoice: 'af_heart',
  defaultSpeed: 1.0,
  launchOnLogin: false,
  autoStartServer: true,
};
```

Storage: `~/Library/Application Support/freekoko/settings.json`.

### 3.6 History Storage

Location: `userData/history/` (`~/Library/Application Support/freekoko/history/`).

Files:
- `index.json` — `HistoryEntry[]`, newest first, max 500 entries.
- `{uuid-v4}.wav` — one WAV file per generation.

`HistoryStore.ts` operations:
- **Add:** `crypto.randomUUID()` for ID, write WAV bytes to `history/{id}.wav`, prepend entry to in-memory array, trim array to 500 (delete WAV files for trimmed entries), write index atomically (`index.json.tmp` → rename).
- **Delete:** Delete `history/{id}.wav`, splice from array, write index atomically.
- **Save-as:** `dialog.showSaveDialog({ defaultPath: path.join(settings.outputDir, '{voice}_{ts}.wav') })` then `fs.copyFile`.
- **List:** Slice from in-memory array (no disk read after initial startup load).

### 3.7 Log Capture and Rolling Files

`electron/sidecar/LogCapture.ts`:
- Splits piped `child.stdout` on `\n` using a `readline.createInterface`.
- Attempts `JSON.parse()` per line. Failed parses (stack traces) wrap as `{ ts: new Date().toISOString(), level: 'error', msg: rawLine }`.
- Appends to the in-memory ring buffer (max 1000 lines). Splices from front when limit exceeded.
- Calls `mainWindow?.webContents.send('on:log-line', parsed)` for each line.
- Writes each line to the active day file: `userData/logs/sidecar-YYYY-MM-DD.log`, opened as `fs.createWriteStream(path, { flags: 'a' })`.
- On startup, deletes log files with mtime older than 7 days.

### 3.8 Tray Menu

`electron/tray/TrayMenu.ts` calls `tray.setContextMenu(Menu.buildFromTemplate([...]))` whenever `ServerStatus` changes.

Icon map:
- `stopped` → `tray-idle.png`
- `starting` → `tray-starting.png`
- `running` → `tray-running.png`
- `error` → `tray-error.png`

Menu structure (state = `running`):
```
● freekoko — Running on :5002       [label, disabled]
────────────────────────────────────
  Start Server                      [disabled]
✓ Stop Server                       [enabled]
✓ Restart Server                    [enabled]
────────────────────────────────────
✓ Open App                          [enabled]
✓ Logs                              [enabled]
✓ Settings                          [enabled]
────────────────────────────────────
✓ About freekoko                    [enabled]
✓ Quit                              [enabled]
```

Menu structure (state = `stopped` or `error`):
```
○ freekoko — Server stopped         [label, disabled]
[or: ✕ freekoko — Error: port 5002 in use]
────────────────────────────────────
✓ Start Server                      [enabled]
  Stop Server                       [disabled]
  Restart Server                    [disabled]
...
```

"Open App" calls `mainWindow.show()` (creating the `BrowserWindow` lazily if it does not exist). The Dock icon is hidden at startup via `app.dock.hide()` in `main.ts`. The `BrowserWindow` has `show: false` in its constructor options and is shown only when "Open App" is clicked.

---

## 4. UI Wireframes

### 4.1 Main Window — Generate View

```
┌──────────────────────────────────────────────────────────────────────┐
│ freekoko     ● Running :5002       [Generate] [History] [Logs] [⚙]  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Text to speak                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                                                              │   │
│  │  Type or paste text here…                                   │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                               0 / 8000 characters   │
│                                                                      │
│  Voice                               Speed                          │
│  ┌────────────────────────────────┐  ●───────────────────  1.0×    │
│  │ ─── American English ───────  │  0.5×               2.0×       │
│  │  ◉ Heart      (Female, A)     │                                  │
│  │  ○ Bella      (Female, A)     │                                  │
│  │  ○ Adam       (Male,   A)     │                                  │
│  │ ─── British English ────────  │                                  │
│  │  ○ Alice      (Female, A)     │                                  │
│  └────────────────────────────────┘                                  │
│                                                                      │
│                         [ ▶  Generate Speech ]                      │
│                                                                      │
│  ──────────────────────────────────────────────────────────────      │
│  ▶ ━━━━━━━━━━━━●━━━━━━━━━━━━━━━  0:04 / 0:12    [↓ Save WAV]     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Generate button shows "Generating… (2 of 5)" during multi-chunk synthesis. Audio player renders only after a successful generation. Character counter turns red at 7500+. Voice optgroup ordering: quality A before B within each language group; female before male within each quality level.

### 4.2 History View

```
┌──────────────────────────────────────────────────────────────────────┐
│ freekoko     ● Running :5002       [Generate] [History] [Logs] [⚙]  │
├──────────────────────────────────────────────────────────────────────┤
│  Recent Generations (48 total)                         [Clear All]  │
├──────────────────────────────────────────────────────────────────────┤
│  2026-04-14 10:23:41  af_heart  Female A  0:05                      │
│  "Hello, world. This is a test of the freekoko TTS system…"         │
│  ▶ ━━━━━━━━━  [▶ Replay]  [↩ Re-use Text]  [↓ Save WAV]  [✕]      │
├──────────────────────────────────────────────────────────────────────┤
│  2026-04-14 10:20:12  bf_alice  Female A  0:03                      │
│  "The quick brown fox jumps over the lazy dog."                     │
│  ▶ ━━━━━━━━━  [▶ Replay]  [↩ Re-use Text]  [↓ Save WAV]  [✕]      │
└──────────────────────────────────────────────────────────────────────┘
```

"Re-use Text" navigates to Generate, pre-fills textarea and voice selector via Zustand action. [✕] shows a confirmation before deletion.

### 4.3 Logs View

```
┌──────────────────────────────────────────────────────────────────────┐
│ freekoko     ● Running :5002       [Generate] [History] [Logs] [⚙]  │
├──────────────────────────────────────────────────────────────────────┤
│  Sidecar Logs                                  [Clear]  [Copy All]  │
├──────────────────────────────────────────────────────────────────────┤
│  10:23:41.100  INFO   server_started  port=5002                      │
│  10:23:53.420  INFO   model_loaded  voices=36                        │
│  10:24:10.312  INFO   POST /tts  af_heart  42ch  312ms  200         │
│  10:24:15.108  INFO   POST /tts  af_heart  18ch  198ms  200         │
│  10:24:20.001  WARN   request_error  voice_not_found  xyz  400      │
│  10:24:30.500  INFO   GET /health  1ms  200                         │
│                                                                      │
│  (auto-scroll active — pauses when user scrolls up)                 │
└──────────────────────────────────────────────────────────────────────┘
```

Level colors: INFO → grey/white, WARN → amber, ERROR → red. Monospace font for timestamps. Auto-scroll pauses when `scrollTop + clientHeight < scrollHeight - 20px`.

### 4.4 Settings View

```
┌──────────────────────────────────────────────────────────────────────┐
│ freekoko     ● Running :5002       [Generate] [History] [Logs] [⚙]  │
├──────────────────────────────────────────────────────────────────────┤
│  Settings                                                            │
│                                                                      │
│  Server                                                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  HTTP Port           [ 5002                      ]           │   │
│  │  ⚠ Restart server for port change to take effect            │   │
│  │  Auto-start server on launch   [✓ Enabled  ]                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Audio                                                               │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Default save location  [ ~/Music              ] [Browse…]  │   │
│  │  Default voice          [ Heart (en-US, F, A)  ▼]          │   │
│  │  Default speed          ●──────────────────  1.0×           │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  System                                                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Launch freekoko at login   [ ] Disabled                     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  About                                                               │
│  freekoko v1.0.0 · MIT License                                       │
│  Kokoro TTS engine: Apache 2.0 (hexgrad)                             │
│  [View on GitHub ↗]                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

Settings save on blur (no explicit Save button). Port change shows a persistent warning banner until the server is restarted.

---

## 5. Build and Packaging Pipeline

### 5.1 Root Makefile

```makefile
# /Users/tag/Documents/workspace-playground/freekoko/Makefile

SIDECAR_DIR   := freekoko-sidecar
APP_DIR       := freekoko-app
UPSTREAM_DIR  := upstream-kokoro
RESOURCES_SRC := $(UPSTREAM_DIR)/Resources

.PHONY: all sidecar app dmg dev clean check-deps download-models

all: check-deps sidecar app

sidecar:
	@echo "Building Swift sidecar (release arm64)..."
	cd $(SIDECAR_DIR) && swift build -c release --arch arm64
	@echo "Binary: $(SIDECAR_DIR)/.build/arm64-apple-macosx/release/freekoko-sidecar"

app:
	@echo "Building Electron app..."
	cd $(APP_DIR) && npm ci && npm run build

dmg: sidecar app
	@test -f $(RESOURCES_SRC)/kokoro-v1_0.safetensors || \
	  { echo "ERROR: Model weights not found. Run: make download-models"; exit 1; }
	cd $(APP_DIR) && npm run dist
	@echo "DMG ready in $(APP_DIR)/dist/"

dev:
	@echo "Starting dev environment (Ctrl-C to quit)..."
	@trap 'kill 0' INT; \
	  (cd $(SIDECAR_DIR) && swift build && \
	   .build/debug/freekoko-sidecar \
	     --port 5002 \
	     --resources-dir ../$(RESOURCES_SRC)) & \
	  (cd $(APP_DIR) && npm run dev) & \
	  wait

download-models:
	cd $(UPSTREAM_DIR) && make download-models

clean:
	cd $(SIDECAR_DIR) && swift package clean
	cd $(APP_DIR) && rm -rf dist/ out/ node_modules/.cache

check-deps:
	@command -v swift >/dev/null 2>&1 || { echo "ERROR: Swift not found"; exit 1; }
	@command -v node  >/dev/null 2>&1 || { echo "ERROR: Node.js not found"; exit 1; }
	@node -e "if(parseInt(process.version.slice(1))<20)process.exit(1)" || \
	  { echo "ERROR: Node.js 20+ required"; exit 1; }
	@echo "Prerequisites OK"
```

### 5.2 Electron Builder Configuration

`freekoko-app/electron-builder.yml`:

```yaml
appId: app.freekoko
productName: freekoko
copyright: MIT License — freekoko contributors

mac:
  category: public.app-category.utilities
  target:
    - target: dmg
      arch: arm64
  # MUST be false — MLX requires JIT; hardened runtime blocks it
  hardenedRuntime: false
  gatekeeperAssess: false
  entitlementsInherit: resources/entitlements.mac.plist

dmg:
  title: "freekoko ${version}"
  contents:
    - { x: 130, y: 220 }
    - { x: 410, y: 220, type: link, path: /Applications }

extraResources:
  - from: ../freekoko-sidecar/.build/arm64-apple-macosx/release/freekoko-sidecar
    to: sidecar/freekoko-sidecar
  - from: ../upstream-kokoro/Resources/kokoro-v1_0.safetensors
    to: kokoro/kokoro-v1_0.safetensors
  - from: ../upstream-kokoro/Resources/voices
    to: kokoro/voices
  - from: ../upstream-kokoro/LocalPackages/kokoro-ios/Resources/config.json
    to: kokoro/config.json

files:
  - "**/*"
  - "!**/*.map"
  - "!**/node_modules/.cache/**"

directories:
  buildResources: resources
  output: dist
```

At runtime, `SidecarSupervisor.ts` resolves paths as:
```
Binary:       {process.resourcesPath}/sidecar/freekoko-sidecar
Resources:    {process.resourcesPath}/kokoro
```

### 5.3 Entitlements

`resources/entitlements.mac.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
```

`allow-jit` is required because MLX uses JIT compilation for GPU kernel fusion. `disable-library-validation` is required because the Swift binary links MLX dylibs that are not Apple-signed. These entitlements make notarization impossible — this is intentional and documented. Users bypass Gatekeeper with `xattr -cr freekoko.app` or via System Settings > Privacy & Security > Open Anyway. The README and the DMG's `install.sh` script must include these instructions.

### 5.4 `electron-vite` Build Targets

`freekoko-app/vite.config.ts` uses `electron-vite` to produce three separate build outputs:
- `out/main/index.js` — main process (Node.js CommonJS, no bundling of `electron` itself)
- `out/preload/index.js` — preload script (Node.js target, `contextIsolation: true`)
- `out/renderer/index.html` — renderer bundle (browser target, React, CSS modules)

`electron-builder` picks up all three via `files: ["out/**/*"]`. Source maps are excluded from the final DMG (`!**/*.map`).

### 5.5 GitHub Actions Release Workflow

`.github/workflows/release.yml` (triggers on `git tag v*`):
1. `actions/checkout` with `submodules: recursive` to pull `upstream-kokoro`.
2. Cache HuggingFace model weights by SHA (or skip download if cache hit).
3. `make download-models` (fetches from HuggingFace if not cached).
4. Set up Xcode (latest) and Node.js 20.
5. `make dmg`.
6. `actions/upload-artifact` and `gh release upload` to attach the DMG to the GitHub Release.

---

## 6. Phase Breakdown

### P1 — Swift Sidecar MVP
**Goal:** Functional 3-endpoint HTTP API returning real WAV audio from the Kokoro engine.

Deliverables:
- [ ] `freekoko-sidecar/Package.swift` — Hummingbird 2 + swift-argument-parser + upstream-kokoro local path dep
- [ ] `main.swift` — argument parsing, `EngineWrapper.initialize()`, `Server().run()`
- [ ] `Server.swift` — Hummingbird `Application`, route registration for all 3 endpoints
- [ ] `Engine/EngineWrapper.swift` — calls `KokoroEngine.shared.loadModel(from:)` at startup, exposes `isReady`, `availableVoices()`, `generate(text:voice:speed:) async throws -> [Float]`
- [ ] `Audio/WAVEncoder.swift` — pure Swift RIFF encoder, tested
- [ ] `Audio/TextChunker.swift` — NLTokenizer sentence splitting, 400-char target, retry on tooManyTokens
- [ ] `Handlers/TTSHandler.swift` — request decode, validate, chunk, generate, encode, respond
- [ ] `Handlers/VoicesHandler.swift` — return filtered voice list as JSON
- [ ] `Handlers/HealthHandler.swift` — return status JSON, 200/503
- [ ] `Logging/JSONLogger.swift` — newline-delimited JSON output
- [ ] `Tests/WAVEncoderTests.swift` — verify RIFF header bytes, sample count
- [ ] `Tests/TextChunkerTests.swift` — boundary cases: empty string, single long sentence, 8000-char input, URL-heavy text

Acceptance criteria:
- `curl -X POST localhost:5002/tts -H 'Content-Type: application/json' -d '{"text":"Hello world","voice":"af_heart","speed":1.0}' --output test.wav` produces a valid WAV playable in QuickTime
- `curl localhost:5002/voices` returns 36 voices as JSON (or fewer if embeddings are missing)
- `curl localhost:5002/health` returns `{"status":"ok","model_loaded":true,...}`
- 2000-character input generates audio without `tooManyTokens` error
- Unknown voice ID returns 400 JSON error
- Binary exits cleanly on SIGTERM with `shutdown_complete` log line

Can parallelize with: P2 (Electron shell can start against a stub HTTP server)

---

### P2 — Electron Shell
**Goal:** Electron app with working sidecar lifecycle management and IPC skeleton.

Deliverables:
- [ ] `package.json` with all dependencies locked
- [ ] `electron/main.ts` — app init, `app.dock.hide()`, BrowserWindow (lazy, `show: false`), IPC handler registration, `before-quit` cleanup
- [ ] `electron/preload.ts` — `contextBridge.exposeInMainWorld('electronAPI', {...})` exposing all channels
- [ ] `electron/ipc/handlers.ts` — all `ipcMain.handle()` registrations, wired to Supervisor/SettingsStore/HistoryStore
- [ ] `electron/sidecar/SidecarSupervisor.ts` — full spawn/health/backoff/restart/stop implementation
- [ ] `electron/sidecar/SidecarClient.ts` — `fetchTTS()`, `fetchVoices()`, `fetchHealth()` with proper error handling
- [ ] `electron/sidecar/LogCapture.ts` — readline interface, JSON parse, ring buffer, file writer
- [ ] `electron/store/SettingsStore.ts` — electron-store wrapper with typed defaults
- [ ] `electron/tray/TrayMenu.ts` — all 4 state menus, icon switching
- [ ] `src/main.tsx` + `src/App.tsx` — React root with tab shell and `StatusBadge`
- [ ] `src/lib/ipc.ts` — typed invoke/on wrappers
- [ ] `src/store/useAppStore.ts` + `useHistoryStore.ts` + `useLogsStore.ts`
- [ ] `src/hooks/useSidecar.ts` — subscribes to `on:server-status`, updates store

Acceptance criteria:
- `make dev` starts sidecar and Electron app; tray icon appears
- "Start Server" → sidecar spawns → health check succeeds → tray icon turns green
- "Stop Server" → SIGTERM → sidecar exits → tray icon turns grey
- `kill -9 <sidecar_pid>` → supervisor detects exit → restarts within 2 seconds
- `on:server-status` events reach the renderer and update `StatusBadge`
- Logs view shows real sidecar stdout in real time

Can parallelize with: P1 (during P2, stub the sidecar with a canned HTTP server)

---

### P3 — Generate View
**Goal:** Full TTS generation from the GUI, with inline playback and history saving.

Deliverables:
- [ ] `src/views/GenerateView.tsx` — textarea, voice selector, speed slider, Generate button, loading state, progress indicator for multi-chunk
- [ ] `src/components/VoiceSelector.tsx` — `<select>` with `<optgroup>` per language, sorted quality-A first, female before male
- [ ] `src/components/SpeedSlider.tsx` — range input 0.5–2.0, step 0.1, live value display
- [ ] `src/components/AudioPlayer.tsx` — HTML5 `<audio>` element, `src` set to `URL.createObjectURL(blob)` from WAV bytes read via `fs.readFileSync` in main process; clean up blob URL on unmount
- [ ] `tts:generate` IPC handler — calls `SidecarClient.fetchTTS()`, saves WAV via `HistoryStore.add()`, emits `on:tts-progress` per chunk, returns `TtsResult`
- [ ] `electron/history/HistoryStore.ts` — full implementation: UUID generation, WAV write, index prepend, trim to 500, atomic index write

Acceptance criteria:
- Type text, select voice, click Generate — audio plays inline within ~500ms for short phrases on M1
- Generated WAV is saved to `userData/history/`
- Character counter correct; Generate disabled when empty or >8000 chars
- Multi-chunk text shows "Generating… (N of M)" progress
- Voice dropdown correctly grouped and ordered

Can parallelize with: P4 (history view reads from same HistoryStore)

---

### P4 — History and Logs Views
**Goal:** Browse and replay past generations; real-time log streaming.

Deliverables:
- [ ] `src/views/HistoryView.tsx` — paginated list with "Clear All" confirmation
- [ ] `src/components/HistoryItem.tsx` — timestamp, voice badge, text preview, mini audio player, Replay/Re-use/Save/Delete buttons
- [ ] `history:list` + `history:delete` + `history:save-wav` IPC handler implementations
- [ ] "Re-use Text" → navigate to GenerateView with text and voice pre-filled via Zustand action
- [ ] `src/views/LogsView.tsx` — CSS-based virtual scroll (fixed row height, `overflow-y: auto`); auto-scroll behavior
- [ ] `src/components/LogLine.tsx` — level-colored, monospace timestamp column
- [ ] `on:log-line` → `useLogsStore.append()` in `useSidecar.ts` hook
- [ ] Auto-scroll pause: store a `userScrolled: boolean` ref; reset on new log line if ref is false

Acceptance criteria:
- History loads on mount; all entries from `index.json` displayed
- Delete removes WAV file and refreshes list without full remount
- Re-use pre-fills GenerateView correctly
- Logs view auto-scrolls to latest; pauses when user scrolls up; resumes on scroll-to-bottom
- 1000-line ring buffer holds; older lines are dropped silently

Can parallelize with: P5

---

### P5 — Settings, Tray Polish, System Integration
**Goal:** Complete settings persistence, all tray states correct, launch-at-login, macOS version guard.

Deliverables:
- [ ] `src/views/SettingsView.tsx` — full form, save-on-blur, port change warning banner
- [ ] `settings:get` + `settings:set` IPC handlers — persist, broadcast `on:settings-changed`
- [ ] `launchOnLogin` → `app.setLoginItemSettings({ openAtLogin: value })`
- [ ] `autoStartServer` → checked in `main.ts` `app.whenReady()` to auto-call `supervisor.start()`
- [ ] macOS version guard in `main.ts` — check `os.release()` before spawning; show `dialog.showErrorBox` and quit if macOS < 15 (Darwin kernel < 24)
- [ ] Intel Mac guard — check `process.arch !== 'arm64'`; same error dialog
- [ ] About dialog — `dialog.showMessageBox` or rendered in SettingsView
- [ ] Tray error state — permanent error when port_in_use detected; error message shown in tray label

Acceptance criteria:
- All settings persist across app restarts
- Launch-at-login toggle works without additional system config
- Auto-start server triggers within 3 seconds of app launch
- On macOS 14 or Intel: friendly error dialog, app quits cleanly
- Tray shows correct icon and label in all 4 states

Can parallelize with: P4

---

### P6 — Packaging and Distribution
**Goal:** Reproducible DMG build, GitHub Actions release, user-facing documentation.

Deliverables:
- [ ] `electron-builder.yml` — complete, all extraResources verified
- [ ] `resources/entitlements.mac.plist` — JIT + library validation entries
- [ ] App icon set (`AppIcon.icns` with all required sizes: 16, 32, 128, 256, 512, 1024)
- [ ] Tray icon PNGs at 22×22 and 44×44 (Retina) for all 4 states
- [ ] `make dmg` — verified end-to-end on clean macOS 15 arm64 machine
- [ ] `scripts/download-models.sh` — verify or reuse upstream script; add SHA256 checksum verification
- [ ] `.github/workflows/release.yml` — triggered on `v*` tag; runs `make dmg`; uploads DMG artifact
- [ ] `README.md` — prerequisites, `make download-models`, `make dev`, `make dmg`, Gatekeeper bypass, troubleshooting
- [ ] `INSTALL.md` — end-user install: download DMG, drag to Applications, `xattr -cr`, launch

Acceptance criteria:
- DMG produced from a CI runner (GitHub Actions macOS-latest arm64) without manual steps
- Installed app launches, tray icon appears, server starts, TTS generates audio from curl
- All 36 voices available in GUI dropdown
- `xattr -cr freekoko.app` documented in README; app opens after it

Can parallelize with: Nothing — all previous phases must complete first

---

## 7. Risk Register

### R1 — `Bundle.module` fails for CLI executable target
**Severity: Critical**

`KokoroConfig.loadConfig()` calls `Bundle.module.url(forResource:)` which requires a `.bundle` resource directory alongside the executable. For a Swift Package Manager executable target, `Bundle.module` resolves correctly only if the package's resources are embedded in a `.resources` bundle at the same path as the binary. If `freekoko-sidecar` does not correctly inherit the `KokoroSwift` library's `Resources/config.json`, the engine init will crash with a force-unwrap at `KokoroConfig.swift:158`.

**Mitigation:** Verify in P1 by running the compiled binary from an unrelated working directory. If `Bundle.module` fails for the library bundle, set the environment variable `KOKORO_CONFIG_PATH` before spawning (Electron injects it, the sidecar reads it, passes it explicitly to `KokoroConfig.loadConfig()`). A one-line patch to `KokoroConfig.loadConfig()` to check an env var before `Bundle.module` is the fallback. Test this during P1 acceptance.

### R2 — MLX JIT blocked by Electron hardened runtime
**Severity: Critical**

Electron enables macOS hardened runtime by default. MLX's GPU kernel fusion requires JIT (`com.apple.security.cs.allow-jit`). With hardened runtime enabled and the JIT entitlement absent or not applied to the child process, the Swift sidecar crashes on first MLX operation.

**Mitigation:** Set `hardenedRuntime: false` in `electron-builder.yml` (Section 5.2). This is not a workaround — it is the correct setting for an unsigned open-source build that bundles MLX. Document clearly in README: "freekoko is unsigned and requires bypassing Gatekeeper." Monitor Apple's policy changes; if a future macOS requires hardened runtime for child processes to inherit entitlements, evaluate re-entitling the sidecar binary separately rather than the Electron app.

### R3 — Model weights absent at DMG build time
**Severity: High**

`kokoro-v1_0.safetensors` (~165MB) and `voices/*.safetensors` (~165MB) are not in git. If the CI runner builds the DMG without pre-downloading them, `electron-builder` copies empty or missing source paths and produces a DMG that launches but fails TTS with `modelLoadError`. The failure is silent — `electron-builder` does not error on missing `extraResources` sources.

**Mitigation:** Add a `beforeBuild` hook in `electron-builder.yml` that shell-checks for the model file and exits non-zero if absent. The Makefile `dmg` target also checks explicitly before calling `npm run dist`. CI workflow runs `make download-models` before `make dmg` with a cache layer keyed on model file SHAs.

### R4 — Long-text latency with no UI feedback
**Severity: Medium**

A 2000-character input produces approximately 5 sequential synthesis calls. On M2 at ~300ms each, that is 1.5 seconds. On M1 under thermal load, potentially 3–4 seconds. The GUI shows no progress during this period, appearing frozen.

**Mitigation:** `tts:generate` IPC handler emits `on:tts-progress` events (`{ chunkIndex, totalChunks }`) as each chunk completes. `GenerateView` displays "Generating… (2 of 5)" in the Generate button. This is implemented in P3 — it is not optional polish, it is a required acceptance criterion.

### R5 — Voice embedding missing for specific voices
**Severity: Medium**

`Constants.availableVoices` defines 36 voices, but `voices/` may contain fewer `.safetensors` files (e.g., user downloads a partial set, or upstream adds voices before the model archive is updated). `GET /voices` returning 36 voices when only 28 embeddings are loaded causes silent 400 errors on voices the GUI claimed were available.

**Mitigation:** `EngineWrapper.initialize()` calls `KokoroEngine.shared.availableVoiceIds()` after loading and stores the confirmed set. `VoicesHandler` returns only confirmed voices. `TTSHandler` validates `isVoiceAvailable(id)` before synthesis. This is a P1 acceptance criterion.

### R6 — Sidecar orphaned on Electron force-quit
**Severity: Medium**

If Electron is killed via `kill -9` (force quit, crash), the `before-quit` and `will-quit` handlers never fire. The sidecar continues running as an orphaned process on port 5002, blocking future app launches.

**Mitigation:** Register the sidecar with `child.unref()` only after confirming it is running (not at spawn time). More importantly, implement a port-conflict detection path in `SidecarSupervisor`: if binding port 5002 fails because freekoko-sidecar is already running (detectable via `/health` returning `version: "1.0.0"`), kill the orphan by its PID from `/health` response and restart. Add a `pid` field to the `/health` response for this purpose.

### R7 — React renderer / main process type drift
**Severity: Medium**

IPC payload types defined in `electron/types.ts` are manually re-declared (or `import type`-d) in the renderer. As the app evolves, these drift: a field added to `TtsResult` in main is not added to the renderer's copy, causing silent `undefined` accesses that TypeScript cannot catch across the process boundary.

**Mitigation:** Define all shared types once in `electron/types.ts`. The preload script imports them with `import type` (compile-time only, zero runtime cost). The renderer's `src/lib/ipc.ts` copies the relevant types by re-exporting from a path alias. Set up a `tsconfig.json` path alias `@shared` pointing to `../../electron/types.ts` from the renderer tsconfig. A CI step runs `tsc --noEmit` on both the main and renderer tsconfigs to catch drift at build time.

### R8 — macOS version compatibility (macOS 15 hard requirement)
**Severity: Medium**

`LocalPackages/kokoro-ios/Package.swift` targets `.macOS(.v15)`. Users on macOS 13 or 14 will encounter a cryptic crash when the Swift binary loads the `KokoroSwift` framework, not a useful error message.

**Mitigation:** `main.ts` checks `os.release()` before spawning the sidecar. Darwin kernel 24.x = macOS 15; anything below 24 triggers a `dialog.showErrorBox("freekoko requires macOS 15 Sequoia or later. Your Mac is running an older version of macOS.", "")` and calls `app.quit()`. This guard is a P5 acceptance criterion. The README prominently lists the macOS 15 requirement.

### R9 — Port 5002 conflict
**Severity: Low**

Port 5002 may be in use by another process. The sidecar fails to bind, exits with non-zero code, and `SidecarSupervisor` enters an infinite restart loop.

**Mitigation:** The sidecar emits `{"level":"error","msg":"server_start_failed","error":"address_in_use","port":5002}` on bind failure. `LogCapture` detects the `address_in_use` error key and calls `supervisor.onPortConflict()` which sets state to permanent `error` without retrying. Tray label shows "Error: port 5002 in use — change in Settings." User changes the port in Settings; Settings store broadcasts the change; supervisor uses the new port on next `start()` call.

### R10 — `tooManyTokens` for dense non-Latin text
**Severity: Low**

The 400-character chunk target is calibrated for English. Japanese or Chinese text produces more tokens per character (ideographic characters may expand to multiple phoneme tokens). A 400-character Japanese chunk could exceed 510 tokens.

**Mitigation:** `TextChunker` already has a retry path that halves the chunk size on `tooManyTokens` (Section 2.5). A test in `TextChunkerTests` covers a 400-character block of repeated CJK characters. If this proves insufficient for common cases, the target chunk size is lowered to 250 characters for non-Latin scripts by checking the dominant Unicode block of the input text. This is a P1 test deliverable, not a post-shipping fix.

---

## 8. Out of Scope for v1

These are explicitly deferred. Including any of them risks missing the P6 shipping milestone.

| Feature | Notes |
|---|---|
| **Voice cloning** | Requires speaker encoder, fine-tuning pipeline, voice management UX. Post-v1. |
| **SSML support** | The upstream `SSMLParser.swift` exists for the AudioUnit extension only. v1 accepts plain text; SSML tags are stripped. |
| **Streaming PCM / SSE** | Architecturally supported via `TextChunker` chunks, but requires chunked HTTP transfer encoding and client-side audio buffering. Deferred to v2. |
| **Windows / Linux** | MLX is Apple Silicon only. Out of scope permanently unless the inference backend is replaced with ONNX. |
| **Intel Mac support** | MLX does not run on x86_64. Users on Intel Macs receive a clear error dialog and are directed to the README. Not fixable without an ONNX CPU backend swap. |
| **Auto-updater** | `electron-updater` requires code signing and a release server. Unsigned open-source builds update by downloading a new DMG from GitHub Releases. |
| **Crash reporting / telemetry** | Zero network egress is a core design principle. No Sentry, no analytics, no opt-in telemetry. |
| **Voice blending** | Kokoro supports weighted embedding mixing. Not exposed in v1 API or GUI. |
| **Batch API** | `POST /tts/batch` accepting an array of texts. Not in v1; callers make sequential requests. |
| **Audio format selection** | WAV only. No MP3, OGG, FLAC. Format conversion requires codec linking not appropriate for v1 scope. |
| **Pronunciation dictionary** | Custom phoneme overrides via a user-editable dictionary. Not in v1. |
| **macOS system TTS integration** | The upstream AudioUnit extension (AVSpeechSynthesisProviderAudioUnit) is not included. freekoko exposes HTTP only. |
| **French, Hindi, Japanese, Mandarin voices** | The PRD mentions these languages; they are not in `Constants.availableVoices` in the current upstream. Freekoko ships whatever voices the upstream library supports; expanding the voice set requires upstream changes. |

---

## Appendix A: Voice Catalog

36 voices from `upstream-kokoro/Shared/Constants.swift:119–169`:

| ID | Name | Language | Gender | Quality |
|---|---|---|---|---|
| af_alloy | Alloy | en-US | Female | A |
| af_aoede | Aoede | en-US | Female | B |
| af_bella | Bella | en-US | Female | A |
| af_heart | Heart | en-US | Female | A |
| af_jessica | Jessica | en-US | Female | B |
| af_kore | Kore | en-US | Female | B |
| af_nicole | Nicole | en-US | Female | A |
| af_nova | Nova | en-US | Female | A |
| af_river | River | en-US | Female | B |
| af_sarah | Sarah | en-US | Female | A |
| af_sky | Sky | en-US | Female | A |
| am_adam | Adam | en-US | Male | A |
| am_echo | Echo | en-US | Male | B |
| am_eric | Eric | en-US | Male | B |
| am_fenrir | Fenrir | en-US | Male | B |
| am_liam | Liam | en-US | Male | B |
| am_michael | Michael | en-US | Male | A |
| am_onyx | Onyx | en-US | Male | B |
| am_puck | Puck | en-US | Male | B |
| am_santa | Santa | en-US | Male | B |
| bf_alice | Alice | en-GB | Female | A |
| bf_emma | Emma | en-GB | Female | B |
| bf_isabella | Isabella | en-GB | Female | B |
| bf_lily | Lily | en-GB | Female | B |
| bm_daniel | Daniel | en-GB | Male | A |
| bm_fable | Fable | en-GB | Male | B |
| bm_george | George | en-GB | Male | B |
| bm_lewis | Lewis | en-GB | Male | B |
| ef_dora | Dora | es-ES | Female | B |
| em_alex | Alex | es-ES | Male | B |
| em_santa | Santa | es-ES | Male | B |
| if_sara | Sara | it-IT | Female | B |
| im_nicola | Nicola | it-IT | Male | B |
| pf_dora | Dora | pt-BR | Female | B |
| pm_alex | Alex | pt-BR | Male | B |
| pm_santa | Santa | pt-BR | Male | B |

Default voice: `af_heart`. Language detection from voice ID prefix: `a`→en-US, `b`→en-GB, `e`→es-ES, `i`→it-IT, `p`→pt-BR (source: `KokoroEngine.swift:71–80`).

---

## Appendix B: Absolute File Path Reference

| Purpose | Absolute Path |
|---|---|
| KokoroEngine actor | `/Users/tag/Documents/workspace-playground/freekoko/upstream-kokoro/Shared/KokoroEngine.swift` |
| Voice catalog + constants | `/Users/tag/Documents/workspace-playground/freekoko/upstream-kokoro/Shared/Constants.swift` |
| KokoroTTS public API + maxTokenCount | `/Users/tag/Documents/workspace-playground/freekoko/upstream-kokoro/LocalPackages/kokoro-ios/Sources/KokoroSwift/TTSEngine/KokoroTTS.swift` |
| WAV encoding reference (VoiceManager) | `/Users/tag/Documents/workspace-playground/freekoko/upstream-kokoro/KokoroVoice/VoiceManager.swift` |
| Upstream Package.swift (platform req) | `/Users/tag/Documents/workspace-playground/freekoko/upstream-kokoro/LocalPackages/kokoro-ios/Package.swift` |
| Model config JSON | `/Users/tag/Documents/workspace-playground/freekoko/upstream-kokoro/LocalPackages/kokoro-ios/Resources/config.json` |
| Sidecar package root | `/Users/tag/Documents/workspace-playground/freekoko/freekoko-sidecar/Package.swift` |
| Electron app root | `/Users/tag/Documents/workspace-playground/freekoko/freekoko-app/package.json` |
| Root Makefile | `/Users/tag/Documents/workspace-playground/freekoko/Makefile` |
| This document | `/Users/tag/Documents/workspace-playground/freekoko/.planning/ARCHITECTURE.md` |
```

---

To save this document:

```bash
mkdir -p /Users/tag/Documents/workspace-playground/freekoko/.planning
# then paste the content above into the file