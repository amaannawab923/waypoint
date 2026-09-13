import { spawn, type ChildProcess } from 'child_process';
import type {
  EngineTransport,
  EngineTransportCloseReason,
  Unsubscribe,
} from '../types';

// The stdio-mode transport (ROAD-50): Waypoint spawns `<launcher> serve
// --stdio` itself and speaks Wire over the child's stdin/stdout. The daemon
// is a child here, not a peer: `close()` ends it, and a clean Waypoint quit
// ends it. What does NOT end it is a SIGKILLed or crashed Waypoint — the
// child is spawned non-detached with pipes, and emdash's `serveStdio`
// (`apps/workspace-server/src/wire/serve-stdio.ts`) does not exit on stdin
// EOF; it dies on its next write to the closed pipe, which may be never
// (found in review, L3). Dormant on macOS, where the socket mode ships;
// live on Windows, where this mode is the plan (ROAD-99) and orphan
// reaping at the next launch (a pid breadcrumb) is part of that ticket.
// This mode exists so Windows — no Unix sockets — is a packaging task
// later rather than an architecture change (types.ts, section 3).
//
// Like socket.ts this moves bytes and reports the end of the connection
// once. It additionally owns the child's lifetime — that is the one thing
// socket mode's daemon does for itself and this mode's cannot.

/**
 * The exact line the daemon writes to stderr once its Wire server is
 * attached to stdin/stdout and it will answer calls:
 * `process.stderr.write('workspace-server wire stdio listening\n')` at
 * emdash `apps/workspace-server/src/index.ts:72`. Everything the daemon
 * does before it — refreshing the user's shell environment and building
 * its runtime host (`index.ts:54-62`) — happens with the pipes open but
 * nobody reading them, so a Wire call written before this line would sit
 * in the pipe unanswered. Resolving on the line, not on spawn, is what
 * makes "the transport resolved" mean "the daemon is listening".
 */
export const STDIO_READY_LINE = 'workspace-server wire stdio listening';

/**
 * How long to wait for STDIO_READY_LINE before giving up on the child.
 *
 * The unbounded step before that line is `shellEnv.refresh()`
 * (`index.ts:54-55`): the daemon runs the user's login shell to capture
 * its PATH and friends, which is as slow as the user's dotfiles make it —
 * an nvm or conda init in `.zshrc` routinely costs a second or two, and
 * an unlucky one much more. emdash's own `start` command budgets 5s for
 * the socket-mode equivalent of this wait (`daemon/start.ts:49`). This is
 * three times that, deliberately: `start`'s timeout leaves the daemon
 * running and merely reports late, whereas this one kills the child, and
 * a false kill would make Waypoint look broken on exactly the machines
 * with the heaviest shell setup.
 */
export const STDIO_READY_TIMEOUT_MS = 15_000;

/**
 * How long `close()` gives the child after SIGTERM before SIGKILL.
 *
 * On SIGTERM the daemon disposes its runtime scope — every agent process,
 * PTY and worker it hosts — and then exits 143 (`index.ts:134-145`). Five
 * seconds is the daemon authors' own allowance for that teardown: it is
 * exactly what their `stop` command waits after sending the same signal
 * (`daemon/stop.ts:47`, `stop.ts:68`). Where this differs from `stop` is
 * what happens when the allowance runs out. `stop` reports a timeout to a
 * human and leaves the process alone (`stop.ts:83`), which is right for a
 * CLI. A transport has no human to report to, and a child that will not
 * exit holds our pipes — and with them Electron's own quit — hostage, so
 * here the grace period ends in SIGKILL. POSIX semantics; on Windows
 * `kill('SIGTERM')` is already a hard terminate, so the grace is moot
 * there and the escalation harmless.
 */
export const STDIO_TERM_GRACE_MS = 5_000;

/**
 * How many recent stderr lines the transport keeps for diagnosis. The
 * daemon logs to stderr (`initProcessLogging`, `index.ts:25`), and the
 * lines just before an unexpected exit are usually the whole story. 200 is
 * a few screens — enough to include the cause, small enough that a chatty
 * daemon cannot turn this into a leak.
 */
const STDERR_RING_SIZE = 200;

/**
 * A process environment as `child_process.spawn` accepts it. Spelled out
 * rather than written `NodeJS.ProcessEnv` only because this repo's lint
 * config does not know the ambient `NodeJS` namespace; the shape is the
 * same one.
 */
export type EngineEnv = Record<string, string | undefined>;

