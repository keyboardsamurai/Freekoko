/* eslint-disable */
/**
 * electron-builder afterPack hook — rewrite sidecar rpaths and ad-hoc sign.
 *
 * After electron-builder copies `extraResources` into the .app bundle, the
 * Swift sidecar binary still has absolute rpaths pointing back at
 * `~/Documents/.../freekoko-sidecar/.build/...`. Those absolute paths break
 * the binary when the .app is launched from /Applications on an end-user
 * machine.
 *
 * This hook:
 *   1. Marks the sidecar executable (chmod +x).
 *   2. Detects `LC_RPATH` entries pointing into the build tree and strips
 *      them, replacing with `@executable_path` and
 *      `@executable_path/../Frameworks` (standard .app layout).
 *   3. Copies any dylib the sidecar references with an absolute
 *      `.build/...` path into Contents/Resources/sidecar next to the binary
 *      and rewrites the load command to `@rpath/<dylibname>`.
 *   4. Ad-hoc signs the binary with our JIT entitlements so Gatekeeper
 *      allows it to be spawned by Electron's child_process (recent macOS
 *      requires at least ad-hoc signing; fully unsigned binaries are
 *      rejected when launched from a quarantine-flagged bundle).
 *   5. Logs (but does not fail on) any remaining absolute paths — SPM
 *      occasionally leaves harmless absolute LC_LOAD_DYLIB entries that
 *      dyld resolves via fallback search.
 *
 * Xcode Command Line Tools are required: `otool`, `install_name_tool`,
 * and `codesign` must be on PATH. If they are missing, we surface a
 * clear error pointing at `xcode-select --install`.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_TOOLS = ['otool', 'install_name_tool', 'codesign', 'chmod'];

function fail(msg) {
  console.error(`\n[after-pack] FATAL: ${msg}\n`);
  throw new Error(msg);
}

function warn(msg) {
  console.warn(`[after-pack] WARN: ${msg}`);
}

function info(msg) {
  console.log(`[after-pack] ${msg}`);
}

function run(tool, args, opts = {}) {
  const res = spawnSync(tool, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  if (res.status !== 0) {
    const cmd = `${tool} ${args.join(' ')}`;
    throw new Error(
      `Command failed: ${cmd}\nstdout: ${res.stdout || ''}\nstderr: ${res.stderr || ''}`,
    );
  }
  return res.stdout || '';
}

function ensureToolsAvailable() {
  const missing = [];
  for (const tool of REQUIRED_TOOLS) {
    const probe = spawnSync('command', ['-v', tool], { shell: true });
    if (probe.status !== 0) {
      missing.push(tool);
    }
  }
  if (missing.length > 0) {
    fail(
      `Required tool(s) not on PATH: ${missing.join(', ')}. ` +
        `Install Xcode Command Line Tools (xcode-select --install).`,
    );
  }
}

/**
 * Parse `otool -l` output and return { rpaths: [string], absoluteLoadPaths: [string] }.
 * - rpaths are LC_RPATH entries ("path " field).
 * - absoluteLoadPaths are LC_LOAD_DYLIB entries whose name is an absolute path
 *   pointing outside the standard @rpath / system framework locations.
 */
function inspectLoadCommands(binary) {
  const out = run('otool', ['-l', binary]);
  const lines = out.split('\n');
  const rpaths = [];
  const absoluteLoadPaths = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes('cmd LC_RPATH')) {
      // Find the path within the next few lines.
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const m = lines[j].match(/^\s+path\s+(.*?)\s+\(offset/);
        if (m) {
          rpaths.push(m[1]);
          break;
        }
      }
    }
    if (line.includes('cmd LC_LOAD_DYLIB') || line.includes('cmd LC_LOAD_WEAK_DYLIB')) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const m = lines[j].match(/^\s+name\s+(.*?)\s+\(offset/);
        if (m) {
          const name = m[1];
          if (
            name.startsWith('/') &&
            !name.startsWith('/usr/lib/') &&
            !name.startsWith('/System/')
          ) {
            absoluteLoadPaths.push(name);
          }
          break;
        }
      }
    }
    i++;
  }
  return { rpaths, absoluteLoadPaths };
}

