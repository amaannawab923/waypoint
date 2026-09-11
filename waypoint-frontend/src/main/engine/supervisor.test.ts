import type {
  EngineHealth,
  EngineInitializeError,
  EngineInitializeOk,
  EnginePaths,
  EngineTransport,
  EngineTransportCloseReason,
  WireClient,
} from './types';
import type { EngineInstallResult } from './installer';
import type {
  DaemonCommandFailure,
  DaemonCommandResult,
  DaemonManagementCommand,
  DaemonStatusOutcome,
  RunDaemonCommandOptions,
} from './daemonCli';
import {
  createEngineSupervisor,
  type ConnectSocketTransport,
  type CreateWireClient,
  type EngineSupervisorDeps,
  type RunDaemonCommand,
  type VerifyInstalledEngine,
} from './supervisor';

const PATHS: EnginePaths = {
  installDir: '/userdata/engine/0.1.0',
  launcherPath:
    '/userdata/engine/0.1.0/emdash-workspace-server/bin/emdash-workspace-server',
  runDir: '/userdata/engine/run',
  socketPath: '/userdata/engine/run/workspace.sock',
  stateDir: '/userdata/engine/state',
  worktreesDir: '/userdata/engine/worktrees',
  logPath: '/userdata/engine/engine.log',
};

const HEALTH: EngineHealth = {
  status: 'ok',
  version: '0.1.0',
  uptimeMs: 42,
  protocolVersion: '1.0.0',
};

const AGREED: EngineInitializeOk = {
  protocolVersion: '1.0.0',
  agreedVersion: '1.0.0',
  agreedMinor: 0,
  server: { appVersion: '0.1.0', daemonId: 'daemon-1', startedAt: 1000 },
};

function installedResult(version = '0.1.0'): EngineInstallResult {
  return {
    ok: true,
    installDir: PATHS.installDir,
    manifest: {
      name: 'emdash-workspace-server',
      version,
      protocolVersion: '1.0.0',
      os: 'darwin',
      arch: 'arm64',
      nodeVersion: '22.0.0',
      ripgrepVersion: '14.0.0',
    },
  };
}

function notInstalledResult(): EngineInstallResult {
  return {
    ok: false,
    reason: 'extract-failed',
    message: `No engine launcher at ${PATHS.launcherPath}.`,
  };
}

function mismatchResult(
  message = 'Installed engine does not match the pin.',
): EngineInstallResult {
  return { ok: false, reason: 'manifest-mismatch', message };
}

// runDaemonCommand's real contract (daemonCli.ts) "resolves always" with a
// Result, never rejects — see supervisor.ts's own RunDaemonCommand comment.
// These build the shapes it actually produces, rather than a rejected
// Promise, so tests exercise the realistic failure path.
function startedResult(): DaemonCommandResult<{
  status: 'started' | 'already-running';
}> {
  return { ok: true, value: { status: 'started' }, stdout: '', stderr: '' };
}

function stoppedResult(): DaemonCommandResult<{
  status: 'stopped' | 'not-running';
}> {
  return { ok: true, value: { status: 'stopped' }, stdout: '', stderr: '' };
}

/** What `status` answers on a machine where nothing is on the socket —
 *  the answer every start() gets from its pre-flight look unless a test
 *  says otherwise. */
function notRunningResult(): DaemonCommandResult<DaemonStatusOutcome> {
  return {
    ok: true,
    value: {
      running: false,
      reason: 'not-running',
      message: 'daemon not running',
    },
    stdout: '',
    stderr: '',
  };
}

/** What `status` answers when a daemon from before is still serving —
 *  the restart-survival case install() exists to notice. */
function runningResult(): DaemonCommandResult<DaemonStatusOutcome> {
  return {
    ok: true,
    value: { running: true, version: '0.1.0', uptimeMs: 60_000 },
    stdout: '',
    stderr: '',
  };
}

function daemonFailure(
  failure: DaemonCommandFailure,
): DaemonCommandResult<never> {
  return { ok: false, failure, stdout: '', stderr: '' };
}

/** Builds a `runDaemonCommand` override with the cast this file's `makeDeps`
 *  default also needs — RunDaemonCommand's own generic `<C extends
 *  DaemonManagementCommand>` signature does not structurally match a plain
 *  jest mock, and every real call site here passes a literal 'start',
 *  'stop' or 'status' anyway, so the cast is one place instead of one per
 *  test. An override must answer 'status' too: start() looks at the
 *  socket before it starts anything, so an impl that ignores the command
 *  and fails everything fails the look, not the start. */
