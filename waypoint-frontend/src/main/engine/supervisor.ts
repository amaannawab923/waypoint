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
  /**
   * Looks and reports: verifies the install on disk (extracting the
   * bundled archive if nothing usable is there — that can write 62 MB and
   * run `tar`), then probes the socket. Ends in `stopped`, `running` (a
   * daemon from before, attached to), `not-installed`, or `failed`. See
   * install() itself for why the socket probe is not optional.
   */
  install(): Promise<EngineStatus>;
  start(): Promise<EngineStatus>;
  stop(): Promise<EngineStatus>;
  /** A fresh `health` call on the live connection, or `null` when there is
   *  none to ask — matching `ENGINE_IPC.health`'s own contract. */
  health(): Promise<EngineHealth | null>;
  /**
   * The live Wire client while `running`, else `null`. For the run
   * modules (`runs/`) that speak to the daemon's workspace registry and
   * ACP runtime on Waypoint's behalf. Never hold it across an await: the
   * daemon can go away between two calls, so a caller re-asks each time.
   */
  client(): WireClient | null;
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
    stage: Extract<EngineStatus, { kind: 'failed' }>['stage'],
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

  // A generation counter — found in review (M3). Every user-initiated
  // transition (install/start/stop/dispose) bumps it, and every `await`
  // inside start()/install() re-checks it afterwards: if the world moved on
  // while we were waiting (a Stop click during a 5 s `start`, dispose()
  // mid-handshake), the stale continuation abandons rather than writing a
  // status the user did not ask for. Without it, Start-then-Stop ended in
  // "Failed" for a daemon the user had just stopped, and dispose() could
  // leave a completed handshake holding a live socket.
  let generation = 0;
  const bump = (): number => {
    generation += 1;
    return generation;
  };
  const stale = (gen: number): boolean => gen !== generation;

  /**
   * Connect to a daemon that is already serving on the socket and complete
   * the handshake — the part of "start" that is also the whole of
   * "re-attach to a daemon that outlived the last Waypoint". Shared by
   * start() and install() so the two cannot drift. Returns the status it
   * observed; sets it unless the generation moved.
   */
  async function attach(
    gen: number,
    failStage: 'connect' | 'initialize' | 'health',
  ): Promise<EngineStatus> {
    let transport: EngineTransport;
    try {
      transport = await deps.connectSocketTransport(deps.paths.socketPath);
    } catch (error) {
      if (stale(gen)) return status;
      setStatus(failedStatus('connect', error));
      return status;
    }
    if (stale(gen)) {
      transport.close();
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
      initResult = await newClient.call<EngineInitializeResult>(
        'initialize',
        hello,
      );
    } catch (error) {
      newClient.close();
      if (stale(gen)) return status;
      setStatus(failedStatus('initialize', error));
      return status;
    }
    if (stale(gen)) {
      newClient.close();
      return status;
    }

    if (!initResult.success) {
      newClient.close();
      // Upgrade, don't retry — types.ts's own EngineStatus comment on
      // `incompatible`. A major bump on the daemon side is a deliberate
      // upgrade, never a float (types.ts §1's note on CLIENT_PROTOCOL_VERSION),
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
      if (stale(gen)) return status;
      setStatus(
        failedStatus(failStage === 'connect' ? 'health' : failStage, error),
      );
      return status;
    }
    if (stale(gen)) {
      newClient.close();
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

  /**
   * Looks — at the disk AND at the socket — and reports what it found.
   *
   * The first draft reported `stopped` from the files alone. Found in
   * review (M1): that fabricates "not running" in the one scenario this
   * architecture exists for — a daemon that outlived the last Waypoint and
   * is still serving when the next one launches — and it also silently
   * replaced a `failed` status with `stopped` on every MachinePage remount.
   * `stopped` now means what types.ts says it means: the daemon's own
   * `status` command said not-running. A daemon found serving is attached
   * to, so the card shows `running` for a daemon that is running.
   */
  // One look at a time. Two callers that ask "what is on disk and on the
  // socket?" while the first look is still in flight (MachinePage mounting
  // while start() is doing its own pre-flight look, a double-click on
  // Install) want the same answer, and running the look twice would make
  // the first caller's continuation stale and hand it a status it never
  // observed. They share the promise instead.
  let inflightLook: Promise<EngineStatus> | null = null;

  async function install(): Promise<EngineStatus> {
    // A live connection or an in-flight start/stop is a stronger fact than
    // a fresh look — a second install() call (MachinePage remounting, a
    // periodic refresh) must never clobber 'running' or interrupt a
    // transition.
    if (isLiveOrTransitioning(status)) return status;
    if (inflightLook) return inflightLook;
    inflightLook = look().finally(() => {
      inflightLook = null;
    });
    return inflightLook;
  }

  async function look(): Promise<EngineStatus> {
    const gen = bump();

    let result: EngineInstallResult;
    try {
      result = await deps.verifyInstalledEngine(deps.paths);
      // Nothing usable on disk and we know how to put it there: extract the
      // bundled archive (installer.ts — sha256 before, manifest after).
      // installEngine() itself decides which refusals are final
      // (`sha256-mismatch`, `unsupported-platform`) and which are worth an
      // extraction attempt; it never re-extracts over a valid install.
      if (!result.ok && deps.installEngine) {
        result = await deps.installEngine();
      }
    } catch (error) {
      if (stale(gen)) return status;
      installedVersion = null;
      setStatus(failedStatus('install', error));
      return status;
    }
    if (stale(gen)) return status;

    if (!result.ok) {
      installedVersion = null;
      if (
        result.reason === 'archive-missing' ||
        (result.reason === 'extract-failed' && !deps.installEngine)
      ) {
        // Nothing to run and nothing to extract it from: on a developer
        // machine, `npm run engine:fetch` has not been run. That is exactly
        // what not-installed means to a user.
        setStatus({ kind: 'not-installed', installDir: deps.paths.installDir });
      } else {
        setStatus(failedStatus('install', result.message));
      }
      return status;
    }
    installedVersion = result.manifest.version;

    // The files are right. Now the socket: is a daemon already serving?
    let probe;
    try {
      probe = await deps.runDaemonCommand(deps.paths.launcherPath, 'status', {
        socketPath: deps.paths.socketPath,
        cwd: deps.paths.installDir,
      });
    } catch (error) {
      if (stale(gen)) return status;
      setStatus(failedStatus('health', error));
      return status;
    }
    if (stale(gen)) return status;

    if (!probe.ok) {
      setStatus(failedStatus('health', describeDaemonFailure(probe.failure)));
      return status;
    }
    if (probe.value.running) {
      // A daemon from before — the restart-survival case. Attach to it
      // rather than telling the user it is stopped.
      setStatus({ kind: 'starting', since: deps.clock() });
      return attach(gen, 'connect');
    }
    if (probe.value.reason === 'unhealthy') {
      // Something answers the socket but not `health`. That is a fact to
      // show, not "stopped": the daemon's own `start` refuses to replace it
      // (ROAD-50's read of start.ts:60-65), so a Start click would fail
      // too, and the user needs to know which.
      setStatus(failedStatus('health', probe.value.message));
      return status;
    }
    setStatus({
      kind: 'stopped',
      installDir: deps.paths.installDir,
      version: installedVersion,
    });
    return status;
  }

  async function start(): Promise<EngineStatus> {
    // Idempotent: a start already in flight is not re-attempted, and a
    // start while stopping is racing is refused rather than interleaved
    // with it — a caller that wants to restart waits for stop() to settle.
    if (isLiveOrTransitioning(status)) return status;

    // Never start what has not been looked at. install() verifies the
    // files and probes the socket; if a daemon is already serving it
    // attaches and we are done, and if the install is broken we get the
    // honest failure instead of a `start` CLI error about a missing
    // launcher. (Found in review, L6: start() from the never-observed
    // placeholder used to reach the CLI.)
    if (installedVersion === null || status.kind !== 'stopped') {
      const looked = await install();
      if (looked.kind !== 'stopped') return looked;
      // Two start() calls can share one look (see install()); the first to
      // resume past it owns the start, the other sees 'starting' here.
      if (isLiveOrTransitioning(status)) return status;
    }
    const gen = bump();

    setStatus({ kind: 'starting', since: deps.clock() });

    // Found live (ROAD-50's read of emdash `daemon/lock.ts:23-53`): `start`
    // takes `<socket>.lock` and only releases it in a `finally` — a `start`
    // killed mid-flight (Waypoint quit, a crash) leaves the file behind, and
    // the lock has no liveness check, so every later `start` fails with a
    // 5 s `lock` error until someone deletes it. We are that someone —
    // but only now that install() has just observed `not-running` on the
    // socket: a lock left by a daemon that IS running is not stale, and a
    // second Waypoint instance's in-flight start (main.ts holds no
    // single-instance lock — a known gap, see the commit) would be the one
    // case this still gets wrong.
    await deps.removeStaleStartLock?.(`${deps.paths.socketPath}.lock`);
    if (stale(gen)) return status;

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
      if (stale(gen)) return status;
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
      if (stale(gen)) return status;
      setStatus(failedStatus('start', error));
      return status;
    }

    return attach(gen, 'connect');
  }

  async function stop(): Promise<EngineStatus> {
    if (
      status.kind === 'stopping' ||
      status.kind === 'stopped' ||
      status.kind === 'not-installed'
    ) {
      return status;
    }
    const gen = bump();

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
          cwd: deps.paths.installDir,
        },
      );
      if (stale(gen)) return status;
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
      if (stale(gen)) return status;
      setStatus(failedStatus('stop', error));
      return status;
    }

    if (installedVersion === null) {
      // Stopped a daemon we never verified the files for (raw IPC before
      // any install()). Rather than report a version we assumed, look.
      setStatus({ kind: 'not-installed', installDir: deps.paths.installDir });
      return install();
    }
    setStatus({
      kind: 'stopped',
      installDir: deps.paths.installDir,
      version: installedVersion,
    });
    return status;
  }

  async function health(): Promise<EngineHealth | null> {
    if (!client) return null;
    try {
      return await client.call<EngineHealth>('health');
    } catch (error) {
      // Found in review (L5): a `health` already in flight when stop()
      // tears the client down rejects DISCONNECTED and used to push a
      // spurious `failed` in front of the `stopped` that followed. Only a
      // running engine that stops answering is a failure.
      if (status.kind !== 'running') return null;
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
    bump();
    teardownClient();
    listeners.clear();
  }

  return {
    getStatus,
    install,
    start,
    stop,
    health,
    client: () => (status.kind === 'running' ? client : null),
    onStatusChange,
    dispose,
  };
}