/**
 * Copy dylibs referenced with absolute paths into the same directory as
 * the sidecar binary and rewrite the load command to use @rpath.
 */
function relocateAbsoluteDylibs(binary, absoluteLoadPaths, sidecarDir) {
  for (const abs of absoluteLoadPaths) {
    const base = path.basename(abs);
    const dest = path.join(sidecarDir, base);
    if (!fs.existsSync(dest)) {
      if (!fs.existsSync(abs)) {
        warn(
          `dylib referenced by sidecar not found at ${abs}; ` +
            `binary may fail to load. Skipping copy — keep as-is.`,
        );
        continue;
      }
      try {
        fs.copyFileSync(abs, dest);
        fs.chmodSync(dest, 0o755);
        info(`copied dylib → ${path.relative(sidecarDir, dest)}`);
      } catch (e) {
        warn(`failed to copy ${abs} → ${dest}: ${e.message}`);
        continue;
      }
    }
    try {
      run('install_name_tool', ['-change', abs, `@rpath/${base}`, binary]);
      info(`rewrote ${abs} → @rpath/${base}`);
    } catch (e) {
      warn(`install_name_tool -change failed for ${abs}: ${e.message}`);
    }
  }
}

/**
 * Remove build-tree rpaths and add standard .app rpaths.
 */
function normalizeRpaths(binary, rpaths) {
  // Strip any rpath that points outside the .app bundle. Typical SPM
  // output is `/Users/.../freekoko-sidecar/.build/.../release` and a
  // hardcoded Xcode toolchain path. `/usr/lib/swift` is harmless (points
  // at the system Swift runtime which is always present on macOS 15+).
  // `@loader_path` / `@executable_path` are exactly the relocatable
  // rpaths we want. Everything else is suspicious — drop it.
  const keepPrefixes = ['@loader_path', '@executable_path', '/usr/lib/swift'];
  for (const rp of rpaths) {
    const keep = keepPrefixes.some((p) => rp === p || rp.startsWith(p));
    if (keep) continue;
    try {
      run('install_name_tool', ['-delete_rpath', rp, binary]);
      info(`deleted build-tree rpath ${rp}`);
    } catch (e) {
      warn(`delete_rpath failed for ${rp}: ${e.message}`);
    }
  }
  // Add the two standard rpaths if not present.
  const wanted = ['@executable_path', '@executable_path/../Frameworks'];
  const { rpaths: current } = inspectLoadCommands(binary);
  for (const rp of wanted) {
    if (!current.includes(rp)) {
      try {
        run('install_name_tool', ['-add_rpath', rp, binary]);
        info(`added rpath ${rp}`);
      } catch (e) {
        // Duplicate rpath → benign.
        warn(`add_rpath failed for ${rp}: ${e.message}`);
      }
    }
  }
}

/**
 * Ad-hoc sign the binary with our JIT entitlements. Recent macOS rejects
 * completely unsigned binaries spawned by Electron when the parent .app
 * carries a quarantine bit.
 */
function adhocSign(binary, entitlementsPath) {
  if (!fs.existsSync(entitlementsPath)) {
    warn(`entitlements not found at ${entitlementsPath}; signing without entitlements`);
    run('codesign', ['--force', '--sign', '-', '--options', 'runtime', binary]);
    return;
  }
  run('codesign', [
    '--force',
    '--sign',
    '-',
    '--entitlements',
    entitlementsPath,
    // Note: do NOT pass --options runtime here. Hardened runtime is
    // incompatible with MLX JIT (see ARCHITECTURE.md §7 R2). Ad-hoc
    // signing without hardened runtime is exactly what we want.
    binary,
  ]);
  info('ad-hoc signed with JIT entitlements');
}

