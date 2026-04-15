# freekoko

**Open-source Kokoro TTS desktop app for macOS.** Zero setup, zero telemetry, zero license gating.

A local HTTP API at `localhost:5002` + a menubar GUI, wrapped around the [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) neural TTS model running natively on Apple Silicon via MLX.

freekoko is MIT-licensed: no trial gate, no paid tier, no license server. It builds on [keyboardsamurai/kokoro-voice](https://github.com/keyboardsamurai/kokoro-voice) (the Swift/MLX inference core) and adds an HTTP sidecar + Electron UI on top.

---

## Requirements

- **macOS 15.0 Sequoia or later** (MLX Swift requirement)
- **Apple Silicon** (M1 / M2 / M3 / M4) — Intel Macs are not supported
- **Node.js 20+** (for building the Electron app)
- **Xcode Command Line Tools** (for the Swift sidecar)

## Releases

End-user install? See **[INSTALL.md](./INSTALL.md)** for the one-click flow.

Short version:

1. Download `freekoko-<version>-arm64.dmg` from the [Releases page](https://github.com/keyboardsamurai/freekoko/releases).
2. Drag **freekoko.app** into `/Applications`.
3. Clear the quarantine bit once (freekoko is **intentionally unsigned** — see [Why unsigned?](#why-unsigned)):

   ```bash
   xattr -cr /Applications/freekoko.app
   ```
4. Launch from Spotlight. Menu bar icon appears — open the app, generate speech.

Each release ships with a SHA-256 checksum file next to the DMG so you can verify your download before opening:

```bash
shasum -a 256 -c freekoko-1.0.0-arm64.dmg.sha256
```

## Build from source

```bash
git clone https://github.com/keyboardsamurai/freekoko.git
cd freekoko

make check-deps        # verify Swift + Node.js + macOS + arm64
make download-models   # fetch Kokoro weights + voices (~326 MB, first time)
make dev               # run sidecar + Electron in dev mode
make dmg               # produce distributable .dmg in freekoko-app/dist/
```

Build targets:

| Target              | What it does                                                                  |
| ------------------- | ----------------------------------------------------------------------------- |
| `make sidecar`      | Swift release build (arm64). Output: `freekoko-sidecar/.build/arm64-apple-macosx/release/freekoko-sidecar` |
| `make app`          | `npm ci && electron-vite build`                                                |
| `make dmg`          | Full DMG build via electron-builder. Fails fast if model weights are missing. |
| `make dmg-dir`      | Unpacked `.app` only (smoke test; skips DMG staging)                          |
| `make test`         | Swift `swift test` + Electron `npm test`                                      |
| `make check-deps`   | Verify host toolchain                                                          |
| `make download-models` | Wraps `scripts/download-models.sh` (checksum-verified)                      |
| `make clean`        | Remove build artifacts (not models)                                            |

## Building a release

Releases are fully automated. Push a git tag matching `v*` and the
[Release workflow](.github/workflows/release.yml) runs on an
Apple-Silicon GitHub-hosted runner:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow:

1. Caches the model weights by the `scripts/model-checksums.txt` hash.
2. Runs `make download-models` if cache missed.
3. Runs `make sidecar` (Swift release build).
4. Runs `npm run package:mac` (electron-builder → DMG + afterPack hook).
5. Uploads the `.dmg` and `.dmg.sha256` as a GitHub Release artifact.

**No secrets are required.** freekoko ships unsigned and is not
notarized, so there is no `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`
/ signing certificate flow. The default `GITHUB_TOKEN` is enough.

A manual dry run locally:

```bash
make download-models   # once
make dmg               # full end-to-end build, ~3-5 min
open freekoko-app/dist/*.dmg
```

## Why unsigned?

MLX compiles GPU kernels at runtime. The macOS hardened runtime (a
prerequisite for notarization) blocks JIT in third-party unsigned
binaries. The only way to ship MLX-powered code *and* comply with
hardened runtime is to join Apple's Developer Program and pay for a
notarization service — which defeats the "MIT, no strings attached"
positioning. So freekoko ships with the minimum entitlements MLX needs
and accepts the Gatekeeper-bypass friction. See
[`.planning/ARCHITECTURE.md`](./.planning/ARCHITECTURE.md) §7 R2 for the
full trade-off.

The `xattr -cr` command is the documented, supported way to accept an
unsigned app. It removes the `com.apple.quarantine` extended attribute
Gatekeeper placed on the DMG-extracted bundle. It does not disable
Gatekeeper system-wide.

## Usage

### Menubar GUI

Click the freekoko icon in the menu bar → **Open freekoko** → type, pick
a voice, click Generate.

### Local HTTP API

Once the server is running (started automatically or via the tray menu):

```bash
curl -X POST http://localhost:5002/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello from freekoko.","voice":"af_heart","speed":1.0}' \
  --output hello.wav
```

Endpoints:

| Method | Path       | Description                                                  |
| ------ | ---------- | ------------------------------------------------------------ |
| `POST` | `/tts`     | Generate WAV audio from text                                 |
| `GET`  | `/voices`  | List available voices (id, name, language, gender, quality)  |
| `GET`  | `/health`  | Server readiness + uptime                                    |

No authentication. Local-only binding (`127.0.0.1`). Port is configurable in Settings.

## Voices

36 voices across 5 languages (American/British English, Spanish,
Italian, Brazilian Portuguese). See
`upstream-kokoro/Shared/Constants.swift` for the full catalog.

## Architecture

```
┌─────────────────────────────────────┐
│  Electron main process (TypeScript) │
│  tray • IPC • supervisor • history  │
├─────────────────────────────────────┤
│  Renderer: React + Vite + Zustand  │
│  Generate · History · Logs · Settings │
└───────────────┬─────────────────────┘
                │ HTTP localhost:5002
┌───────────────▼─────────────────────┐
│  Swift sidecar (Hummingbird 2)      │
│  /tts · /voices · /health           │
├─────────────────────────────────────┤
│  KokoroEngine (actor) → KokoroSwift │
│  → MLX Swift → Apple Silicon GPU    │
└─────────────────────────────────────┘
```

Full design: [`.planning/ARCHITECTURE.md`](./.planning/ARCHITECTURE.md)

## Privacy

- Fully offline. No telemetry. No network calls after install.
- Model weights and voice embeddings live on-disk only.
- No license server, no trial timer, no watermark.

## Contributing

### Code layout

```
freekoko/
├── freekoko-sidecar/     # Swift HTTP server (Hummingbird 2)
├── freekoko-app/         # Electron + React app
│   ├── electron/         # main process + preload
│   ├── src/              # renderer (React 19)
│   ├── build/            # electron-builder resources (icon, entitlements, afterPack)
│   └── resources/        # tray icons
├── upstream-kokoro/      # vendored KokoroSwift inference library
├── scripts/              # download-models.sh, model-checksums.txt
├── .github/workflows/    # ci.yml + release.yml
└── Makefile              # orchestration
```

### Running tests

```bash
make test                          # both projects
cd freekoko-sidecar && swift test  # Swift unit tests only
cd freekoko-app && npm test        # TypeScript/React tests only
```

### Adding a voice

Upstream voices come from
[keyboardsamurai/kokoro-voice](https://github.com/keyboardsamurai/kokoro-voice)'s
`Shared/Constants.swift`. To add one:

1. Extend `Constants.availableVoices` upstream with the voice's id,
   language prefix, gender, and quality.
2. Add the `.safetensors` embedding to
   `upstream-kokoro/Resources/voices/<id>.safetensors`.
3. Re-run `make download-models` on freekoko's side, which re-verifies
   the checksum manifest.
4. Rebuild (`make dmg`). The GET `/voices` endpoint picks up the new
   voice at sidecar startup automatically.

### Pull request checklist

- [ ] `make test` passes
- [ ] `cd freekoko-app && npm run typecheck` clean
- [ ] No new outbound network calls (freekoko is local-only)
- [ ] No new dependencies that require a signing certificate

## Troubleshooting

### "freekoko is damaged and can't be opened."

Run the Gatekeeper bypass:

```bash
xattr -cr /Applications/freekoko.app
```

Alternatively, right-click the app in Applications → **Open** → **Open
Anyway**.

### Sidecar won't start / port 5002 already in use

```bash
lsof -i :5002
```

Change the port in the app's Settings tab and restart the server (tray
menu → Restart Server).

### Logs

- In-app: **Logs** tab (last 1000 lines, live)
- On disk: `~/Library/Logs/freekoko/sidecar-YYYY-MM-DD.log`

### Clean reinstall

```bash
rm -rf ~/Library/Application\ Support/freekoko
rm -rf ~/Library/Logs/freekoko
```

Full uninstall instructions are in [`INSTALL.md`](./INSTALL.md).

## Credits

- **Kokoro TTS** by [hexgrad](https://huggingface.co/hexgrad) — Apache 2.0
- **KokoroSwift** (MLX port) + voice catalog by the upstream [keyboardsamurai/kokoro-voice](https://github.com/keyboardsamurai/kokoro-voice) project
- **MLX Swift** by Apple

## License

MIT — see [LICENSE](./LICENSE). Third-party component notices live in [NOTICE.md](./NOTICE.md).
