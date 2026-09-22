import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { findChromiumBinary, launchIsolatedChromium } from './browser';

describe('findChromiumBinary', () => {
  it('finds the puppeteer-managed Chrome for Testing build under the cache dir', () => {
    const arm64 =
      '/Users/x/.cache/puppeteer/chrome/mac_arm-127.0.6533.88/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    const found = findChromiumBinary({
      homeDir: '/Users/x',
      readdirSync: () => ['mac_arm-127.0.6533.88'],
      existsSync: (p) => p === arm64,
    });
    expect(found).toBe(arm64);
  });

  it('falls back to the system Chrome when no puppeteer cache exists', () => {
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const found = findChromiumBinary({
      homeDir: '/Users/x',
      readdirSync: () => {
        throw new Error('ENOENT');
      },
      existsSync: (p) => p === systemChrome,
    });
    expect(found).toBe(systemChrome);
  });

  it('returns null when neither is present', () => {
    const found = findChromiumBinary({
      homeDir: '/Users/x',
      readdirSync: () => [],
      existsSync: () => false,
    });
    expect(found).toBeNull();
  });
});

/** A ChildProcess-shaped fake that never actually exists as a process. */
function fakeChild(): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  (emitter as unknown as { kill: (signal?: string) => boolean }).kill = jest.fn(() => true);
  return emitter;
}

describe('launchIsolatedChromium', () => {
  it('spawns headless with a fresh profile dir and an isolated remote-debugging port, then resolves once the probe reports ready', async () => {
    const child = fakeChild();
    const spawnFn = jest.fn(() => child);
    const rm = jest.fn(async () => {});
    let probeCalls = 0;
    const probe = jest.fn(async () => {
      probeCalls += 1;
      return probeCalls >= 2; // not ready first check, ready second
    });

    const handle = await launchIsolatedChromium({
      binaryPath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      spawnFn,
      mkdtempSync: (prefix) => `${prefix}abc123`,
      rm,
      probe,
      sleep: async () => {},
    });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [binary, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(binary).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(args).toEqual(
      expect.arrayContaining([
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--headless=new',
      ]),
    );
    expect(args.some((a) => a.startsWith('--remote-debugging-port='))).toBe(true);
    expect(args.some((a) => a.startsWith('--user-data-dir='))).toBe(true);
    expect(handle.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(handle.profileDir).toContain('abc123');

    await handle.close();
    expect(rm).toHaveBeenCalledWith(handle.profileDir);
    // A second close is a no-op, not a second kill/rm.
    await handle.close();
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it('throws when no Chromium binary is available', async () => {
    await expect(
      launchIsolatedChromium({ binaryPath: null }),
    ).rejects.toThrow(/No Chromium found/);
  });

  it('kills the process and removes the profile when the CDP endpoint never answers', async () => {
    const child = fakeChild();
    const rm = jest.fn(async () => {});
    const probe = jest.fn(async () => false);

    await expect(
      launchIsolatedChromium({
        binaryPath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        spawnFn: () => child,
        mkdtempSync: (prefix) => `${prefix}xyz`,
        rm,
        probe,
        sleep: async () => {},
        readyTimeoutMs: 10,
      }),
    ).rejects.toThrow(/did not answer on CDP port/);

    expect((child.kill as jest.Mock)).toHaveBeenCalledWith('SIGKILL');
    expect(rm).toHaveBeenCalled();
  });
});
