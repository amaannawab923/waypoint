import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/**
 * The isolated Chromium a browser task drives — NEVER the person's real
 * Chrome, and never sessionBrowser.ts's own chrome-devtools-mcp browser
 * either (that one is per-session, driven tool-call-by-tool-call by Claude;
 * this one is per-task, driven decision-by-decision by jev-ultrafast over
 * CDP). A fresh, throwaway profile, headless, killed and deleted the moment
 * the task ends — including on error or timeout, so a stuck task cannot
 * leave a Chromium process or a temp profile behind.
 *
 * browser-harness (the Python side) never launches its own browser here:
 * it is told `BU_CDP_URL` and attaches to whatever is already listening —
 * so this module owns the one thing that must never be ambiguous, which
 * browser that URL actually points at.
 */

export interface ChromiumHandle {
  cdpUrl: string;
  profileDir: string;
  /** Kills the process and removes the profile directory. Safe to call more than once. */
  close: () => Promise<void>;
}

export type ChromiumSpawn = (command: string, args: string[]) => ChildProcess;

const PUPPETEER_CACHE_RELATIVE = path.join('.cache', 'puppeteer', 'chrome');
const SYSTEM_CHROME_MAC =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * A Chromium binary this app already has on disk, checked in the order
 * verified live on the founder's machine: the puppeteer-managed "Chrome for
 * Testing" build chrome-devtools-mcp already downloads for sessionBrowser.ts
 * (`~/.cache/puppeteer/chrome/<version>/chrome-mac-arm64/…`, or the x64
 * sibling directory on an Intel Mac), then the person's own installed
 * Google Chrome as a fallback. Returns null rather than throwing — "no
 * Chromium available" is a status this feature reports (alongside "uv
 * missing"), not a crash.
 */
export function findChromiumBinary(
  deps: {
    homeDir?: string;
    existsSync?: (p: string) => boolean;
    readdirSync?: (p: string) => string[];
  } = {},
): string | null {
  const homeDir = deps.homeDir ?? os.homedir();
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readdirSync = deps.readdirSync ?? ((p: string) => fs.readdirSync(p));
  const cacheDir = path.join(homeDir, PUPPETEER_CACHE_RELATIVE);

  try {
    const versions = readdirSync(cacheDir);
    // eslint-disable-next-line no-restricted-syntax
    for (const version of versions) {
      // eslint-disable-next-line no-restricted-syntax
      for (const arch of ['chrome-mac-arm64', 'chrome-mac-x64']) {
        const candidate = path.join(
          cacheDir,
          version,
          arch,
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing',
        );
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // No puppeteer cache on this machine — fall through to the system browser.
  }

  return existsSync(SYSTEM_CHROME_MAC) ? SYSTEM_CHROME_MAC : null;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export type CdpProbe = (port: number) => Promise<boolean>;

/** The default probe: a real `GET /json/version`, the same readiness check
 *  browser-harness itself does before attaching. */
const defaultCdpProbe: CdpProbe = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
};

async function waitForCdp(
  port: number,
  timeoutMs: number,
  probe: CdpProbe,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await probe(port)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Chromium did not answer on CDP port ${port} within ${timeoutMs}ms.`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(150);
  }
}

export interface LaunchChromiumDeps {
  /** Defaults to `findChromiumBinary()`. */
  binaryPath?: string | null;
  spawnFn?: ChromiumSpawn;
  tmpdir?: string;
  mkdtempSync?: (prefix: string) => string;
  rm?: (p: string) => Promise<void>;
  readyTimeoutMs?: number;
  probe?: CdpProbe;
  sleep?: (ms: number) => Promise<void>;
  /** Only ever false in a test — production always launches headless. */
  headless?: boolean;
}

/**
 * Launches a headless, single-use Chromium and waits until its CDP endpoint
 * answers. Never 9222/9333/9555 (this app's other tools' well-known ports):
 * a free ephemeral port is picked fresh per task, so N concurrent tasks
 * never collide and never impersonate another tool's debugging port.
 */
export async function launchIsolatedChromium(
  deps: LaunchChromiumDeps = {},
): Promise<ChromiumHandle> {
  const binaryPath =
    deps.binaryPath !== undefined ? deps.binaryPath : findChromiumBinary();
  if (!binaryPath) {
    throw new Error(
      'No Chromium found for ultrafast browser tasks — expected the puppeteer-managed Chrome for Testing build or /Applications/Google Chrome.app.',
    );
  }

  const mkdtempSync =
    deps.mkdtempSync ?? ((prefix: string) => fs.mkdtempSync(prefix));
  const tmpdir = deps.tmpdir ?? os.tmpdir();
  const profileDir = mkdtempSync(path.join(tmpdir, 'waypoint-ultrafast-'));
  const port = await findFreePort();

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    ...(deps.headless === false ? [] : ['--headless=new']),
  ];
  const spawnFn =
    deps.spawnFn ??
    ((command, spawnArgs) => spawn(command, spawnArgs, { stdio: 'ignore' }));
  const child = spawnFn(binaryPath, args);
  // A launch failure (bad binary path, exec permission) surfaces as an
  // 'error' event asynchronously; swallow it here so it cannot become an
  // unhandled 'error' that crashes the host process — waitForCdp's own
  // timeout is what actually reports the failure to the caller.
  child.on('error', () => {});

  const rm =
    deps.rm ?? ((p: string) => fsp.rm(p, { recursive: true, force: true }));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    await rm(profileDir).catch(() => {});
  };

  try {
    await waitForCdp(
      port,
      deps.readyTimeoutMs ?? 15_000,
      deps.probe ?? defaultCdpProbe,
      deps.sleep ??
        ((ms) =>
          new Promise((resolve) => {
            setTimeout(resolve, ms);
          })),
    );
  } catch (error) {
    await close();
    throw error;
  }

  return { cdpUrl: `http://127.0.0.1:${port}`, profileDir, close };
}
