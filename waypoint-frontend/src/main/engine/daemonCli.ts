/* eslint import/prefer-default-export: off -- one function plus its result
   types; the supervisor imports it by name. */
import { spawn } from 'child_process';
import type { EngineCommand } from './types';

// The supervisor's way to run the launcher's management commands — `start`,
// `stop`, `status` — in socket mode (ROAD-50, alongside the transports).
// Each is a short-lived CLI invocation of the same launcher the stdio
// transport spawns for `serve`; this file runs one, waits for it, and turns
// its exit code and printed lines into a typed result. It never talks Wire
// and never connects to the socket itself: `status` is the daemon's own
// probe of its own socket, reported in its own words, which is the point.
//
// Every output shape below is parsed from the format strings in emdash
// `apps/workspace-server/src/index.ts` (commit 9b102a5f3), not from sample
// output. Line references throughout are to that file unless another is
// named; `start.ts`, `stop.ts`, `status.ts`, `probe.ts`, `lock.ts`, and
// `paths.ts` are its siblings under `src/daemon/`.

/** `serve` is the transports' business; these three are management. */
export type DaemonManagementCommand = Exclude<EngineCommand, 'serve'>;

/**
 * How long a management command may run before it is killed and reported
 * as a timeout.
 *
 * `start` has the longest legitimate runtime: up to 5s waiting for the
 * lock file (`start.ts:86`, lockTimeoutMs defaults to timeoutMs, which
 * defaults to 5_000 at `start.ts:49`), then a 1s probe of the socket
 * (`start.ts:144`), then up to 5s of polling for the new daemon to answer
 * `health` (`start.ts:123-141`) — roughly 11s plus Node startup before the
 * CLI itself gives up and reports its own `timeout`. `stop` waits up to 5s
 * after SIGTERM (`stop.ts:68`); `status` is a single 1s probe
 * (`probe.ts:20`). Twenty seconds clears all of that with margin, which
 * matters more than usual here: killing `start` mid-flight skips the
 * `finally` that releases the daemon's lock file (`lock.ts:42-53`), and
 * that lock has no liveness check (`lock.ts:23-39`), so a premature kill
 * turns every later `start` into a 5s `lock` failure until someone deletes
 * `<socket>.lock` by hand. The right response to a slow `start` is to let
 * it report its own timeout; this ceiling only exists for a launcher that
 * is genuinely hung.
 */
export const DAEMON_COMMAND_TIMEOUT_MS = 20_000;