function mockRunDaemonCommand(
  impl: (
    launcherPath: string,
    command: DaemonManagementCommand,
    options: RunDaemonCommandOptions,
  ) => Promise<DaemonCommandResult<{ status: string } | DaemonStatusOutcome>>,
): RunDaemonCommand {
  return jest.fn(impl) as unknown as RunDaemonCommand;
}

/** The common override shape: `status` says nothing is running, and the
 *  `start` that follows answers with `startAnswer`. */
function failingStart(
  startAnswer: () => Promise<DaemonCommandResult<{ status: string }>>,
): RunDaemonCommand {
  return mockRunDaemonCommand((_launcher, command) =>
    command === 'status' ? Promise.resolve(notRunningResult()) : startAnswer(),
  );
}

/** A fake transport whose onClose is exposed as `fireClose` so a test can
 *  simulate the daemon vanishing after start() has already resolved. */
function fakeTransport(): EngineTransport & {
  fireClose: (reason: EngineTransportCloseReason) => void;
} {
  const closeListeners = new Set<
    (reason: EngineTransportCloseReason) => void
  >();
  return {
    mode: 'socket',
    send: jest.fn(),
    onData: jest.fn(() => () => {}),
    onClose: jest.fn((cb) => {
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    }),
    close: jest.fn(),
    fireClose: (reason) => closeListeners.forEach((cb) => cb(reason)),
  };
}

/** A fake WireClient whose `call` is driven per-path by the test, and whose
 *  onDisconnect is exposed as `fireDisconnect` — mirrors fakeTransport's
 *  fireClose but at the WireClient layer, which is what the supervisor
 *  actually subscribes to. */
function fakeClient(
  callImpl: (path: string, input?: unknown) => Promise<unknown> = () =>
    Promise.resolve(undefined),
): WireClient & {
  fireDisconnect: (reason: EngineTransportCloseReason) => void;
} {
  const disconnectListeners = new Set<
    (reason: EngineTransportCloseReason) => void
  >();
  return {
    call: jest.fn((path: string, input?: unknown) =>
      callImpl(path, input),
    ) as WireClient['call'],
    attach: jest.fn(),
    onDisconnect: jest.fn((cb) => {
      disconnectListeners.add(cb);
      return () => disconnectListeners.delete(cb);
    }),
    close: jest.fn(),
    fireDisconnect: (reason) => disconnectListeners.forEach((cb) => cb(reason)),
  };
}

function successfulInitializeAndHealth(
  client: ReturnType<typeof fakeClient>,
): void {
  (client.call as jest.Mock).mockImplementation((path: string) => {
    if (path === 'initialize')
      return Promise.resolve({ success: true, data: AGREED });
    if (path === 'health') return Promise.resolve(HEALTH);
    return Promise.reject(new Error(`unexpected call: ${path}`));
  });
}

