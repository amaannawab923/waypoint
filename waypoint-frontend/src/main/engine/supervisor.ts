import {
  CLIENT_PROTOCOL_VERSION,
  ENGINE_PIN,
  EngineCallError,
  type EngineHealth,
  type EngineInitializeError,
  type EngineInitializeInput,
  type EngineInitializeResult,
  type EnginePaths,
  type EngineStatus,
  type EngineTransport,
  type EngineTransportCloseReason,
  type Unsubscribe,
  type WireClient,
} from './types';
import type { EngineInstallResult } from './installer';
import type { DaemonCommandFailure } from './daemonCli';

// ROAD-48: the engine supervisor. Owns the one EngineStatus this process
// believes, and is the only thing allowed to change it — every transition
// below is a reaction to something actually observed (a CLI command
// resolving or throwing, a socket connecting or refusing, the daemon's own
// `initialize`/`health` answers, a transport closing), never a guess. That
// is the same posture `types.ts`'s own EngineStatus comment describes and
// the same one `jiraIpc.ts` and MachinePage's Claude CLI probe already hold
// elsewhere in this app.
//
// Fully dependency-injected (see `EngineSupervisorDeps` below) rather than
// reaching for `./wire`, `./transport`, `./installer` or `./daemonCli`
// itself, on purpose: this file has to be unit-testable with fakes, and a
// direct import would mean every test either touches a real socket/process
// or fights a module mock. `engineIpc.ts` is where the real implementations
// get wired together for the running app; this file never needs to import
// them as values (only `RunDaemonCommand`'s type below reaches into
// `./daemonCli`, via a `typeof import(...)` query rather than a value
// import, purely to stay exactly in sync with its real signature).
//
// One deliberate departure from this task's own dependency list: the task
// named a `fs` dependency for install() to check `launcherPath` and read
// `manifest.json` itself. By the time this file was written, `./installer.ts`
// (ROAD-47, the lead's) had already landed with `verifyInstalledEngine`,
// which does exactly that check — including the manifest's `os`/`arch`
// fields this supervisor would otherwise have had no reason to also
// validate. Re-implementing the same manifest read here would mean two
// places that can disagree about what "installed" means; depending on the
// lead's own verified function instead (injected, for the same testability
// reason as everything else in `deps`) keeps there being exactly one. See
// this file's own report for this substitution called out explicitly.

/**
 * Mirrors `runDaemonCommand` from `./daemonCli` (ROAD-49/50, already landed
 * by the time this file was written) via a `typeof import(...)` type query
 * rather than a value import — same DI-for-testability reasoning as every
 * other alias in this section (see the header above), but expressed as a
 * live reference to the real function's type instead of a hand-copied
 * signature, so this can never drift from what `daemonCli.ts` actually
 * exports.
 *
 * The real contract is a Result, not throw/resolve: `runDaemonCommand`
 * "resolves always" (its own doc comment) with `{ ok: true, value, stdout,
 * stderr }` or `{ ok: false, failure, stdout, stderr }` — `value` is
 * `{ status: 'started' | 'already-running' }` for `start` and
 * `{ status: 'stopped' | 'not-running' }` for `stop`, both success. This
 * supervisor still wraps each call in try/catch below as a defense-in-depth
 * backstop (an unhandled rejection here would be an unhandled rejection in
 * Waypoint's main process), not because the documented contract expects one.
 */
export type RunDaemonCommand = typeof import('./daemonCli').runDaemonCommand;

/** Mirrors `connectSocketTransport` from `./transport` (ROAD-50, already
 *  landed — see this file's header for why this is still a local type
 *  rather than an import: DI for testability, not a missing-module dodge). */
export type ConnectSocketTransport = (
  socketPath: string,
) => Promise<EngineTransport>;

/** Mirrors `createWireClient` from `./wire` (ROAD-49, already landed). */
export type CreateWireClient = (transport: EngineTransport) => WireClient;

