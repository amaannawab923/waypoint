import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Ultrafast browser tasks (docs/design/ultrafast-browser-tasks.md): a
 * verify-in-browser session can hand a multi-step walk to browser-use's
 * jev-ultrafast — a fast decision-model agent — instead of driving a page
 * one Claude tool call at a time. jev-ultrafast is Python >=3.12 and pulls
 * in browser-harness; neither belongs in this app's own Node dependency
 * tree, so this provisions a private venv under this app's own userData,
 * the same "nothing outside our own data directory" posture EnginePaths
 * (../paths.ts) holds for the emdash daemon.
 *
 * Pinned to an exact commit of jev-ultrafast (MIT,
 * https://github.com/browser-use/jev-ultrafast) and an exact
 * browser-harness release — never a floating `@latest` — so a person's
 * machine cannot silently pick up an unreviewed upstream change. Bumping
 * either pin is a deliberate code change here, not something that happens
 * on its own.
 */
export const ULTRAFAST_PIN = {
  /** browser-use/jev-ultrafast, pinned commit. */
  jevCommit: '1231850a0bf1a0c0341fe408ef1668dbbfdfac46',
  harnessVersion: '0.1.13',
} as const;

export interface UltrafastPaths {
  /** `<userData>/ultrafast` — everything below lives under here. */
  root: string;
  venvDir: string;
  /** `<venvDir>/bin/python` — what gets spawned as the runner's interpreter. */
  venvPython: string;
  /** `<venvDir>/bin/browser-harness`. */
  venvBrowserHarness: string;
  /** Marks which pin is currently installed, so re-provisioning is a no-op
   *  until the pin above actually changes. */
  pinnedFile: string;
  /** `BH_HOME` for browser-harness — kept inside our own data directory so
   *  its state never mixes with anything on the person's real machine. */
  bhHome: string;
  /** `BH_RUNTIME_DIR` — browser-harness's scratch dir; same reasoning as bhHome. */
  bhRuntimeDir: string;
  /**
   * Where a task's screenshots land, one subfolder per task id — this
   * codebase has no `evidence.ts`/run-evidence layout for a browser task's
   * screenshots to plug into yet (checked: `src/main/engine/runs/` has no
   * such file), so this is this feature's own root rather than a shared
   * one. If/when a real Evidence tab and run-evidence layout are added,
   * this is the one constant that would move under it.
   */
  evidenceRoot: string;
}

export function resolveUltrafastPaths(userData: string): UltrafastPaths {
  const root = path.join(userData, 'ultrafast');
  const venvDir = path.join(root, 'venv');
  return {
    root,
    venvDir,
    venvPython: path.join(venvDir, 'bin', 'python'),
    venvBrowserHarness: path.join(venvDir, 'bin', 'browser-harness'),
    pinnedFile: path.join(root, 'pinned.json'),
    bhHome: path.join(root, 'bh-home'),
    bhRuntimeDir: path.join(root, 'bh-runtime'),
    evidenceRoot: path.join(root, 'run-evidence'),
  };
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs one command to completion and reports its exit code and output —
 * never throws on a non-zero exit, since every caller below needs to read
 * stderr to build an honest message. Injected everywhere a real spawn would
 * otherwise happen, so provisioning is unit-testable without `uv` or Python
 * installed at all.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<CommandResult>;

const UV_FIXED_CANDIDATES = ['/opt/homebrew/bin/uv', '/usr/local/bin/uv'];

/**
 * `uv`'s location, checked in the order the founder's machine actually
 * resolves it: PATH first (a person who already has it on PATH should get
 * that one, not a stale Homebrew copy), then the well-known install
 * locations this feature's spec names — Homebrew's Apple Silicon prefix and
 * `uv`'s own installer default under the home directory. Returns null
 * rather than throwing: `uv` is an optional host dependency, and "not
 * found" is a status this feature reports, not an error condition.
 */
export function findUv(
  deps: {
    pathEnv?: string;
    homeDir?: string;
    existsSync?: (p: string) => boolean;
  } = {},
): string | null {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? '';
  const homeDir = deps.homeDir ?? os.homedir();
  const candidates = [
    ...pathEnv.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'uv')),
    ...UV_FIXED_CANDIDATES,
    path.join(homeDir, '.local', 'bin', 'uv'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

interface PinnedMarker {
  jevCommit: string;
  harnessVersion: string;
  provisionedAt: number;
}

function readPinnedMarker(
  pinnedFile: string,
  existsSync: (p: string) => boolean,
  readFileSync: (p: string) => string,
): PinnedMarker | null {
  try {
    if (!existsSync(pinnedFile)) return null;
    const parsed = JSON.parse(readFileSync(pinnedFile)) as Partial<PinnedMarker>;
    if (
      typeof parsed.jevCommit !== 'string' ||
      typeof parsed.harnessVersion !== 'string' ||
      typeof parsed.provisionedAt !== 'number'
    ) {
      return null;
    }
    return parsed as PinnedMarker;
  } catch {
    return null;
  }
}

export interface ProvisionDeps {
  paths: UltrafastPaths;
  /** From `findUv()`; callers check this is non-null before provisioning. */
  uvPath: string;
  run: CommandRunner;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
  writeFileSync?: (p: string, data: string) => void;
  mkdirSync?: (p: string) => void;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

export type ProvisionResult =
  | { ok: true; alreadyProvisioned: boolean }
  | { ok: false; message: string };

// One provisioning attempt per venv directory at a time — a second call
// while the first is still installing joins the same promise rather than
// racing `uv venv` against itself. Keyed by venvDir so tests using distinct
// tmp dirs never share a lock with each other or with a real install.
const inFlight = new Map<string, Promise<ProvisionResult>>();

async function provisionOnce(deps: ProvisionDeps): Promise<ProvisionResult> {
  const { paths, uvPath, run } = deps;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const writeFileSync = deps.writeFileSync ?? ((p: string, data: string) => fs.writeFileSync(p, data));
  const mkdirSync = deps.mkdirSync ?? ((p: string) => fs.mkdirSync(p, { recursive: true }));

  const marker = readPinnedMarker(paths.pinnedFile, existsSync, readFileSync);
  const upToDate =
    marker !== null &&
    marker.jevCommit === ULTRAFAST_PIN.jevCommit &&
    marker.harnessVersion === ULTRAFAST_PIN.harnessVersion &&
    existsSync(paths.venvPython);
  if (upToDate) return { ok: true, alreadyProvisioned: true };

  mkdirSync(paths.root);

  const venv = await run(uvPath, ['venv', '--python', '3.12', paths.venvDir]);
  if (venv.code !== 0) {
    return {
      ok: false,
      message: `Couldn't create the Python 3.12 environment: ${venv.stderr.trim() || `uv venv exited ${venv.code}`}`,
    };
  }

  const install = await run(uvPath, [
    'pip',
    'install',
    '--python',
    paths.venvPython,
    `jev-ultrafast @ git+https://github.com/browser-use/jev-ultrafast@${ULTRAFAST_PIN.jevCommit}`,
    `browser-harness==${ULTRAFAST_PIN.harnessVersion}`,
  ]);
  if (install.code !== 0) {
    return {
      ok: false,
      message: `Couldn't install jev-ultrafast and browser-harness: ${install.stderr.trim() || `uv pip install exited ${install.code}`}`,
    };
  }

  // Telemetry-off is a privacy requirement, not a functional one — a
  // failure here (an odd PATH, a harness build with a different CLI shape)
  // must not fail the whole provision when the venv itself is good, so it
  // is logged and swallowed rather than returned as an error.
  try {
    const telemetry = await run(paths.venvBrowserHarness, ['telemetry', 'disable'], {
      env: { BH_HOME: paths.bhHome, BH_RUNTIME_DIR: paths.bhRuntimeDir, BH_UPDATE_CHECK: '0' },
    });
    if (telemetry.code !== 0) {
      deps.logger?.warn('ultrafast: browser-harness telemetry disable failed', {
        code: telemetry.code,
        stderr: telemetry.stderr.trim(),
      });
    }
  } catch (error) {
    deps.logger?.warn('ultrafast: browser-harness telemetry disable threw', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  writeFileSync(
    paths.pinnedFile,
    JSON.stringify(
      {
        jevCommit: ULTRAFAST_PIN.jevCommit,
        harnessVersion: ULTRAFAST_PIN.harnessVersion,
        provisionedAt: Date.now(),
      } satisfies PinnedMarker,
      null,
      2,
    ),
  );

  return { ok: true, alreadyProvisioned: false };
}

/**
 * Idempotent: a second call against an already-pinned, already-present venv
 * returns immediately with `alreadyProvisioned: true` and runs nothing.
 * Serialized per venv directory (see `inFlight` above) so two IPC calls
 * arriving close together — the settings page's status check racing the
 * person's Test click — cannot corrupt one venv with two installs.
 */
export function provisionPythonEnv(deps: ProvisionDeps): Promise<ProvisionResult> {
  const key = deps.paths.venvDir;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = provisionOnce(deps).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

/** Whether `paths` already has a venv matching the current pin, without
 *  running or blocking on anything — the fast, synchronous check the
 *  status IPC handler uses before deciding whether to provision. */
export function isProvisioned(
  paths: UltrafastPaths,
  deps: { existsSync?: (p: string) => boolean; readFileSync?: (p: string) => string } = {},
): boolean {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const marker = readPinnedMarker(paths.pinnedFile, existsSync, readFileSync);
  return (
    marker !== null &&
    marker.jevCommit === ULTRAFAST_PIN.jevCommit &&
    marker.harnessVersion === ULTRAFAST_PIN.harnessVersion &&
    existsSync(paths.venvPython)
  );
}

/**
 * The real `CommandRunner` production code passes to `provisionPythonEnv`
 * — every test above supplies its own fake instead. No shell involved
 * (`shell: false`, spawn's own default): `command` and `args` are never
 * interpolated into a string a shell would re-parse, since the pin's own
 * git ref is compiled into an argv element, not user input, but this
 * still costs nothing to hold to.
 */
export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