export interface RunDaemonCommandOptions {
  /**
   * Passed as `--socket <path>`. Always explicit: without it the daemon
   * defaults to `~/.emdash/workspace-server/run/workspace.sock`
   * (`paths.ts:4-10`) — emdash's own daemon, not ours (types.ts, EnginePaths).
   */
  socketPath: string;
  /**
   * Added on top of the inherited environment for the command. For `start`,
   * this environment IS the long-lived daemon's environment — `start`
   * spawns `serve` with its own `process.env` (`start.ts:112`, `index.ts:100`
   * passes no override) — and the daemon needs HOME, PATH, and whatever the
   * user's login state is to find and run the agent CLIs it hosts.
   *
   * Two different kinds of stripping are deliberately kept apart:
   *
   *  - What a *session* may see (tokens, ssh-agent, cloud keys) is ROAD-88's
   *    scrub at session time. Not here.
   *  - What would break the daemon's *own runtime* is removed here, in
   *    `engineRuntimeEnv()` — found in review (H1): under `npm start` the
   *    renderer dev server sets `NODE_OPTIONS="-r ts-node/register"` and
   *    Electron main inherits it; the launcher execs the daemon's bundled
   *    `node`, which resolves that preload from its cwd (the install dir,
   *    no node_modules) and dies with "Cannot find module 'ts-node/register'"
   *    before printing anything the parser knows. A Waypoint-dev-process
   *    artefact, not something the daemon should ever inherit.
   */
  env?: Record<string, string | undefined>;
  /**
   * The daemon reads a `.env` from its cwd for `EMDASH_WS_*` settings
   * (`config.ts:6`, emdash `packages/shared/src/config/index.ts:88`), and
   * for `start` that cwd is inherited by the daemon it spawns. Unset means
   * the command inherits ours. `--socket` on argv beats any `.env` either
   * way (`config/index.ts:50-55`, args layer last).
   */
  cwd?: string;
  /** Defaults to DAEMON_COMMAND_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * `start` printed its success line (`index.ts:102-104`): `started` when it
 * spawned a daemon and saw it answer `health`; `already-running` when its
 * initial probe found one (`start.ts:56-59`). Both are success, and the
 * caller should treat them alike.
 */
export interface DaemonStartOutcome {
  status: 'started' | 'already-running';
}

/**
 * `stop` printed its success line (`index.ts:111-115`): `stopped` when it
 * SIGTERMed a live pid and watched it go; `not-running` when there was no
 * pid file, or a stale one (`stop.ts:36-44`). Not-running is not an error —
 * the daemon is stopped, which is what was asked.
 */
export interface DaemonStopOutcome {
  status: 'stopped' | 'not-running';
}

/**
 * What `status` reports. Running (`index.ts:128-131`) carries the two
 * health facts the CLI prints; the rest of EngineHealth comes from our own
 * `health` call over the transport, not from here. Not running
 * (`index.ts:122-124`) keeps the daemon's own two-way distinction
 * (`probe.ts:11-14`, `probe.ts:73-81`): `not-running` is a connection
 * error (nothing on the socket), `unhealthy` is anything else — something
 * accepted the connection but did not answer `health` correctly within
 * the probe's timeout. The latter is the case `start` refuses to touch
 * (`start.ts:60-65`), so a caller seeing it should not expect `start` to
 * fix it.
 */
export type DaemonStatusOutcome =
  | { running: true; version: string; uptimeMs: number }
  | { running: false; reason: 'not-running' | 'unhealthy'; message: string };

export interface DaemonCommandOutcomes {
  start: DaemonStartOutcome;
  stop: DaemonStopOutcome;
  status: DaemonStatusOutcome;
}

/**
 * The ways a command can fail to produce an outcome. Note what is *not*
 * here: "daemon not running" is an outcome for both `stop` and `status`,
 * never a failure.
 */
export type DaemonCommandFailure =
  /** The launcher could not be executed at all (ENOENT, EACCES, ...). */
  | { kind: 'launcher'; message: string }
  /** Our ceiling elapsed; the command was SIGKILLed. See the constant. */
  | { kind: 'timeout'; timeoutMs: number }
  /**
   * The CLI printed `workspace-server failed: <message>` and exited 1 —
   * its one catch-all for any error its command returned or threw
   * (`index.ts:147-152`). For `start` this is the message of a
   * `lock | spawn | timeout | unhealthy` error (`start.ts:17-20`); for
   * `stop`, `signal | timeout` (`stop.ts:12-15`). The CLI prints only the
   * message and drops the type (`index.ts:101`, `index.ts:110`), so the
   * type cannot be recovered here and is not guessed at.
   */
  | {
      kind: 'daemon-error';
      message: string;
      code: number | null;
      signal: string | null;
    }
  /**
   * The process ended without printing any line this file knows. Wrong
   * binary at the launcher path, a daemon build whose output changed, or
   * a crash with no message — the raw output is on the result for the
   * caller to show.
   */
  | { kind: 'unrecognized-output'; code: number | null; signal: string | null };

export type DaemonCommandResult<T> =
  | { ok: true; value: T; stdout: string; stderr: string }
  | {
      ok: false;
      failure: DaemonCommandFailure;
      stdout: string;
      stderr: string;
    };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Last line in `text` matching `pattern`, or null. Last rather than first
 * because the daemon's process logger also writes to stderr
 * (`initProcessLogging`, `index.ts:25`), and the status line is the final
 * thing the command prints before exiting.
 */
function lastMatch(text: string, pattern: RegExp): RegExpMatchArray | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(pattern);
    if (match) return match;
  }
  return null;
}

/**
 * Parses one command's stdout/stderr into its outcome, or null when nothing
 * recognizable was printed. The socket path is matched literally: the CLI
 * echoes `paths.socketPath`, which is the `--socket` value untouched
 * (`paths.ts:19-21`), so a mismatch means we are not reading the output
 * of the command we ran.
 */
function parseOutcome(
  command: DaemonManagementCommand,
  socketPath: string,
  stdout: string,
  stderr: string,
): DaemonCommandOutcomes[DaemonManagementCommand] | null {
  const at = escapeRegExp(socketPath);
  switch (command) {
    case 'start': {
      // index.ts:102-104
      const m = lastMatch(
        stdout,
        new RegExp(
          `^workspace-server daemon (started|already-running) at ${at}$`,
        ),
      );
      if (!m) return null;
      return { status: m[1] as DaemonStartOutcome['status'] };
    }
    case 'stop': {
      // index.ts:111-115 — note "not running" with a space, unlike
      // status's "not-running".
      const m = lastMatch(
        stdout,
        new RegExp(`^workspace-server daemon (stopped|not running) at ${at}$`),
      );
      if (!m) return null;
      return { status: m[1] === 'stopped' ? 'stopped' : 'not-running' };
    }
    case 'status': {
      // index.ts:128-131
      const running = lastMatch(
        stdout,
        new RegExp(
          `^workspace-server daemon running at ${at} \\(version (.+), uptime (\\d+)ms\\)$`,
        ),
      );
      if (running) {
        return {
          running: true,
          version: running[1],
          uptimeMs: Number(running[2]),
        };
      }
      // index.ts:122-124
      const down = lastMatch(
        stderr,
        new RegExp(
          `^workspace-server daemon (not-running|unhealthy) at ${at}: (.*)$`,
        ),
      );
      if (down) {
        return {
          running: false,
          reason: down[1] as 'not-running' | 'unhealthy',
          message: down[2],
        };
      }
      return null;
    }
    default: {
      const unreachable: never = command;
      throw new Error(`unknown daemon command: ${String(unreachable)}`);
    }
  }
}