/** Mirrors `verifyInstalledEngine` from `./installer` (ROAD-47, already
 *  landed) — see this file's header for why install() delegates to it
 *  instead of re-reading `manifest.json` itself. */
export type VerifyInstalledEngine = (
  paths: EnginePaths,
) => Promise<EngineInstallResult>;

export type EngineClock = () => number;

export interface EngineLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface EngineSupervisorDeps {
  paths: EnginePaths;
  runDaemonCommand: RunDaemonCommand;
  connectSocketTransport: ConnectSocketTransport;
  createWireClient: CreateWireClient;
  verifyInstalledEngine: VerifyInstalledEngine;
  /**
   * Extracts the bundled archive when `install()` finds nothing usable —
   * `installEngine` from `./installer`, injected so the supervisor's own
   * tests stay free of tar and 62 MB archives (installer.test.ts covers
   * that with a real fixture). Optional only so a test that is not about
   * installation can omit it; production always supplies it.
   */
  installEngine?: () => Promise<EngineInstallResult>;
  /** Deletes a leftover `<socket>.lock` before `start` — see start(). */
  removeStaleStartLock?: (lockPath: string) => Promise<void>;
  /** Waypoint's own version, sent to the daemon in `initialize.client`. */
  appVersion: string;
  clock: EngineClock;
  logger: EngineLogger;
}

export interface EngineSupervisor {
  /** Whatever this supervisor currently believes, from the last real
   *  observation — never a fresh check. Synchronous and never throws,
   *  matching `ENGINE_IPC.status`'s own contract in `types.ts`. */
  getStatus(): EngineStatus;
  /** Verifies an already-extracted install against the pin. Never triggers
   *  extraction itself (ROAD-47, the lead's) — see this file's header. */
  install(): Promise<EngineStatus>;
  start(): Promise<EngineStatus>;
  stop(): Promise<EngineStatus>;
  /** A fresh `health` call on the live connection, or `null` when there is
   *  none to ask — matching `ENGINE_IPC.health`'s own contract. */
  health(): Promise<EngineHealth | null>;
  /** Fires on every status *change*, in subscriber order — not on
   *  subscribe, so a caller that wants the current value calls getStatus()
   *  first (MachinePage does exactly that on mount). */
  onStatusChange(cb: (status: EngineStatus) => void): Unsubscribe;
  /** Tears down any live connection and stops notifying listeners. Does not
   *  stop the daemon process itself — that is stop()'s job, and dispose()
   *  is for when Waypoint itself is going away, not when the engine should. */
  dispose(): void;
}