function makeDeps(overrides: Partial<EngineSupervisorDeps> = {}): {
  deps: EngineSupervisorDeps;
  runDaemonCommand: jest.Mock;
  connectSocketTransport: jest.MockedFunction<ConnectSocketTransport>;
  createWireClient: jest.MockedFunction<CreateWireClient>;
  verifyInstalledEngine: jest.MockedFunction<VerifyInstalledEngine>;
} {
  // Cast at the boundary rather than fighting RunDaemonCommand's own
  // generic `<C extends DaemonManagementCommand>` signature through
  // jest.fn's generics — every real call site passes a literal 'start',
  // 'stop' or 'status', and this default answers each correctly by
  // branching on it. The default world: nothing on the socket, and every
  // start/stop succeeds.
  const runDaemonCommand = jest.fn(
    (_launcherPath: string, command: DaemonManagementCommand) =>
      Promise.resolve(
        command === 'stop'
          ? stoppedResult()
          : command === 'status'
            ? notRunningResult()
            : startedResult(),
      ),
  ) as unknown as jest.MockedFunction<RunDaemonCommand>;
  const connectSocketTransport = jest.fn<
    ReturnType<ConnectSocketTransport>,
    Parameters<ConnectSocketTransport>
  >(() => Promise.resolve(fakeTransport()));
  const createWireClient = jest.fn<
    ReturnType<CreateWireClient>,
    Parameters<CreateWireClient>
  >(() => fakeClient());
  const verifyInstalledEngine = jest.fn<
    ReturnType<VerifyInstalledEngine>,
    Parameters<VerifyInstalledEngine>
  >(() => Promise.resolve(installedResult()));

  const deps: EngineSupervisorDeps = {
    paths: PATHS,
    runDaemonCommand,
    connectSocketTransport,
    createWireClient,
    verifyInstalledEngine,
    appVersion: '0.0.0-test',
    clock: jest.fn(() => 1_000),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };

  // Read the mocks back off the assembled `deps` rather than closing over
  // the pre-override locals: a caller that overrode e.g.
  // `connectSocketTransport` must get ITS mock back, not the unused default
  // one this function also happened to construct.
  return {
    deps,
    runDaemonCommand: deps.runDaemonCommand as unknown as jest.Mock,
    connectSocketTransport:
      deps.connectSocketTransport as jest.MockedFunction<ConnectSocketTransport>,
    createWireClient:
      deps.createWireClient as jest.MockedFunction<CreateWireClient>,
    verifyInstalledEngine:
      deps.verifyInstalledEngine as jest.MockedFunction<VerifyInstalledEngine>,
  };
}

