import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ENGINE_PIN, type EnginePaths } from './types';

/**
 * The shape of ENGINE_PIN with its literal types widened — injectable so a
 * test can pin a fixture archive under its own real sha256. Production
 * always passes ENGINE_PIN itself.
 */
// `Record<keyof …>` rather than a mapped `{ [K in keyof …]: string }`: the
// same type, but this repo's @typescript-eslint crashes on a TSMappedType
// over `keyof typeof` (no-unused-vars, collectUnusedVariables.ts:152), and
// a lint step that throws is a lint step nobody reads.
export type EnginePin = Record<keyof typeof ENGINE_PIN, string>;

/**
 * Turns the archive Waypoint ships into an engine the supervisor can run —
 * ROAD-47.
 *
 * The archive travels inside the app (electron-builder `extraResources`
 * copies `engine/` next to `assets/`) rather than being downloaded after
 * install, because a post-install download of a 62 MB executable is exactly
 * the thing macOS Gatekeeper quarantines, and a fetch that fails on a
 * customer's network leaves the app claiming a feature it cannot run. It is
 * extracted into `userData` rather than run from inside the app bundle so
 * the daemon can write its socket, pid file and SQLite stores beside itself
 * without touching a signed `.app`.
 *
 * Every step verifies before the next trusts it: the archive's sha256
 * against `ENGINE_PIN` before extraction; the extracted `manifest.json`
 * against the pin after. The supervisor never starts a launcher this module
 * has not vouched for.
 */

export type EngineInstallResult =
  | { ok: true; installDir: string; manifest: EngineManifest }
  /** Every refusal is a sentence the UI can show; none is a thrown Error. */
  | { ok: false; reason: EngineInstallRefusal; message: string };

export type EngineInstallRefusal =
  /** Not darwin-arm64. Apple Silicon only in this release (ROAD-101). */
  | 'unsupported-platform'
  /** No archive where the build should have put it. */
  | 'archive-missing'
  /** The archive on disk is not the one the pin names. */
  | 'sha256-mismatch'
  /** `tar` failed, or the launcher is not where the pin says. */
  | 'extract-failed'
  /** Extracted, but `manifest.json` disagrees with the pin. */
  | 'manifest-mismatch';

/** `manifest.json` at the archive root — written by emdash's packager. */
export interface EngineManifest {
  name: string;
  version: string;
  protocolVersion: string;
  os: string;
  arch: string;
  nodeVersion: string;
  ripgrepVersion: string;
}

export interface EngineInstallerDeps {
  /** Where the bundled archive lives: `<app>/engine/` in dev,
   *  `<resourcesPath>/engine/` packaged. The caller resolves it because only
   *  main.ts knows `app.isPackaged`; this module stays Electron-free. */
  bundledArchiveDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

export function archiveFileName(pin: EnginePin = ENGINE_PIN): string {
  return `${pin.name}-${pin.version}-${pin.target}.tar.gz`;
}

export function bundledArchivePath(
  deps: EngineInstallerDeps,
  pin: EnginePin = ENGINE_PIN,
): string {
  return path.join(deps.bundledArchiveDir, archiveFileName(pin));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads and checks the manifest of an already-extracted install. Exposed on
 * its own so the supervisor's `install()` can answer "installed?" on every
 * launch without re-extracting anything.
 */
export async function verifyInstalledEngine(
  paths: EnginePaths,
  pin: EnginePin = ENGINE_PIN,
): Promise<EngineInstallResult> {
  if (!(await exists(paths.launcherPath))) {
    return {
      ok: false,
      reason: 'extract-failed',
      message: `No engine launcher at ${paths.launcherPath}.`,
    };
  }
  const manifestPath = path.join(paths.installDir, pin.name, 'manifest.json');
  let manifest: EngineManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    return {
      ok: false,
      reason: 'manifest-mismatch',
      message: `Could not read ${manifestPath}.`,
    };
  }
  const [os, arch] = pin.target.split('-');
  const expected = {
    version: pin.version,
    protocolVersion: pin.protocolVersion,
    os,
    arch,
  };
  for (const [key, want] of Object.entries(expected)) {
    const got = (manifest as unknown as Record<string, unknown>)[key];
    if (got !== want) {
      return {
        ok: false,
        reason: 'manifest-mismatch',
        message: `Installed engine's ${key} is ${String(got)}; Waypoint is pinned to ${want}.`,
      };
    }
  }
  return { ok: true, installDir: paths.installDir, manifest };
}

/**
 * Extracts the bundled archive into `paths.installDir` if it is not already
 * there and valid. Idempotent: a valid install is left alone; a broken one
 * (wrong manifest, missing launcher) is removed and re-extracted from the
 * archive, which is re-hashed first.
 */
export async function installEngine(
  paths: EnginePaths,
  deps: EngineInstallerDeps,
  pin: EnginePin = ENGINE_PIN,
): Promise<EngineInstallResult> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  if (`${platform}-${arch}` !== pin.target) {
    return {
      ok: false,
      reason: 'unsupported-platform',
      message: `The agent engine is built for ${pin.target} in this release; this machine is ${platform}-${arch}.`,
    };
  }