/**
 * Runs `<launcher> <command> --socket <socketPath>` and reports what it
 * said. Resolves always — a failure is a `DaemonCommandResult` with
 * `ok: false`, and "not running" is a successful outcome — so the
 * supervisor's state machine can pattern-match rather than catch.
 *
 * Exit codes, for the record: the CLI exits 0 whenever its command
 * returned a result (`main()` resolves and the loop drains — `start`
 * unrefs the daemon it spawned, `start.ts:116`, so it does not hold the
 * CLI open); it exits 1 either via `process.exitCode = 1` when `status`
 * finds no healthy daemon (`index.ts:125`) or via `process.exit(1)` after
 * printing `workspace-server failed:` for any thrown error
 * (`index.ts:147-152`). The lines, not the codes, carry the meaning, so
 * parsing is line-first and the code is reported alongside.
 */
/**
 * The inherited environment minus the variables that would reconfigure the
 * daemon's own Node runtime. Exported for the test and for the stdio
 * transport, which spawns the same launcher.
 *
 *  - NODE_OPTIONS / NODE_PATH: preloads and module paths meant for
 *    Waypoint's dev process, not for a bundled node in a bare directory.
 *  - ELECTRON_RUN_AS_NODE: set by Electron for its own forked helpers; the
 *    launcher runs a real node binary and must not be told it is Electron.
 *  - NODE_ENV: Waypoint's build mode ('development') is not the daemon's;
 *    the daemon reads its own config and never keys on this.
 */
export function engineRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const {
    NODE_OPTIONS: _nodeOptions,
    NODE_PATH: _nodePath,
    ELECTRON_RUN_AS_NODE: _electronRunAsNode,
    NODE_ENV: _nodeEnv,
    ...rest
  } = env;
  return rest;
}

export function runDaemonCommand<C extends DaemonManagementCommand>(
  launcherPath: string,
  command: C,
  options: RunDaemonCommandOptions,
): Promise<DaemonCommandResult<DaemonCommandOutcomes[C]>> {
  const timeoutMs = options.timeoutMs ?? DAEMON_COMMAND_TIMEOUT_MS;
  const { socketPath } = options;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (
      result:
        | { ok: true; value: DaemonCommandOutcomes[DaemonManagementCommand] }
        | { ok: false; failure: DaemonCommandFailure },
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // The cast narrows the per-command union back to the one the
      // caller asked for; parseOutcome only ever builds `command`'s shape.
      resolve({ ...result, stdout, stderr } as DaemonCommandResult<
        DaemonCommandOutcomes[C]
      >);
    };

    const child = spawn(launcherPath, [command, '--socket', socketPath], {
      env: { ...engineRuntimeEnv(process.env), ...options.env },
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    // Stream-level errors are reported through the child's own
    // 'error'/'close'; an unhandled 'error' on a pipe would crash main.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    child.on('error', (err: Error) => {
      settle({
        ok: false,
        failure: {
          kind: 'launcher',
          message: `could not run engine launcher ${launcherPath}: ${err.message}`,
        },
      });
    });

    timer = setTimeout(() => {
      // SIGKILL, not SIGTERM: the management commands install no signal
      // handler (`installSignalHandlers` is `serve`-only, `index.ts:34`),
      // so SIGTERM would be the same abrupt death with an extra step.
      child.kill('SIGKILL');
      settle({ ok: false, failure: { kind: 'timeout', timeoutMs } });
    }, timeoutMs);

    child.on('close', (code, signal) => {
      // The catch-all failure line takes precedence over everything: if
      // the CLI threw, whatever else it printed earlier is not an outcome.
      const failed = lastMatch(stderr, /^workspace-server failed: (.*)$/);
      if (failed) {
        settle({
          ok: false,
          failure: { kind: 'daemon-error', message: failed[1], code, signal },
        });
        return;
      }
      const value = parseOutcome(command, socketPath, stdout, stderr);
      if (value === null) {
        settle({
          ok: false,
          failure: { kind: 'unrecognized-output', code, signal },
        });
        return;
      }
      settle({ ok: true, value });
    });
  });
}
