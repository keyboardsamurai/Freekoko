# Installing freekoko

freekoko is a macOS menubar TTS app. One DMG, drag to Applications, one
extra Terminal command to clear the Gatekeeper quarantine bit, done.

## System requirements

| Requirement    | Value                                      |
| -------------- | ------------------------------------------ |
| Operating sys. | **macOS 15 Sequoia** or later              |
| Architecture   | **Apple Silicon** (M1, M2, M3, M4)         |
| Disk space     | ~500 MB (app bundle + model weights)       |
| Memory         | 4 GB free at inference time                |
| Internet       | Only for the initial download              |

Intel Macs are not supported. The Kokoro TTS engine uses MLX, which is
Apple-Silicon-only. The app will show a clear error dialog and quit on
unsupported hardware.

## Install

1. Download `freekoko-<version>-arm64.dmg` from the
   [Releases page](https://github.com/keyboardsamurai/freekoko/releases).
2. Open the DMG. A Finder window appears showing the app and a shortcut
   to your Applications folder.
3. Drag **freekoko** onto **Applications**.
4. Eject the DMG (right-click the mounted volume > Eject, or drag it to
   the Bin).

At this point launching freekoko gives you the dreaded *"freekoko is
damaged and can't be opened"* dialog. That's Gatekeeper refusing an
unsigned build. Expected — fix it with step 5.

### 5. Clear the quarantine attribute

freekoko ships **unsigned and un-notarized**. This is intentional: MLX
requires JIT code execution, which is incompatible with Apple's
hardened runtime (and therefore with notarization). There's no way
around this until Apple changes the policy or MLX moves off JIT.

Run this in Terminal, once, after drag-install:

```bash
xattr -cr /Applications/freekoko.app
```

Then launch from Spotlight or the Applications folder. You'll see the
freekoko icon appear in the menu bar.

**Alternative (no Terminal):** right-click `freekoko.app` in
Applications, choose **Open**, then click **Open** on the warning
dialog. macOS remembers this exception and subsequent launches work
normally.

## First run

- The menu bar icon is grey (server stopped) for a few seconds while
  the sidecar binary starts.
- It turns green once the Kokoro engine has loaded all 36 voice
  embeddings (~5–15 seconds on an M1; faster on M2/M3/M4).
- Click the menu bar icon > **Open freekoko** to show the main window.
- Tab 1 (**Generate**) — type text, pick a voice, click **Generate
  Speech**. Audio plays inline.

You now have a local HTTP API on `localhost:5002` too:

```bash
curl -X POST http://localhost:5002/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello from freekoko.","voice":"af_heart","speed":1.0}' \
  --output hello.wav
open hello.wav
```

## Troubleshooting

### "freekoko is damaged and can't be opened."

You skipped step 5. Run:

```bash
xattr -cr /Applications/freekoko.app
```

If that fails with "Operation not permitted", you're on a corporate-
managed Mac with Gatekeeper locked down. Your admin will need to grant
an exception, or run freekoko from source (`git clone`, `make dev`).

### Menu bar icon stays red ("error") — "Server not running"

Check the **Logs** tab. Common causes:

| Log line                                         | Fix                                                   |
| ------------------------------------------------ | ----------------------------------------------------- |
| `server_start_failed error=address_in_use`       | Port 5002 is busy. Settings → change port → restart.  |
| `Sidecar binary not found`                       | Corrupted install — reinstall the DMG.                |
| `model_not_loaded` persisting past 30 s          | Model weights missing; check disk space and reinstall. |

To see who's on port 5002:

```bash
lsof -i :5002
```

### Audio generation fails silently

Look at `~/Library/Logs/freekoko/sidecar-YYYY-MM-DD.log` for the raw
sidecar output. The Logs tab shows the last 1000 lines in-memory; the
file has the full history.

### Checking the sidecar directly

The sidecar binary lives inside the .app:

```bash
/Applications/freekoko.app/Contents/Resources/sidecar/freekoko-sidecar --version
```

### Completely reset the app

```bash
# 1. Quit freekoko (tray menu > Quit).
# 2. Remove the app.
rm -rf /Applications/freekoko.app

# 3. Remove app data (settings, history, logs).
rm -rf ~/Library/Application\ Support/freekoko
rm -rf ~/Library/Logs/freekoko
rm -rf ~/Library/Preferences/app.freekoko.plist
```

## Uninstall

Drag `freekoko.app` from `/Applications` to the Bin. Optionally also
delete:

```bash
rm -rf ~/Library/Application\ Support/freekoko
rm -rf ~/Library/Logs/freekoko
rm -f  ~/Library/Preferences/app.freekoko.plist
```

## Updating

freekoko does not auto-update. When a new version is announced on the
[Releases page](https://github.com/keyboardsamurai/freekoko/releases),
download the new DMG and drag over the existing app. Your history and
settings are preserved.

## Privacy posture

- **No telemetry.** The app makes no outbound network requests after
  install. Verify with Little Snitch / Lulu if you're curious.
- **Local only.** The HTTP API binds to `127.0.0.1` and rejects
  non-loopback connections.
- **No license server.** freekoko is MIT-licensed. No kill switch, no
  expiry, no "call home" check.
- **Model weights are on disk.** They don't leave your machine.
