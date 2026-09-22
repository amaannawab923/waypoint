import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EngineSupervisor } from '../../supervisor';
import type { EngineStatus, WireClient } from '../../types';

const saveMcpServer = jest.fn<Promise<void>, [unknown]>(async () => {});
jest.mock('../daemonApi', () => ({
  createDaemonRunsApi: jest.fn(() => ({
    saveMcpServer: (server: unknown) => saveMcpServer(server),
  })),
}));

const readStoredTypesafeApiKeyMock = jest.fn<string | null, []>();
const getStoredSubscriptionTokenMock = jest.fn<string | null, []>(() => null);
jest.mock('../../../copilot/copilotAuth', () => ({
  getStoredSubscriptionToken: () => getStoredSubscriptionTokenMock(),
}));
jest.mock('../../../copilot/copilotConfigDir', () => ({
  copilotClaudeConfigDir: () => '/fake/copilot-config',
}));
// F1: registration.ts now also calls auth.ts's writeRuntimeSecretFile /
// removeRuntimeSecretFile, which — unlike readStoredTypesafeApiKey/
// resolveTypesafeApiKey below — this test wants running FOR REAL (plain
// fs + path, no `electron` dependency of their own), so the tests can
// assert against real files on disk. That means loading the real auth.ts
// module (`jest.requireActual`, mirroring the pythonEnv mock below), which
// in turn imports `app`/`safeStorage` from `electron` at module scope for
// its OWN (unrelated, at-rest) store — unmocked, that import would try to
// resolve the real Electron package under this file's plain jsdom test
// environment. A minimal fake is enough: nothing in this file exercises
// the encrypted store itself.
jest.mock('electron', () => ({
  app: {
    getPath: () => '/fake/userData-registration-test',
    getAppPath: () => '/fake/app',
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

jest.mock('./auth', () => {
  const actual = jest.requireActual('./auth');
  return {
    ...actual,
    readStoredTypesafeApiKey: () => readStoredTypesafeApiKeyMock(),
    resolveTypesafeApiKey: () => {
      const stored = readStoredTypesafeApiKeyMock();
      return stored ? { key: stored, source: 'settings' } : null;
    },
  };
});

const findUvMock = jest.fn<string | null, []>();
const isProvisionedMock = jest.fn<boolean, [unknown]>();
const provisionPythonEnvMock = jest.fn<
  Promise<{ ok: boolean; message?: string; alreadyProvisioned?: boolean }>,
  [unknown]
>();
jest.mock('./pythonEnv', () => {
  const actual = jest.requireActual('./pythonEnv');
  return {
    ...actual,
    findUv: () => findUvMock(),
    isProvisioned: (paths: unknown) => isProvisionedMock(paths),
    provisionPythonEnv: (deps: unknown) => provisionPythonEnvMock(deps),
    runCommand: jest.fn(),
  };
});

// eslint-disable-next-line import/order, import/first
import {
  ULTRAFAST_SERVER_NAME,
  isUltrafastRegistered,
  registerUltrafastBrowser,
  reregisterUltrafastBrowser,
  resetUltrafastRegistrationStateForTests,
  ultrafastAvailability,
  unregisterUltrafastBrowser,
} from './registration';

/** The file's permission bits as an octal string ('600'), no bitwise
 *  operator needed (the repo's own lint config forbids `&` outside the
 *  handful of pre-existing exceptions this task's own findings don't
 *  touch). */
const permOctal = (filePath: string): string =>
  fs.statSync(filePath).mode.toString(8).slice(-3);

const running = (since: number): EngineStatus =>
  ({
    kind: 'running',
    since,
    health: {},
    agreed: {},
    transport: 'socket',
  }) as unknown as EngineStatus;
const stopped = { kind: 'stopped' } as unknown as EngineStatus;

function fakeSupervisor(initial: EngineStatus) {
  let status = initial;
  const listeners = new Set<(s: EngineStatus) => void>();
  const client = {} as unknown as WireClient;
  const supervisor: EngineSupervisor & { emit: (s: EngineStatus) => void } = {
    getStatus: () => status,
    install: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    health: jest.fn(),
    client: () => (status.kind === 'running' ? client : null),
    onStatusChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose: jest.fn(),
    emit: (next) => {
      status = next;
      listeners.forEach((cb) => cb(next));
    },
  };
  return supervisor;
}

const logger = { info: jest.fn(), warn: jest.fn() };
const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

let tmpRoot: string;
let appPath: string;
let resourcesPath: string;
let userData: string;

beforeEach(() => {
  jest.clearAllMocks();
  // F15: isRegistered/activeAttemptNow are module-level in registration.ts
  // (by design — engineIpc.ts's ultrafastAvailable() and ipc.ts's
  // saveKey/clearKey handlers all need a single source of truth reachable
  // without plumbing deps through IPC). Reset between tests so one test's
  // registration doesn't leave isUltrafastRegistered() true for the next.
  resetUltrafastRegistrationStateForTests();
  saveMcpServer.mockImplementation(async () => {});
  readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_key');
  findUvMock.mockReturnValue('/opt/homebrew/bin/uv');
  isProvisionedMock.mockReturnValue(true);
  provisionPythonEnvMock.mockResolvedValue({
    ok: true,
    alreadyProvisioned: true,
  });

  tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ultrafast-registration-test-'),
  );
  appPath = path.join(tmpRoot, 'app');
  resourcesPath = path.join(tmpRoot, 'resources');
  userData = path.join(tmpRoot, 'userData');
  fs.mkdirSync(path.join(resourcesPath, 'scripts', 'ultrafast'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(resourcesPath, 'scripts', 'ultrafast-mcp.js'),
    '// fake',
  );
  fs.writeFileSync(
    path.join(resourcesPath, 'scripts', 'ultrafast', 'runner.py'),
    '# fake',
  );
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('registerUltrafastBrowser', () => {
  it('registers once a key is configured, uv is available, and the scripts exist', async () => {
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(saveMcpServer).toHaveBeenCalledTimes(1);
    const server = saveMcpServer.mock.calls[0][0] as {
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      providers: string[];
    };
    expect(server.name).toBe(ULTRAFAST_SERVER_NAME);
    expect(server.command).toBe('/bin/waypoint');
    expect(server.args).toEqual([
      path.join(resourcesPath, 'scripts', 'ultrafast-mcp.js'),
    ]);
    expect(server.env.ELECTRON_RUN_AS_NODE).toBe('1');
    // F1 (tech-lead review, 2026-09-22, BLOCKER): the raw key must never
    // be a value in this env object — this IS the object
    // `createDaemonRunsApi(client).saveMcpServer` hands the daemon, which
    // persists it into the person's real ~/.claude.json at 0o644. Only a
    // FILE PATH (not a secret) may appear here; the real key lives in
    // that file, at 0o600, under this test's own userData tmp dir.
    expect(server.env.ULTRAFAST_TYPESAFE_API_KEY).toBeUndefined();
    expect(Object.values(server.env)).not.toContain('ts_live_key');
    const keyFile = server.env.ULTRAFAST_KEY_FILE;
    expect(keyFile).toBe(path.join(userData, 'ultrafast', 'runtime-key'));
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('ts_live_key');
    expect(permOctal(keyFile)).toBe('600');
    expect(server.env.ULTRAFAST_RUNNER_PATH).toBe(
      path.join(resourcesPath, 'scripts', 'ultrafast', 'runner.py'),
    );
    expect(server.providers).toEqual(['claude']);
    // Found on the first live Test: the Claude Code CLI the shim's SDK
    // spawns reads the login from the keychain, which needs HOME and USER;
    // without them every field value came back "Not logged in".
    expect(server.env.HOME).toBeTruthy();
    expect(server.env.USER).toBeTruthy();
    expect(server.env.PATH).toBeTruthy();
    expect(server.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(server.env.ULTRAFAST_OAUTH_TOKEN_FILE).toBeUndefined();
  });

  it('hands the shim Copilot’s connected subscription token, when there is one', async () => {
    getStoredSubscriptionTokenMock.mockReturnValue('sk-ant-oat01-xyz');
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      logger,
      execPath: '/bin/waypoint',
    });
    await flush();
    const server = saveMcpServer.mock.calls[0][0] as {
      env: Record<string, string>;
    };
    // F1: same reasoning as the TypeSafe key above — the raw OAuth token
    // must never be a value in the env `saveMcpServer` persists to
    // ~/.claude.json. Only CLAUDE_CONFIG_DIR (a path, not a secret) and
    // ULTRAFAST_OAUTH_TOKEN_FILE (also a path) may appear here.
    expect(server.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(Object.values(server.env)).not.toContain('sk-ant-oat01-xyz');
    const tokenFile = server.env.ULTRAFAST_OAUTH_TOKEN_FILE;
    expect(tokenFile).toBe(
      path.join(userData, 'ultrafast', 'runtime-oauth-token'),
    );
    expect(fs.readFileSync(tokenFile, 'utf8')).toBe('sk-ant-oat01-xyz');
    expect(permOctal(tokenFile)).toBe('600');
    expect(server.env.CLAUDE_CONFIG_DIR).toBe('/fake/copilot-config');
  });

  it('removes a stale OAuth token file when Copilot is no longer connected', async () => {
    // A prior registration left a connected-token file behind…
    getStoredSubscriptionTokenMock.mockReturnValue('sk-ant-oat01-old');
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      logger,
      execPath: '/bin/waypoint',
    });
    await flush();
    const tokenFile = (
      saveMcpServer.mock.calls[0][0] as { env: Record<string, string> }
    ).env.ULTRAFAST_OAUTH_TOKEN_FILE;
    expect(fs.existsSync(tokenFile)).toBe(true);

    // …then Copilot gets disconnected, and the next connection re-registers.
    getStoredSubscriptionTokenMock.mockReturnValue(null);
    supervisor.emit(stopped);
    supervisor.emit(running(2));
    await flush();
    const secondServer = saveMcpServer.mock.calls[1][0] as {
      env: Record<string, string>;
    };
    expect(secondServer.env.ULTRAFAST_OAUTH_TOKEN_FILE).toBeUndefined();
    // Not just absent from the env — the stale file itself is gone, so a
    // still-running MCP server process from before the disconnect (or any
    // other reader) can't find a disconnected account's token on disk.
    expect(fs.existsSync(tokenFile)).toBe(false);
  });

  it('registers nothing, silently, when no key is configured', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue(null);
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(saveMcpServer).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and registers nothing when uv is unavailable', async () => {
    findUvMock.mockReturnValue(null);
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(saveMcpServer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('uv is not available'),
    );
  });

  it('provisions in the background when not yet provisioned, then registers', async () => {
    isProvisionedMock.mockReturnValue(false);
    provisionPythonEnvMock.mockResolvedValue({
      ok: true,
      alreadyProvisioned: false,
    });
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(provisionPythonEnvMock).toHaveBeenCalledTimes(1);
    expect(saveMcpServer).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('provisioning ultrafast browser tasks'),
    );
  });

  it('does not register when provisioning fails, and retries on the next connection', async () => {
    isProvisionedMock.mockReturnValue(false);
    provisionPythonEnvMock.mockResolvedValueOnce({
      ok: false,
      message: 'uv venv failed',
    });
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(saveMcpServer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('provisioning its Python environment failed'),
      { message: 'uv venv failed' },
    );

    provisionPythonEnvMock.mockResolvedValueOnce({
      ok: true,
      alreadyProvisioned: false,
    });
    supervisor.emit(stopped);
    supervisor.emit(running(2));
    await flush();
    expect(saveMcpServer).toHaveBeenCalledTimes(1);
  });

  it('registers once per connection, not on a repeated status of the same connection', async () => {
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    supervisor.emit(running(1));
    await flush();
    expect(saveMcpServer).toHaveBeenCalledTimes(1);
  });

  it('warns and registers nothing when the MCP script is missing from this install', async () => {
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath: path.join(tmpRoot, 'nowhere'),
      resourcesPath: path.join(tmpRoot, 'nowhere-resources'),
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(saveMcpServer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('MCP server script is not installed'),
      expect.any(Object),
    );
  });

  it('stops listening when unsubscribed', async () => {
    const supervisor = fakeSupervisor(stopped);
    const off = registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    off();
    supervisor.emit(running(1));
    await flush();
    expect(saveMcpServer).not.toHaveBeenCalled();
  });
});

// F15 (tech-lead review, 2026-09-22): isUltrafastRegistered() is the
// single source of truth engineIpc.ts's own ultrafastAvailable() reads
// before offering browser_task in a brief — it must track whether
// saveMcpServer has actually resolved, not the four static
// ultrafastAvailability() gates, which all stay true through the exact
// window a session's daemon config might not have the tool yet.
describe('isUltrafastRegistered / reregisterUltrafastBrowser / unregisterUltrafastBrowser', () => {
  it('is false until a registration actually succeeds, true after', async () => {
    expect(isUltrafastRegistered()).toBe(false);
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(isUltrafastRegistered()).toBe(true);
  });

  it('goes false again when saveMcpServer fails', async () => {
    saveMcpServer.mockRejectedValueOnce(new Error('daemon rejected it'));
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(isUltrafastRegistered()).toBe(false);
  });

  // The exact scenario F15 names: a session pastes a key AFTER the daemon
  // is already connected. Before this fix, registration only ran on the
  // daemon's own per-connection cadence, so the tool would not appear
  // until the NEXT reconnect — a Fix dispatched on the connection that
  // was live when the key was saved would get a brief promising a tool
  // its session did not actually have.
  it('registers on the SAME connection once the key becomes available, via reregisterUltrafastBrowser — no new connection event needed', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue(null); // no key yet when the daemon connects
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(saveMcpServer).not.toHaveBeenCalled();
    expect(isUltrafastRegistered()).toBe(false);

    // The key is saved now — same connection (`running(1)`, never re-emitted).
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_key');
    reregisterUltrafastBrowser();
    await flush();
    expect(saveMcpServer).toHaveBeenCalledTimes(1);
    expect(isUltrafastRegistered()).toBe(true);
  });

  // F27 (round 2): saving a REPLACEMENT key on a connection that already
  // registered was swallowed by the "already registered on this
  // connection" guard, so `runtime-key` kept the revoked key — every task
  // went on sending it to TypeSafe while the settings page said "Ready"
  // — and a Clear followed by a Save left the feature unregistered until
  // the app restarted.
  it('a replacement key re-registers on the same connection and reaches the runtime file', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_OLD1');
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(saveMcpServer).toHaveBeenCalledTimes(1);
    const keyFile = path.join(userData, 'ultrafast', 'runtime-key');
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('ts_live_OLD1');

    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_NEW2');
    reregisterUltrafastBrowser();
    await flush();
    expect(saveMcpServer).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('ts_live_NEW2');
    expect(isUltrafastRegistered()).toBe(true);
  });

  // The other half of F27: Clear then Save, on one connection.
  it('recovers from a Clear followed by a Save without waiting for a reconnect', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_key');
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(isUltrafastRegistered()).toBe(true);

    unregisterUltrafastBrowser();
    expect(isUltrafastRegistered()).toBe(false);

    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_again');
    reregisterUltrafastBrowser();
    await flush();
    expect(isUltrafastRegistered()).toBe(true);
    expect(saveMcpServer).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when the daemon is not connected', async () => {
    const supervisor = fakeSupervisor(stopped);
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    reregisterUltrafastBrowser();
    await flush();
    expect(saveMcpServer).not.toHaveBeenCalled();
  });

  it('is a no-op before any registerUltrafastBrowser call has run', () => {
    expect(() => reregisterUltrafastBrowser()).not.toThrow();
  });

  it('unregisterUltrafastBrowser flips the flag immediately, without waiting for a reconnect', async () => {
    const supervisor = fakeSupervisor(running(1));
    registerUltrafastBrowser({
      supervisor,
      appPath,
      resourcesPath,
      userData,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(isUltrafastRegistered()).toBe(true);

    unregisterUltrafastBrowser();
    expect(isUltrafastRegistered()).toBe(false);
  });
});

describe('ultrafastAvailability', () => {
  it('reports every gate as a separate fact', () => {
    expect(ultrafastAvailability({ appPath, resourcesPath, userData })).toEqual(
      {
        keyConfigured: true,
        uvAvailable: true,
        provisioned: true,
        scriptsInstalled: true,
      },
    );
  });

  it('reports false facts truthfully when nothing is set up', () => {
    readStoredTypesafeApiKeyMock.mockReturnValue(null);
    findUvMock.mockReturnValue(null);
    isProvisionedMock.mockReturnValue(false);
    expect(
      ultrafastAvailability({
        appPath: '/nowhere',
        resourcesPath: '/nowhere-resources',
        userData,
      }),
    ).toEqual({
      keyConfigured: false,
      uvAvailable: false,
      provisioned: false,
      scriptsInstalled: false,
    });
  });
});
