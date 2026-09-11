import path from 'path';
import { ENGINE_PIN } from './types';
import { resolveEnginePaths } from './paths';

const USER_DATA = '/Users/max/Library/Application Support/Waypoint';

describe('resolveEnginePaths', () => {
  it('nests every path under <userData>/engine/, never ~/.emdash', () => {
    const paths = resolveEnginePaths(USER_DATA);

    Object.values(paths).forEach((value) => {
      expect(value.startsWith(path.join(USER_DATA, 'engine'))).toBe(true);
      expect(value).not.toContain('.emdash');
    });
  });

  it('versions installDir by the pin, so a future pin bump installs beside the old one', () => {
    const paths = resolveEnginePaths(USER_DATA);

    expect(paths.installDir).toBe(
      path.join(USER_DATA, 'engine', ENGINE_PIN.version),
    );
  });

  it("builds launcherPath from installDir + the pin's launcherRelPath", () => {
    const paths = resolveEnginePaths(USER_DATA);

    expect(paths.launcherPath).toBe(
      path.join(
        USER_DATA,
        'engine',
        ENGINE_PIN.version,
        ENGINE_PIN.launcherRelPath,
      ),
    );
  });

  // Load-bearing for the daemon's own state-directory derivation — see this
  // file's header comment and apps/workspace-server/src/runtime/paths.ts:18-22
  // in emdash: the daemon computes its state dir by stripping a trailing
  // `run` segment off the socket's directory. If `runDir`'s basename ever
  // stopped being `run`, the daemon's own state dir would silently diverge
  // from what `stateDir` here claims.
  it('gives runDir a basename of exactly "run", so the daemon derives the same stateDir', () => {
    const paths = resolveEnginePaths(USER_DATA);

    expect(path.basename(paths.runDir)).toBe('run');
    expect(paths.socketPath).toBe(path.join(paths.runDir, 'workspace.sock'));
  });

  it("puts stateDir as a sibling of runDir, matching the daemon's own derivation", () => {
    const paths = resolveEnginePaths(USER_DATA);

    expect(paths.stateDir).toBe(path.join(USER_DATA, 'engine', 'state'));
    expect(path.dirname(paths.stateDir)).toBe(path.dirname(paths.runDir));
  });

  it('writes engine.log at the engine root, outside runDir and stateDir', () => {
    const paths = resolveEnginePaths(USER_DATA);

    expect(paths.logPath).toBe(path.join(USER_DATA, 'engine', 'engine.log'));
  });

  it('is pure: the same inputs always produce the same paths', () => {
    expect(resolveEnginePaths(USER_DATA)).toEqual(
      resolveEnginePaths(USER_DATA),
    );
  });

  // A future pin (a version bump) must install beside the old one rather
  // than overwrite it in place, so a supervisor mid-upgrade can still fall
  // back. Passing a custom pin is what lets the test (and, later, an actual
  // upgrade path) exercise that without waiting for a real version bump.
  it('honors an overridden pin, for testing a future version without waiting on a real bump', () => {
    const customPin = {
      ...ENGINE_PIN,
      version: '0.2.0',
      launcherRelPath: 'emdash-workspace-server/bin/emdash-workspace-server',
    };

    const paths = resolveEnginePaths(USER_DATA, customPin);

    expect(paths.installDir).toBe(path.join(USER_DATA, 'engine', '0.2.0'));
    expect(paths.runDir).toBe(path.join(USER_DATA, 'engine', 'run'));
  });
});

describe('resolveEnginePaths — socket path length', () => {
  // Observed live: the daemon's `start` fails with `connect EINVAL` past
  // macOS's 104-byte sun_path. The guard names the limit instead.
  it('refuses a userData whose socket path would exceed the macOS limit', () => {
    const longUserData = `/Users/${'a'.repeat(90)}/Library/Application Support/waypoint`;
    expect(() => resolveEnginePaths(longUserData)).toThrow(/104/);
  });

  it('accepts a typical macOS userData path', () => {
    const typical = '/Users/amaannawab/Library/Application Support/waypoint-frontend';
    expect(() => resolveEnginePaths(typical)).not.toThrow();
  });
});