export interface StdioTransportOptions {
  /**
   * The child's complete environment. Nothing is merged in here: the
   * caller decides what the daemon sees, exactly as with daemonCli.ts's
   * `start`, so the two modes cannot silently diverge in what they hand
   * the engine.
   */
  env: EngineEnv;
  /**
   * Working directory for the child. The daemon reads a `.env` from its
   * cwd for `EMDASH_WS_*` settings (`config.ts:6`, emdash
   * `packages/shared/src/config/index.ts:88`), so leave this unset — the
   * child inherits ours — only if that is acceptable; the supervisor
   * should normally point it somewhere it controls, such as the install
   * directory. Explicit `serve --stdio` on argv wins over any `.env` in
   * either case (`config/index.ts:50-55`, args layer last).
   */
  cwd?: string;
  /** Appended after `serve --stdio`. */
  extraArgs?: readonly string[];
  /** Defaults to STDIO_READY_TIMEOUT_MS. Exposed for tests. */
  readyTimeoutMs?: number;
  /** Defaults to STDIO_TERM_GRACE_MS. Exposed for tests. */
  termGraceMs?: number;
}

/**
 * The stdio transport is the contract's `EngineTransport` plus what only a
 * spawned child can offer: its pid and its stderr, which is where the
 * daemon logs.
 */
export interface StdioEngineTransport extends EngineTransport {
  readonly mode: 'stdio';
  readonly pid: number;
  /**
   * Every complete stderr line from the child, as it arrives, without its
   * newline. Lines that arrived in the same chunk as STDIO_READY_LINE are
   * dispatched before the spawn promise's continuation runs, so a
   * subscriber attached right after `await` may miss them live — they are
   * always in `recentStderr()`.
   */
  onStderr(cb: (line: string) => void): Unsubscribe;
  /** The last STDERR_RING_SIZE stderr lines, oldest first. */
  recentStderr(): readonly string[];
}

interface LineSplitter {
  push(chunk: string): void;
  flush(): void;
}

/**
 * Turns a stream of utf8 chunks into complete lines. A chunk boundary can
 * fall anywhere — in the middle of STDIO_READY_LINE included — so the
 * partial tail is held until its newline arrives, and `flush()` releases
 * whatever is left when the stream ends so a final unterminated log line
 * is not lost.
 */
function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  let partial = '';
  return {
    push(chunk) {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      lines.forEach((line) => {
        onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      });
    },
    flush() {
      if (partial.length === 0) return;
      const line = partial;
      partial = '';
      onLine(line);
    },
  };
}

interface StderrRing {
  push(line: string): void;
  snapshot(): readonly string[];
}

/** Fixed-capacity FIFO of the most recent lines. */
function createStderrRing(capacity: number): StderrRing {
  const lines: string[] = [];
  return {
    push(line) {
      lines.push(line);
      if (lines.length > capacity) lines.splice(0, lines.length - capacity);
    },
    snapshot() {
      return [...lines];
    },
  };
}

/**
 * SIGTERM now, SIGKILL after `graceMs` if the child is still around. See
 * STDIO_TERM_GRACE_MS for why both, and why the escalation. The timer is
 * unref'd: if the process is on its way out anyway, the child dying with
 * the pipes is fine and this must not be what keeps Electron alive.
 */
function terminate(child: ChildProcess, graceMs: number): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const escalate = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, graceMs);
  escalate.unref();
  child.once('exit', () => clearTimeout(escalate));
}

// ---- Phase 2: a listening daemon ------------------------------------------

function attach(
  child: ChildProcess,
  termGraceMs: number,
  stderrLines: StderrRing,
  stderrListeners: Set<(line: string) => void>,
  lineSplitter: LineSplitter,
): StdioEngineTransport {
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const closeListeners = new Set<
    (reason: EngineTransportCloseReason) => void
  >();
  let writable = true;
  let closeFired = false;

  const fireClose = (reason: EngineTransportCloseReason) => {
    writable = false;
    if (closeFired) return;
    closeFired = true;
    closeListeners.forEach((cb) => cb(reason));
    closeListeners.clear();
    dataListeners.clear();
    stderrListeners.clear();
  };

  // stdout is the Wire byte stream. No encoding: chunks arrive as Buffers,
  // which are Uint8Arrays, and each is its own allocation — zero-copy
  // pass-through, as in socket.ts.
  child.stdout?.on('data', (chunk: Buffer) => {
    dataListeners.forEach((cb) => cb(chunk));
  });

  child.on('error', (err: Error) => {
    fireClose({ kind: 'error', message: err.message });
  });

  // 'close', not 'exit': it fires only after the stdio streams have
  // drained, so every stdout 'data' event — including a final Wire result
  // the daemon flushed on its way out — has been delivered before anyone
  // is told the pipe is gone.
  child.on('close', (code, signal) => {
    lineSplitter.flush();
    fireClose({ kind: 'child-exited', code, signal });
  });

  return {
    mode: 'stdio',
    // Only a spawned child can have written STDIO_READY_LINE, and attach()
    // runs only after that line — so by construction `pid` is set here.
    pid: child.pid as number,

    send(bytes: Uint8Array): void {
      if (!writable || !child.stdin || child.stdin.destroyed) {
        throw new Error('engine stdio transport is closed');
      }
      child.stdin.write(bytes);
    },

    onData(cb): Unsubscribe {
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },

    onClose(cb): Unsubscribe {
      closeListeners.add(cb);
      return () => {
        closeListeners.delete(cb);
      };
    },

    onStderr(cb): Unsubscribe {
      stderrListeners.add(cb);
      return () => {
        stderrListeners.delete(cb);
      };
    },

    recentStderr(): readonly string[] {
      return stderrLines.snapshot();
    },

    close(): void {
      if (!writable) return;
      writable = false;
      terminate(child, termGraceMs);
    },
  };
}