function errorMessage(error: unknown): string {
  if (error instanceof EngineCallError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function isLiveOrTransitioning(status: EngineStatus): boolean {
  return (
    status.kind === 'running' ||
    status.kind === 'starting' ||
    status.kind === 'stopping'
  );
}

function describeCloseReason(reason: EngineTransportCloseReason): string {
  switch (reason.kind) {
    case 'closed-by-us':
      return 'The connection to the engine was closed.';
    case 'peer-closed':
      return 'The engine closed the connection.';
    case 'error':
      return `The connection to the engine failed: ${reason.message}`;
    case 'child-exited':
      return `The engine process exited (code ${reason.code ?? 'unknown'}${
        reason.signal ? `, signal ${reason.signal}` : ''
      }).`;
    default: {
      // Exhaustiveness guard: EngineTransportCloseReason is a closed union
      // owned by types.ts, which this file may not edit — a new variant
      // there fails this line to compile rather than silently falling
      // through to a message that doesn't name what actually happened.
      const exhaustive: never = reason;
      return `The connection to the engine was lost (${JSON.stringify(exhaustive)}).`;
    }
  }
}

/** Turns one `daemonCli.ts` command failure into the sentence a `failed`
 *  status shows. `daemon-error` and `launcher` already carry a message
 *  written for exactly this; `timeout` and `unrecognized-output` do not, so
 *  this is where those become one. */
function describeDaemonFailure(failure: DaemonCommandFailure): string {
  switch (failure.kind) {
    case 'launcher':
      return failure.message;
    case 'timeout':
      return `The engine command did not finish within ${failure.timeoutMs}ms.`;
    case 'daemon-error':
      return failure.message;
    case 'unrecognized-output':
      return `The engine printed output this app does not recognize (exit code ${
        failure.code ?? 'unknown'
      }).`;
    default: {
      // Exhaustiveness guard, same reasoning as describeCloseReason above —
      // DaemonCommandFailure is daemonCli.ts's closed union.
      const exhaustive: never = failure;
      return `Unknown engine command failure: ${JSON.stringify(exhaustive)}`;
    }
  }
}

export function createEngineSupervisor(
  deps: EngineSupervisorDeps,
): EngineSupervisor {
  // The provisional starting point, before this process has ever actually
  // looked — see this file's own report for why "not-installed" here is a
  // placeholder rather than a claim: nothing has observed the filesystem
  // yet, so nothing renders this value directly (MachinePage shows a
  // loading skeleton until install() answers for real, the same way it
  // already treats the Claude CLI probe).
  let status: EngineStatus = {
    kind: 'not-installed',
    installDir: deps.paths.installDir,
  };
  let client: WireClient | null = null;
  let disconnectUnsubscribe: Unsubscribe | null = null;
  // The version install() last actually verified against ENGINE_PIN — kept
  // separately from `status` so a later `stopped`/`running` status (built
  // after a start()/stop() that doesn't re-verify) can still report the
  // real, observed version rather than assuming today's ENGINE_PIN.version
  // is what's on disk.
  let installedVersion: string | null = null;
  const listeners = new Set<(status: EngineStatus) => void>();

  function setStatus(next: EngineStatus): void {
    status = next;
    if (next.kind === 'failed') {
      deps.logger.error(`engine: ${next.stage} failed`, {
        message: next.message,
      });
    } else {
      deps.logger.info(`engine: ${next.kind}`);
    }
    // A snapshot, not the live Set: a listener that subscribes or
    // unsubscribes another mid-notification must not perturb this pass.
    [...listeners].forEach((listener) => listener(next));
  }

  function failedStatus(
    stage: 'install' | 'start' | 'connect' | 'initialize' | 'health' | 'stop',
    messageOrError: unknown,
  ): EngineStatus {
    const message =
      typeof messageOrError === 'string'
        ? messageOrError
        : errorMessage(messageOrError);
    return { kind: 'failed', since: deps.clock(), stage, message };
  }

  /** Closes and forgets the live client without touching `status` — callers
   *  decide what status follows. Idempotent, so stop() and dispose() can
   *  both call it unconditionally. */
  function teardownClient(): void {
    disconnectUnsubscribe?.();
    disconnectUnsubscribe = null;
    const current = client;
    client = null;
    current?.close();
  }

  async function install(): Promise<EngineStatus> {
    // A live connection or an in-flight start/stop is a stronger fact than
    // a disk read — a second install() call (MachinePage remounting, a
    // periodic refresh) must never clobber 'running' with a stale
    // "well, the files are there" claim. See this file's own report for the
    // review finding this guards: without it, calling install() again while
    // already running was a real path to a false "stopped" status.
    if (isLiveOrTransitioning(status)) return status;

    let result: EngineInstallResult;
    try {
      result = await deps.verifyInstalledEngine(deps.paths);
      // Nothing usable on disk and we know how to put it there: extract the
      // bundled archive (installer.ts — sha256 before, manifest after).
      // Only for a plain absence or a broken install; a `sha256-mismatch`
      // or `unsupported-platform` from the installer is a fact to show,
      // not a reason to try again.
      if (!result.ok && deps.installEngine) {
        result = await deps.installEngine();
      }
    } catch (error) {
      installedVersion = null;
      setStatus(failedStatus('install', error));
      return status;
    }

    if (!result.ok) {
      installedVersion = null;
      if (result.reason === 'extract-failed' && !deps.installEngine) {
        // Without an installer wired in, installer.ts's
        // verifyInstalledEngine answers this reason only when
        // `paths.launcherPath` does not exist — i.e. nothing here yet.
        setStatus({ kind: 'not-installed', installDir: deps.paths.installDir });
      } else if (result.reason === 'archive-missing') {
        // The installer looked and found no archive to extract. That is the
        // developer-machine case (`npm run engine:fetch` not run) and is
        // exactly what not-installed means to a user.
        setStatus({ kind: 'not-installed', installDir: deps.paths.installDir });
      } else {
        setStatus(failedStatus('install', result.message));
      }
      return status;
    }

    installedVersion = result.manifest.version;
    setStatus({
      kind: 'stopped',
      installDir: deps.paths.installDir,
      version: result.manifest.version,
    });
    return status;
  }

  async function start(): Promise<EngineStatus> {
    // Idempotent: a start already in flight is not re-attempted, and a
    // start while stopping is racing is refused rather than interleaved
    // with it — a caller that wants to restart waits for stop() to settle.
    if (isLiveOrTransitioning(status)) return status;

    setStatus({ kind: 'starting', since: deps.clock() });

    // Found live (ROAD-50's read of emdash `daemon/lock.ts:23-53`): `start`
    // takes `<socket>.lock` and only releases it in a `finally` — a `start`
    // killed mid-flight (Waypoint quit, a crash) leaves the file behind, and
    // the lock has no liveness check, so every later `start` fails with a
    // 5 s `lock` error until someone deletes it. We are that someone: no
    // start of ours is in flight here (the guard above), and a daemon that
    // is genuinely running does not need the lock to keep running — the
    // lock only serialises *starts*. So a leftover lock is always stale
    // from this vantage point, and removing it is safe.
    await deps.removeStaleStartLock?.(`${deps.paths.socketPath}.lock`);

    try {
      const startResult = await deps.runDaemonCommand(
        deps.paths.launcherPath,
        'start',
        {
          socketPath: deps.paths.socketPath,
          // The daemon reads a `.env` in its cwd for `EMDASH_WS_*` overrides
          // (emdash `config.ts:6`); Electron main's cwd is wherever the app
          // was launched from. Pin it to the install so nothing outside
          // Waypoint's own directory can reconfigure the engine.
          cwd: deps.paths.installDir,
        },
      );
      if (!startResult.ok) {
        setStatus(
          failedStatus('start', describeDaemonFailure(startResult.failure)),
        );
        return status;
      }
      // `started` (we spawned it) and `already-running` (the CLI's own
      // probe found one) are both success — see DaemonStartOutcome's own
      // comment in daemonCli.ts.
    } catch (error) {
      // Defense in depth: runDaemonCommand's documented contract "resolves
      // always" (daemonCli.ts's own comment), so this branch is not
      // expected to run against the real implementation. It exists so a
      // contract violation here becomes an honest 'failed' status instead
      // of an unhandled rejection in Waypoint's main process.
      setStatus(failedStatus('start', error));
      return status;
    }

    let transport: EngineTransport;
    try {
      transport = await deps.connectSocketTransport(deps.paths.socketPath);
    } catch (error) {
      setStatus(failedStatus('connect', error));
      return status;
    }

    let newClient: WireClient;
    try {
      newClient = deps.createWireClient(transport);
    } catch (error) {
      transport.close();
      setStatus(failedStatus('connect', error));
      return status;
    }

    // The handshake, exactly as the pinned daemon answered it live (see
    // EngineInitializeInput / EngineInitializeResult in types.ts): the
    // `client` object is required — without it the daemon rejects the call
    // with HANDLER_ERROR — and because `initialize` is a *fallible*
    // procedure its answer is a `{ success, data | error }` envelope inside
    // the transport-level `ok: true` result, not `ok`/`value` again. The
    // first draft of this function read `.ok` on that envelope and would
    // have called every handshake a failure.
    const hello: EngineInitializeInput = {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      client: { id: 'waypoint', appVersion: deps.appVersion },
    };
    let initResult: EngineInitializeResult;
    try {
      initResult = await newClient.call<EngineInitializeResult>('initialize', hello);
    } catch (error) {
      newClient.close();
      setStatus(failedStatus('initialize', error));
      return status;
    }

    if (!initResult.success) {
      newClient.close();
      // Upgrade, don't retry — types.ts's own EngineStatus comment on
      // `incompatible`. A major bump on the daemon side is a deliberate
      // upgrade, never a float (types.ts §4's note on CLIENT_PROTOCOL_VERSION),
      // so nothing here schedules a retry of the same mismatched call.
      setStatus({
        kind: 'failed',
        since: deps.clock(),
        stage: 'initialize',
        message: `This engine speaks protocol ${initResult.error.serverProtocolVersion}; Waypoint speaks ${initResult.error.clientProtocolVersion}.`,
        incompatible: initResult.error,
      });
      return status;
    }

    let startupHealth: EngineHealth;
    try {
      startupHealth = await newClient.call<EngineHealth>('health');
    } catch (error) {
      newClient.close();
      setStatus(failedStatus('health', error));
      return status;
    }

    client = newClient;
    disconnectUnsubscribe = client.onDisconnect((reason) => {
      // Only meaningful once we are actually 'running' — a disconnect
      // during the handshake above already surfaced through whichever
      // call() was in flight (WireClient rejects every pending call on
      // close), so this guard exists purely to avoid a second, redundant
      // transition racing that one.
      if (status.kind !== 'running') return;
      teardownClient();
      setStatus({
        kind: 'failed',
        since: deps.clock(),
        stage: 'health',
        message: describeCloseReason(reason),
      });
    });

    setStatus({
      kind: 'running',
      since: deps.clock(),
      health: startupHealth,
      agreed: initResult.data,
      transport: transport.mode,
    });
    return status;
  }

  async function stop(): Promise<EngineStatus> {
    if (
      status.kind === 'not-installed' ||
      status.kind === 'stopped' ||
      status.kind === 'stopping'
    ) {
      return status;
    }

    setStatus({ kind: 'stopping', since: deps.clock() });
    // Torn down before the CLI call, not after: this stops us reacting to
    // our own connection's disconnect once the daemon actually exits,
    // which would otherwise race this function's own 'stopped' transition
    // below and could overwrite it with a spurious 'failed'.
    teardownClient();

    try {
      const stopResult = await deps.runDaemonCommand(
        deps.paths.launcherPath,
        'stop',
        {
          socketPath: deps.paths.socketPath,
        },
      );
      if (!stopResult.ok) {
        setStatus(
          failedStatus('stop', describeDaemonFailure(stopResult.failure)),
        );
        return status;
      }
      // `stopped` (we ended a live pid) and `not-running` (no pid was ever
      // there) are both success — not-running is not an error here, it is
      // "the daemon is stopped", which is what was asked.
    } catch (error) {
      // Same defense-in-depth reasoning as start()'s own catch above.
      setStatus(failedStatus('stop', error));
      return status;
    }

    setStatus({
      kind: 'stopped',
      installDir: deps.paths.installDir,
      version: installedVersion ?? ENGINE_PIN.version,
    });
    return status;
  }

  async function health(): Promise<EngineHealth | null> {
    if (!client) return null;
    try {
      return await client.call<EngineHealth>('health');
    } catch (error) {
      teardownClient();
      setStatus(failedStatus('health', error));
      return null;
    }
  }

  function getStatus(): EngineStatus {
    return status;
  }

  function onStatusChange(cb: (status: EngineStatus) => void): Unsubscribe {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function dispose(): void {
    teardownClient();
    listeners.clear();
  }

  return { getStatus, install, start, stop, health, onStatusChange, dispose };
}