  const already = await verifyInstalledEngine(paths, pin);
  if (already.ok) return already;

  const archive = bundledArchivePath(deps, pin);
  if (!(await exists(archive))) {
    return {
      ok: false,
      reason: 'archive-missing',
      message: `Engine archive not found at ${archive}. In development run \`npm run engine:fetch\`.`,
    };
  }
  // Read once, hash those bytes, extract those same bytes — never re-read
  // the path. Found in review (L7): hashing the file and then handing the
  // *path* to tar left a window in which a same-user writer could swap
  // the archive between the check and the extraction. The threat model is
  // thin (same-user write to the app bundle is game over regardless), but
  // the fix costs nothing: tar reads the buffer from stdin.
  const archiveBytes = await fs.readFile(archive);
  const actual = createHash('sha256').update(archiveBytes).digest('hex');
  if (actual !== pin.sha256) {
    return {
      ok: false,
      reason: 'sha256-mismatch',
      message: `Engine archive at ${archive} has sha256 ${actual.slice(0, 12)}…, pinned is ${pin.sha256.slice(0, 12)}…. Refusing to install it.`,
    };
  }

  // Fresh directory every time we extract: a half-extracted previous attempt
  // must not be able to shadow files from this one.
  await fs.rm(paths.installDir, { recursive: true, force: true });
  await fs.mkdir(paths.installDir, { recursive: true });
  try {
    // `/usr/bin/tar` by absolute path — one fewer thing PATH can change.
    // macOS ships bsdtar there; `-xzf - -C dir` reads the archive from
    // stdin identically on GNU tar, so this holds for the Linux targets
    // (ROAD-102) when they come. The archive is trusted ONLY because its
    // hash matched the pin a moment ago: bsdtar without `-P` refuses
    // absolute and `..` entries, and the pinned archive was inspected
    // (959 entries, none of either), but neither of those is why this is
    // safe — the hash is.
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        '/usr/bin/tar',
        ['-xzf', '-', '-C', paths.installDir],
        (error) => (error ? reject(error) : resolve()),
      );
      child.stdin?.on('error', reject);
      child.stdin?.end(archiveBytes);
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'extract-failed',
      message: `tar failed extracting ${archive}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  // The launcher is a shell script; tar preserves its mode, but be explicit
  // — an archive repacked on a filesystem that dropped the bit would
  // otherwise fail at spawn with an unhelpful EACCES.
  try {
    await fs.chmod(paths.launcherPath, 0o755);
  } catch {
    // verifyInstalledEngine reports the missing launcher with a better message.
  }
  return verifyInstalledEngine(paths, pin);
}