// ---- Phase 1: spawn, then wait for the readiness line ---------------------

/**
 * Spawns `<launcher> serve --stdio` and resolves with a transport once the
 * daemon has written STDIO_READY_LINE. Rejects — with the child's last
 * stderr lines in the message, because that is where the reason will be —
 * if the child exits or errors first, or if the line does not arrive
 * within `readyTimeoutMs`; in the timeout case the child is terminated the
 * same way `close()` would terminate it, so a slow daemon does not outlive
 * the promise that gave up on it.
 *
 * `onClose` fires exactly once, as `child-exited` with the child's exit
 * code and signal — after our own `close()` too, where the values say how
 * the child went (code 143 when the daemon's SIGTERM handler ran to
 * completion, signal `SIGKILL` when it did not); the caller knows whether
 * it asked. The contract's `error` kind is used only for the rare
 * post-spawn `error` event Node raises when the child could not be
 * signalled.
 */
export function spawnStdioTransport(
  launcherPath: string,
  options: StdioTransportOptions,
): Promise<StdioEngineTransport> {
  const readyTimeoutMs = options.readyTimeoutMs ?? STDIO_READY_TIMEOUT_MS;
  const termGraceMs = options.termGraceMs ?? STDIO_TERM_GRACE_MS;
  const args = ['serve', '--stdio', ...(options.extraArgs ?? [])];

  return new Promise<StdioEngineTransport>((resolve, reject) => {
    const child = spawn(launcherPath, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderrLines = createStderrRing(STDERR_RING_SIZE);
    const stderrListeners = new Set<(line: string) => void>();
    const emitStderrLine = (line: string) => {
      stderrLines.push(line);
      stderrListeners.forEach((cb) => cb(line));
    };
    const lineSplitter = createLineSplitter(emitStderrLine);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => lineSplitter.push(chunk));
    // A stream-level error (EPIPE and friends) must not become an
    // unhandled 'error' event of its own; the child's own 'error'/'close'
    // carry the story — same defense copilotDetect.ts applies.
    child.stderr.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stdin.on('error', () => {});

    let settled = false;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;

    const describeTail = () => {
      const tail = stderrLines.snapshot();
      return tail.length === 0
        ? ' (no stderr output)'
        : `; last stderr:\n${tail.slice(-20).join('\n')}`;
    };

    const failEarly = (message: string) => {
      if (settled) return;
      settled = true;
      if (readyTimer) clearTimeout(readyTimer);
      reject(new Error(message));
    };

    const onEarlyError = (err: Error) => {
      failEarly(
        `could not spawn engine launcher ${launcherPath}: ${err.message}`,
      );
    };
    const onEarlyClose = (code: number | null, signal: string | null) => {
      // A dying child's last words need not end in a newline.
      lineSplitter.flush();
      failEarly(
        `engine exited before it was listening (code ${code}, signal ${signal})${describeTail()}`,
      );
    };
    child.once('error', onEarlyError);
    child.once('close', onEarlyClose);

    readyTimer = setTimeout(() => {
      // Whatever the child is doing, it is not going to be our engine.
      // Terminate it the way close() would so it cannot linger holding
      // the pipes (and the loop) open after this promise has rejected.
      terminate(child, termGraceMs);
      failEarly(
        `engine did not report "${STDIO_READY_LINE}" within ${readyTimeoutMs}ms${describeTail()}`,
      );
    }, readyTimeoutMs);

    const onReadyLine = (line: string) => {
      if (settled || line !== STDIO_READY_LINE) return;
      settled = true;
      if (readyTimer) clearTimeout(readyTimer);
      stderrListeners.delete(onReadyLine);
      child.off('error', onEarlyError);
      child.off('close', onEarlyClose);
      resolve(
        attach(child, termGraceMs, stderrLines, stderrListeners, lineSplitter),
      );
    };
    stderrListeners.add(onReadyLine);
  });
}