describe('createEngineSupervisor', () => {
  describe('getStatus before any check', () => {
    it('starts as not-installed — a provisional placeholder, never rendered directly by MachinePage', () => {
      const { deps } = makeDeps();
      const supervisor = createEngineSupervisor(deps);

      expect(supervisor.getStatus()).toEqual({
        kind: 'not-installed',
        installDir: PATHS.installDir,
      });
    });
  });

  describe('install()', () => {
    it('reports not-installed when verifyInstalledEngine finds no launcher', async () => {
      const { deps } = makeDeps({
        verifyInstalledEngine: jest.fn(() =>
          Promise.resolve(notInstalledResult()),
        ),
      });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.install();

      expect(status).toEqual({
        kind: 'not-installed',
        installDir: PATHS.installDir,
      });
    });

    it('reports stopped, with the verified version, when the manifest matches the pin', async () => {
      const { deps } = makeDeps({
        verifyInstalledEngine: jest.fn(() =>
          Promise.resolve(installedResult('0.1.0')),
        ),
      });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.install();

      expect(status).toEqual({
        kind: 'stopped',
        installDir: PATHS.installDir,
        version: '0.1.0',
      });
    });

    it('reports failed, stage install, when the manifest does not match the pin', async () => {
      const { deps } = makeDeps({
        verifyInstalledEngine: jest.fn(() =>
          Promise.resolve(
            mismatchResult(
              "Installed engine's version is 0.0.9; Waypoint is pinned to 0.1.0.",
            ),
          ),
        ),
      });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.install();

      expect(status).toMatchObject({
        kind: 'failed',
        stage: 'install',
        message:
          "Installed engine's version is 0.0.9; Waypoint is pinned to 0.1.0.",
      });
    });

    it('reports failed, stage install, when verifyInstalledEngine itself throws', async () => {
      const { deps } = makeDeps({
        verifyInstalledEngine: jest.fn(() =>
          Promise.reject(new Error('EACCES: permission denied')),
        ),
      });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.install();

      expect(status).toMatchObject({
        kind: 'failed',
        stage: 'install',
        message: 'EACCES: permission denied',
      });
    });

    // Found in review (M1): the first draft reported `stopped` from the
    // files alone. `stopped` is a claim about the socket, so install()
    // asks the daemon's own `status` — and attaches when a daemon from
    // before is still serving, which is the restart-survival case this
    // architecture exists for.
    it('attaches to a daemon that outlived the last Waypoint: starting -> running, no start issued', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps, runDaemonCommand } = makeDeps({
        createWireClient: jest.fn(() => client),
        runDaemonCommand: mockRunDaemonCommand((_l, command) =>
          Promise.resolve(
            command === 'status' ? runningResult() : startedResult(),
          ),
        ),
      });
      const supervisor = createEngineSupervisor(deps);
      const seen: string[] = [];
      supervisor.onStatusChange((s) => seen.push(s.kind));

      const status = await supervisor.install();

      expect(status.kind).toBe('running');
      expect(seen).toEqual(['starting', 'running']);
      expect(
        (runDaemonCommand as unknown as jest.Mock).mock.calls.map((c) => c[1]),
      ).toEqual(['status']);
      expect(client.call).toHaveBeenCalledWith('health');
    });

    it('reports failed, stage health, when something answers the socket but not health — never stopped', async () => {
      const { deps } = makeDeps({
        runDaemonCommand: mockRunDaemonCommand((_l, command) =>
          Promise.resolve(
            command === 'status'
              ? {
                  ok: true,
                  value: {
                    running: false,
                    reason: 'unhealthy',
                    message: 'health probe failed: TIMEOUT',
                  },
                  stdout: '',
                  stderr: '',
                }
              : startedResult(),
          ),
        ),
      });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.install();

      expect(status).toMatchObject({
        kind: 'failed',
        stage: 'health',
        message: 'health probe failed: TIMEOUT',
      });
    });

    it('reports failed, stage health, when the status probe itself cannot run', async () => {
      const { deps } = makeDeps({
        runDaemonCommand: mockRunDaemonCommand((_l, command) =>
          Promise.resolve(
            command === 'status'
              ? daemonFailure({ kind: 'timeout', timeoutMs: 5_000 })
              : startedResult(),
          ),
        ),
      });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.install();

      expect(status).toMatchObject({
        kind: 'failed',
        stage: 'health',
        message: 'The engine command did not finish within 5000ms.',
      });
    });

    it('answers two concurrent install() calls with one look', async () => {
      const { deps, verifyInstalledEngine, runDaemonCommand } = makeDeps();
      const supervisor = createEngineSupervisor(deps);

      const [a, b] = await Promise.all([
        supervisor.install(),
        supervisor.install(),
      ]);

      expect(a).toEqual(b);
      expect(a.kind).toBe('stopped');
      expect(verifyInstalledEngine).toHaveBeenCalledTimes(1);
      expect(runDaemonCommand).toHaveBeenCalledTimes(1);
    });

    // The review finding this guards: install() must never clobber a live
    // 'running' status with a stale disk read from a second call (a
    // MachinePage remount, say).
    it('is a no-op while running, never re-deriving from disk over a live connection', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps, verifyInstalledEngine } = makeDeps({
        createWireClient: jest.fn(() => client),
      });
      const supervisor = createEngineSupervisor(deps);
      await supervisor.start();
      verifyInstalledEngine.mockClear();

      const status = await supervisor.install();

      expect(status.kind).toBe('running');
      expect(verifyInstalledEngine).not.toHaveBeenCalled();
    });
  });

  describe('start()', () => {
    it('walks starting -> running through runDaemonCommand, connect, initialize, health', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const transport = fakeTransport();
      const {
        deps,
        runDaemonCommand,
        connectSocketTransport,
        createWireClient,
      } = makeDeps({
        connectSocketTransport: jest.fn(() => Promise.resolve(transport)),
        createWireClient: jest.fn(() => client),
      });
      const supervisor = createEngineSupervisor(deps);
      // MachinePage's real order: install() on mount, start() on click.
      await supervisor.install();
      const seen: string[] = [];
      supervisor.onStatusChange((s) => seen.push(s.kind));

      const status = await supervisor.start();

      expect(runDaemonCommand).toHaveBeenCalledWith(
        PATHS.launcherPath,
        'start',
        {
          socketPath: PATHS.socketPath,
          cwd: PATHS.installDir,
        },
      );
      expect(connectSocketTransport).toHaveBeenCalledWith(PATHS.socketPath);
      expect(createWireClient).toHaveBeenCalledWith(transport);
      // The daemon requires the `client` object — observed live: without it,
      // HANDLER_ERROR "client: expected object" — so this pins its presence,
      // not just the protocol version.
      expect(client.call).toHaveBeenCalledWith('initialize', {
        protocolVersion: '1.0.0',
        client: { id: 'waypoint', appVersion: '0.0.0-test' },
      });
      expect(client.call).toHaveBeenCalledWith('health');
      expect(status).toEqual({
        kind: 'running',
        since: 1_000,
        health: HEALTH,
        agreed: AGREED,
        transport: 'socket',
      });
      expect(seen).toEqual(['starting', 'running']);
    });

    // Found in review (L6): a start() from the never-observed placeholder
    // used to reach the CLI without ever verifying the files or asking
    // the socket. It looks first now — and the look is what sees a daemon
    // that outlived the last Waypoint (M1), so a cold start() must never
    // issue `start` over one that is already serving.
    it('from cold, looks before it starts: verify, status, then start — and reports stopped on the way', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps, runDaemonCommand, verifyInstalledEngine } = makeDeps({
        createWireClient: jest.fn(() => client),
      });
      const supervisor = createEngineSupervisor(deps);
      const seen: string[] = [];
      supervisor.onStatusChange((s) => seen.push(s.kind));

      const status = await supervisor.start();

      expect(status.kind).toBe('running');
      expect(seen).toEqual(['stopped', 'starting', 'running']);
      expect(verifyInstalledEngine).toHaveBeenCalledTimes(1);
      expect(runDaemonCommand.mock.calls.map((c) => c[1])).toEqual([
        'status',
        'start',
      ]);
    });

    it('from cold, attaches to a daemon already serving instead of issuing start', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps, runDaemonCommand } = makeDeps({
        createWireClient: jest.fn(() => client),
        runDaemonCommand: mockRunDaemonCommand((_l, command) =>
          Promise.resolve(
            command === 'status' ? runningResult() : startedResult(),
          ),
        ),
      });
      const supervisor = createEngineSupervisor(deps);
      const seen: string[] = [];
      supervisor.onStatusChange((s) => seen.push(s.kind));

      const status = await supervisor.start();

      expect(status.kind).toBe('running');
      expect(seen).toEqual(['starting', 'running']);
      expect(
        (runDaemonCommand as unknown as jest.Mock).mock.calls.map((c) => c[1]),
      ).toEqual(['status']);
    });

    it('fails at stage start when runDaemonCommand answers ok:false (the launcher could not run)', async () => {
      const { deps } = makeDeps({
        runDaemonCommand: failingStart(() =>
          Promise.resolve(
            daemonFailure({
              kind: 'launcher',
              message:
                'could not run engine launcher /userdata/engine/0.1.0/.../bin/emdash-workspace-server: ENOENT',
            }),
          ),
        ),
      });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.start();

      expect(status).toMatchObject({
        kind: 'failed',
        stage: 'start',
        message:
          'could not run engine launcher /userdata/engine/0.1.0/.../bin/emdash-workspace-server: ENOENT',
      });
    });

    it('fails at stage start when runDaemonCommand answers ok:false with a timeout', async () => {
      const { deps } = makeDeps({
        runDaemonCommand: failingStart(() =>
          Promise.resolve(
            daemonFailure({ kind: 'timeout', timeoutMs: 20_000 }),
          ),
        ),
      });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.start();

      expect(status).toMatchObject({
        kind: 'failed',
        stage: 'start',
        message: 'The engine command did not finish within 20000ms.',
      });
    });

    // Defense in depth: runDaemonCommand's documented contract "resolves
    // always" (daemonCli.ts), so this exercises the backstop for a contract
    // violation rather than the realistic failure path above.
    it('fails at stage start if runDaemonCommand itself ever rejects, despite its documented contract', async () => {
      const { deps } = makeDeps({
        runDaemonCommand: failingStart(() =>
          Promise.reject(new Error('spawn ENOENT')),
        ),
      });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.start();

      expect(status).toMatchObject({
        kind: 'failed',
        stage: 'start',
        message: 'spawn ENOENT',
      });
    });

    it('treats already-running the same as started — both are success', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps } = makeDeps({
        createWireClient: jest.fn(() => client),
        runDaemonCommand: failingStart(() =>
          Promise.resolve({
            ok: true,
            value: { status: 'already-running' },
            stdout: '',
            stderr: '',
          }),
        ),
      });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.start();

      expect(status.kind).toBe('running');
    });

    it('fails at stage connect when the socket connection is refused', async () => {
      const { deps } = makeDeps({
        connectSocketTransport: jest.fn(() =>
          Promise.reject(
            new Error('daemon socket exists but refused the connection'),
          ),
        ),
      });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.start();

      expect(status).toMatchObject({ kind: 'failed', stage: 'connect' });
    });

    it('fails at stage initialize, with incompatible set, on a protocol mismatch — and does not retry', async () => {
      const incompatible: EngineInitializeError = {
        type: 'protocol-incompatible',
        action: 'upgrade Waypoint',
        clientProtocolVersion: '1.0.0',
        serverProtocolVersion: '2.0.0',
      };
      const client = fakeClient((path) =>
        path === 'initialize'
          ? Promise.resolve({ success: false, error: incompatible })
          : Promise.resolve(HEALTH),
      );
      const { deps } = makeDeps({ createWireClient: jest.fn(() => client) });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.start();

      expect(status).toMatchObject({
        kind: 'failed',
        stage: 'initialize',
        incompatible,
        message: 'This engine speaks protocol 2.0.0; Waypoint speaks 1.0.0.',
      });
      expect(client.close).toHaveBeenCalledTimes(1);
      // health() was never reached — the mismatch is terminal for this
      // attempt, matching "upgrade, don't retry".
      expect(client.call).not.toHaveBeenCalledWith('health');
    });

    it('fails at stage initialize when the call itself throws (e.g. disconnected mid-handshake)', async () => {
      const client = fakeClient(() =>
        Promise.reject(new Error('disconnected')),
      );
      const { deps } = makeDeps({ createWireClient: jest.fn(() => client) });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.start();

      expect(status).toMatchObject({
        kind: 'failed',
        stage: 'initialize',
        message: 'disconnected',
      });
    });

    it('fails at stage health when the post-initialize health call throws', async () => {
      const client = fakeClient((path) =>
        path === 'initialize'
          ? Promise.resolve({ success: true, data: AGREED })
          : Promise.reject(new Error('timed out')),
      );
      const { deps } = makeDeps({ createWireClient: jest.fn(() => client) });
      const supervisor = createEngineSupervisor(deps);

      const status = await supervisor.start();

      expect(status).toMatchObject({
        kind: 'failed',
        stage: 'health',
        message: 'timed out',
      });
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it('short-circuits a second start() called while the first is still starting, without a second runDaemonCommand', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps, runDaemonCommand } = makeDeps({
        createWireClient: jest.fn(() => client),
      });
      const supervisor = createEngineSupervisor(deps);
      await supervisor.install();
      runDaemonCommand.mockClear();

      const first = supervisor.start();
      // Called synchronously, before `first` has had a chance to resolve —
      // status is already 'starting' by this point (set synchronously
      // before start()'s first await, now that install() has looked), so
      // this must short-circuit rather than kick off a second
      // runDaemonCommand/connect/initialize sequence.
      const second = await supervisor.start();
      expect(second.kind).toBe('starting');

      const firstResult = await first;
      expect(firstResult.kind).toBe('running');
      expect(runDaemonCommand).toHaveBeenCalledTimes(1);
    });

    it('two cold start() calls share one look and issue one start', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps, runDaemonCommand, verifyInstalledEngine } = makeDeps({
        createWireClient: jest.fn(() => client),
      });
      const supervisor = createEngineSupervisor(deps);

      const [first, second] = await Promise.all([
        supervisor.start(),
        supervisor.start(),
      ]);

      // Whichever resumed first owns the start; the other saw 'starting'
      // and stepped aside. Neither fabricated a second look or a second
      // `start` over the first one's socket.
      expect([first.kind, second.kind].sort()).toEqual(['running', 'starting']);
      expect(verifyInstalledEngine).toHaveBeenCalledTimes(1);
      expect(runDaemonCommand.mock.calls.map((c) => c[1])).toEqual([
        'status',
        'start',
      ]);
      expect(supervisor.getStatus().kind).toBe('running');
    });

    it('short-circuits a start() called again once already running', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps, runDaemonCommand } = makeDeps({
        createWireClient: jest.fn(() => client),
      });
      const supervisor = createEngineSupervisor(deps);
      await supervisor.start();
      runDaemonCommand.mockClear();

      const status = await supervisor.start();

      expect(status.kind).toBe('running');
      expect(runDaemonCommand).not.toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    async function startedSupervisor() {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const deps = makeDeps({ createWireClient: jest.fn(() => client) });
      const supervisor = createEngineSupervisor(deps.deps);
      await supervisor.start();
      return { supervisor, client, ...deps };
    }

    it('walks running -> stopping -> stopped, closing the live client first', async () => {
      const { supervisor, client, runDaemonCommand } =
        await startedSupervisor();
      const seen: string[] = [];
      supervisor.onStatusChange((s) => seen.push(s.kind));

      const status = await supervisor.stop();

      expect(runDaemonCommand).toHaveBeenCalledWith(
        PATHS.launcherPath,
        'stop',
        {
          socketPath: PATHS.socketPath,
          cwd: PATHS.installDir,
        },
      );
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(status).toEqual({
        kind: 'stopped',
        installDir: PATHS.installDir,
        version: '0.1.0',
      });
      expect(seen).toEqual(['stopping', 'stopped']);
    });

    it('reports the actually-verified install version, not a bare ENGINE_PIN guess, after install() ran first', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps, verifyInstalledEngine } = makeDeps({
        createWireClient: jest.fn(() => client),
        verifyInstalledEngine: jest.fn(() =>
          Promise.resolve(installedResult('0.1.0')),
        ),
      });
      const supervisor = createEngineSupervisor(deps);
      await supervisor.install();
      verifyInstalledEngine.mockClear();
      await supervisor.start();

      const status = await supervisor.stop();

      expect(status).toMatchObject({ version: '0.1.0' });
    });

    it('fails at stage stop when runDaemonCommand answers ok:false, and has already torn down the client', async () => {
      const { supervisor, client, deps } = await startedSupervisor();
      (deps.runDaemonCommand as jest.Mock).mockImplementation(() =>
        Promise.resolve(
          daemonFailure({
            kind: 'daemon-error',
            message: 'ESRCH: no such process',
            code: 1,
            signal: null,
          }),
        ),
      );

      const status = await supervisor.stop();

      expect(status).toMatchObject({
        kind: 'failed',
        stage: 'stop',
        message: 'ESRCH: no such process',
      });
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it('treats not-running the same as stopped — both are success, not an error', async () => {
      const { supervisor, deps } = await startedSupervisor();
      (deps.runDaemonCommand as jest.Mock).mockImplementation(() =>
        Promise.resolve({
          ok: true,
          value: { status: 'not-running' },
          stdout: '',
          stderr: '',
        } satisfies DaemonCommandResult<{ status: 'not-running' }>),
      );

      const status = await supervisor.stop();

      expect(status.kind).toBe('stopped');
    });

    // Defense in depth: runDaemonCommand's documented contract "resolves
    // always" (daemonCli.ts), so this exercises the backstop for a contract
    // violation rather than the realistic ok:false path above.
    it('fails at stage stop if runDaemonCommand itself ever rejects, despite its documented contract', async () => {
      const { supervisor, client, deps } = await startedSupervisor();
      (deps.runDaemonCommand as jest.Mock).mockImplementation(() =>
        Promise.reject(new Error('ESRCH: no such process')),
      );

      const status = await supervisor.stop();

      expect(status).toMatchObject({
        kind: 'failed',
        stage: 'stop',
        message: 'ESRCH: no such process',
      });
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when already stopped or not-installed', async () => {
      const { deps, runDaemonCommand } = makeDeps();
      const supervisor = createEngineSupervisor(deps);

      await supervisor.stop();

      expect(runDaemonCommand).not.toHaveBeenCalled();
    });

    it('unsubscribes the disconnect handler before stopping, so the daemon actually exiting does not also fire a spurious "failed"', async () => {
      const { supervisor, client } = await startedSupervisor();
      const seen: string[] = [];
      supervisor.onStatusChange((s) => seen.push(s.kind));

      await supervisor.stop();
      // Simulate the daemon process actually exiting only after our own
      // stop() has already torn the client down — a real race stop() must
      // win.
      client.fireDisconnect({ kind: 'peer-closed' });

      expect(seen).toEqual(['stopping', 'stopped']);
    });
  });

  describe('client()', () => {
    it('is null until running, the live client while running, null again after stop()', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps } = makeDeps({ createWireClient: jest.fn(() => client) });
      const supervisor = createEngineSupervisor(deps);

      expect(supervisor.client()).toBeNull();
      await supervisor.install();
      expect(supervisor.client()).toBeNull();
      await supervisor.start();
      expect(supervisor.client()).toBe(client);
      await supervisor.stop();
      expect(supervisor.client()).toBeNull();
    });
  });

  describe('health()', () => {
    it('returns null with no live client, without throwing', async () => {
      const { deps } = makeDeps();
      const supervisor = createEngineSupervisor(deps);

      await expect(supervisor.health()).resolves.toBeNull();
    });

    it('returns a fresh EngineHealth on a live connection', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps } = makeDeps({ createWireClient: jest.fn(() => client) });
      const supervisor = createEngineSupervisor(deps);
      await supervisor.start();
      (client.call as jest.Mock).mockImplementation((path: string) =>
        path === 'health'
          ? Promise.resolve({ ...HEALTH, uptimeMs: 999 })
          : Promise.resolve(HEALTH),
      );

      const result = await supervisor.health();

      expect(result).toEqual({ ...HEALTH, uptimeMs: 999 });
    });

    it('transitions to failed, stage health, and returns null when the call throws', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps } = makeDeps({ createWireClient: jest.fn(() => client) });
      const supervisor = createEngineSupervisor(deps);
      await supervisor.start();
      (client.call as jest.Mock).mockImplementation((path: string) =>
        path === 'health'
          ? Promise.reject(new Error('disconnected'))
          : Promise.resolve(HEALTH),
      );
      const seen: string[] = [];
      supervisor.onStatusChange((s) => seen.push(s.kind));

      const result = await supervisor.health();

      expect(result).toBeNull();
      expect(supervisor.getStatus()).toMatchObject({
        kind: 'failed',
        stage: 'health',
      });
      expect(seen).toEqual(['failed']);
    });
  });

  describe('unexpected disconnect while running', () => {
    it('transitions to failed, stage health, with a message from the close reason', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps } = makeDeps({ createWireClient: jest.fn(() => client) });
      const supervisor = createEngineSupervisor(deps);
      await supervisor.start();
      const seen: string[] = [];
      supervisor.onStatusChange((s) => seen.push(s.kind));

      client.fireDisconnect({ kind: 'child-exited', code: 1, signal: null });

      expect(supervisor.getStatus()).toMatchObject({
        kind: 'failed',
        stage: 'health',
        message: 'The engine process exited (code 1).',
      });
      expect(seen).toEqual(['failed']);
    });

    // No auto-restart in W1 (recorded as a decision, not an oversight — see
    // supervisor.ts's own comment on start()'s disconnect handler and this
    // file's report). Confirmed here as the negative case: nothing calls
    // runDaemonCommand or attempts to reconnect on its own.
    it('never auto-restarts — the failure is reported, not papered over', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps, runDaemonCommand } = makeDeps({
        createWireClient: jest.fn(() => client),
      });
      const supervisor = createEngineSupervisor(deps);
      await supervisor.start();
      runDaemonCommand.mockClear();

      client.fireDisconnect({ kind: 'peer-closed' });
      await Promise.resolve();

      expect(runDaemonCommand).not.toHaveBeenCalled();
      expect(supervisor.getStatus().kind).toBe('failed');
    });
  });

  describe('onStatusChange', () => {
    it('does not fire on subscribe, only on a real subsequent transition', async () => {
      const { deps } = makeDeps({
        verifyInstalledEngine: jest.fn(() =>
          Promise.resolve(notInstalledResult()),
        ),
      });
      const supervisor = createEngineSupervisor(deps);
      const cb = jest.fn();

      supervisor.onStatusChange(cb);
      expect(cb).not.toHaveBeenCalled();

      await supervisor.install();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('stops notifying once unsubscribed', async () => {
      const { deps } = makeDeps({
        verifyInstalledEngine: jest.fn(() =>
          Promise.resolve(notInstalledResult()),
        ),
      });
      const supervisor = createEngineSupervisor(deps);
      const cb = jest.fn();
      const unsubscribe = supervisor.onStatusChange(cb);

      unsubscribe();
      await supervisor.install();

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('dispose()', () => {
    it('closes a live client and stops notifying listeners', async () => {
      const client = fakeClient();
      successfulInitializeAndHealth(client);
      const { deps } = makeDeps({ createWireClient: jest.fn(() => client) });
      const supervisor = createEngineSupervisor(deps);
      await supervisor.start();
      const cb = jest.fn();
      supervisor.onStatusChange(cb);

      supervisor.dispose();

      expect(client.close).toHaveBeenCalledTimes(1);
      // A disconnect firing after dispose (a straggling event) must not
      // reach a listener set dispose() already cleared.
      client.fireDisconnect({ kind: 'closed-by-us' });
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