module.exports = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName, arch } = context;
  if (electronPlatformName !== 'darwin') {
    info(`platform ${electronPlatformName} — skipping (macOS only)`);
    return;
  }

  ensureToolsAvailable();

  const appName = packager.appInfo.productFilename; // "freekoko"
  const appPath = path.join(appOutDir, `${appName}.app`);
  const sidecarDir = path.join(appPath, 'Contents', 'Resources', 'sidecar');
  const binary = path.join(sidecarDir, 'freekoko-sidecar');
  const entitlements = path.join(
    packager.info.projectDir,
    'build',
    'entitlements.mac.plist',
  );

  info(`appOutDir=${appOutDir}`);
  info(`arch=${arch}`);
  info(`sidecar=${binary}`);

  if (!fs.existsSync(binary)) {
    fail(
      `Sidecar binary not found at ${binary}. ` +
        `Did you run 'make sidecar' before 'make dmg'?`,
    );
  }

  // 1. Ensure it is executable.
  fs.chmodSync(binary, 0o755);
  info('chmod +x on sidecar');

  // 2/3. Inspect and rewrite load commands.
  let inspect = inspectLoadCommands(binary);
  info(`initial rpaths: ${JSON.stringify(inspect.rpaths)}`);
  info(`initial absolute dylib loads: ${inspect.absoluteLoadPaths.length}`);

  relocateAbsoluteDylibs(binary, inspect.absoluteLoadPaths, sidecarDir);
  normalizeRpaths(binary, inspect.rpaths);

  // Also copy dylibs from the Swift build directory so @executable_path
  // resolution finds them. The release build directory lives next to the
  // sidecar source tree.
  const swiftBuildDir = path.resolve(
    packager.info.projectDir,
    '..',
    'freekoko-sidecar',
    '.build',
    'arm64-apple-macosx',
    'release',
  );
  if (fs.existsSync(swiftBuildDir)) {
    const dylibs = fs
      .readdirSync(swiftBuildDir)
      .filter((n) => n.endsWith('.dylib'));
    for (const d of dylibs) {
      const src = path.join(swiftBuildDir, d);
      const dst = path.join(sidecarDir, d);
      if (!fs.existsSync(dst)) {
        try {
          fs.copyFileSync(src, dst);
          fs.chmodSync(dst, 0o755);
          info(`bundled dylib ${d}`);
        } catch (e) {
          warn(`failed to bundle ${d}: ${e.message}`);
        }
      }
    }
  } else {
    warn(`Swift build dir not found at ${swiftBuildDir}; no dylibs to bundle.`);
  }

  // 4. Ad-hoc sign.
  try {
    adhocSign(binary, entitlements);
  } catch (e) {
    warn(`codesign failed: ${e.message}. The sidecar may refuse to launch.`);
  }

  // Also sign any dylibs we bundled — codesign cascades through rpath
  // resolution and unsigned dylibs in the same directory can trip
  // gatekeeper.
  for (const entry of fs.readdirSync(sidecarDir)) {
    if (entry.endsWith('.dylib')) {
      try {
        run('codesign', ['--force', '--sign', '-', path.join(sidecarDir, entry)]);
      } catch (e) {
        warn(`codesign of ${entry} failed: ${e.message}`);
      }
    }
  }

  // 5. Final validation.
  inspect = inspectLoadCommands(binary);
  if (inspect.absoluteLoadPaths.length > 0) {
    warn(
      `Binary still has ${inspect.absoluteLoadPaths.length} absolute load path(s). ` +
        `These may resolve via dyld fallback but should be reviewed:\n  ` +
        inspect.absoluteLoadPaths.join('\n  '),
    );
  } else {
    info('all dylib load commands are now relative (@rpath / system).');
  }
  info(`final rpaths: ${JSON.stringify(inspect.rpaths)}`);
  info('afterPack complete.');
};
