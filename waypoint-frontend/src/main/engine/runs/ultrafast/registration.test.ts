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
jest.mock('./auth', () => ({
  readStoredTypesafeApiKey: () => readStoredTypesafeApiKeyMock(),
}));

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
  registerUltrafastBrowser,
  ultrafastAvailability,
} from './registration';

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
    expect(server.env.ULTRAFAST_TYPESAFE_API_KEY).toBe('ts_live_key');
    expect(server.env.ULTRAFAST_RUNNER_PATH).toBe(
      path.join(resourcesPath, 'scripts', 'ultrafast', 'runner.py'),
    );
    expect(server.providers).toEqual(['claude']);
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
