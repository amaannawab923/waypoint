const getPathMock = jest.fn(() => '/fake/userData');
const getAppPathMock = jest.fn(() => '/fake/app');
const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();
jest.mock('electron', () => ({
  app: { getPath: getPathMock, getAppPath: getAppPathMock },
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
  },
}));

const readStoredTypesafeApiKeyMock = jest.fn<string | null, []>();
const writeStoredTypesafeApiKeyMock = jest.fn<void, [string]>();
const deleteStoredTypesafeApiKeyMock = jest.fn<void, []>();
const isUltrafastSecureStorageAvailableMock = jest.fn<boolean, []>(() => true);
jest.mock('./auth', () => ({
  readStoredTypesafeApiKey: () => readStoredTypesafeApiKeyMock(),
  writeStoredTypesafeApiKey: (k: string) => writeStoredTypesafeApiKeyMock(k),
  deleteStoredTypesafeApiKey: () => deleteStoredTypesafeApiKeyMock(),
  isUltrafastSecureStorageAvailable: () =>
    isUltrafastSecureStorageAvailableMock(),
  maskedTail: (k: string) => `…${k.slice(-4)}`,
}));

const findUvMock = jest.fn<string | null, []>();
const isProvisionedMock = jest.fn<boolean, [unknown]>();
const provisionPythonEnvMock = jest.fn<
  Promise<{ ok: boolean; message?: string }>,
  [unknown]
>();
const runCommandMock = jest.fn<
  Promise<{ code: number | null; stdout: string; stderr: string }>,
  [string, string[]]
>();
jest.mock('./pythonEnv', () => {
  const actual = jest.requireActual('./pythonEnv');
  return {
    ...actual,
    findUv: () => findUvMock(),
    isProvisioned: (paths: unknown) => isProvisionedMock(paths),
    provisionPythonEnv: (deps: unknown) => provisionPythonEnvMock(deps),
    runCommand: (cmd: string, args: string[]) => runCommandMock(cmd, args),
  };
});

const existsSyncMock = jest.fn<boolean, [string]>(() => true);
jest.mock('fs', () => ({
  existsSync: (p: string) => existsSyncMock(p),
  mkdirSync: jest.fn(),
}));

jest.mock('./scriptPaths', () => ({
  resolveUltrafastScriptPaths: () => ({
    mcpServerEntry: '/fake/app/scripts/ultrafast-mcp.js',
    runnerPath: '/fake/app/scripts/ultrafast/runner.py',
  }),
}));

const startTestPageMock = jest.fn(async () => ({
  url: 'http://127.0.0.1:9999',
  close: jest.fn(async () => {}),
}));
jest.mock('./testPage', () => ({
  startTestPage: () => startTestPageMock(),
}));

const callBrowserTaskMock = jest.fn();
jest.mock('./mcpClient', () => ({
  callBrowserTask: (args: unknown) => callBrowserTaskMock(args),
  parseSummaryLine: (result: {
    content: Array<{ type: string; text?: string }>;
  }) => {
    const text = result.content.find((c) => c.type === 'text')?.text ?? '';
    const m = /^status:\s*(\S+)\s*·\s*(\d+)\s*step/.exec(text);
    return m
      ? { status: m[1], steps: Number(m[2]) }
      : { status: null, steps: null };
  },
  summaryText: (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.find((c) => c.type === 'text')?.text ?? '',
  lastScreenshotDataUrl: (result: {
    content: Array<{ type: string; data?: string; mimeType?: string }>;
  }) => {
    const images = result.content.filter((c) => c.type === 'image');
    const last = images[images.length - 1];
    return last ? `data:${last.mimeType};base64,${last.data}` : null;
  },
}));

// eslint-disable-next-line import/order, import/first
import { ULTRAFAST_IPC } from './ipcTypes';
// eslint-disable-next-line import/order, import/first
import { resetUltrafastIpcStateForTests, registerUltrafastIpc } from './ipc';

function invoke(channel: string, ...args: unknown[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({}, ...args);
}

beforeEach(() => {
  jest.clearAllMocks();
  handlers.clear();
  isUltrafastSecureStorageAvailableMock.mockReturnValue(true);
  existsSyncMock.mockReturnValue(true);
  resetUltrafastIpcStateForTests();
  registerUltrafastIpc();
});

describe('ultrafast:get-status', () => {
  it('aggregates key/uv/provisioned facts and the last test', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_abcd1234');
    findUvMock.mockReturnValue('/opt/homebrew/bin/uv');
    isProvisionedMock.mockReturnValue(true);
    const status = await invoke(ULTRAFAST_IPC.status);
    expect(status).toEqual({
      uvAvailable: true,
      provisioned: true,
      key: { configured: true, tail: '…1234' },
      lastTest: null,
    });
  });

  it('reports an unconfigured key honestly', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue(null);
    findUvMock.mockReturnValue(null);
    isProvisionedMock.mockReturnValue(false);
    const status = await invoke(ULTRAFAST_IPC.status);
    expect(status).toEqual({
      uvAvailable: false,
      provisioned: false,
      key: { configured: false, tail: null },
      lastTest: null,
    });
  });
});

describe('ultrafast:save-key', () => {
  it('refuses an empty key', async () => {
    const result = await invoke(ULTRAFAST_IPC.saveKey, '   ');
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('Paste a key'),
    });
    expect(writeStoredTypesafeApiKeyMock).not.toHaveBeenCalled();
  });

  it('refuses to save when secure storage is unavailable', async () => {
    isUltrafastSecureStorageAvailableMock.mockReturnValue(false);
    const result = await invoke(ULTRAFAST_IPC.saveKey, 'ts_live_key');
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('Secure storage'),
    });
  });

  it('saves a trimmed key and returns its masked tail', async () => {
    const result = await invoke(ULTRAFAST_IPC.saveKey, '  ts_live_abcd1234  ');
    expect(writeStoredTypesafeApiKeyMock).toHaveBeenCalledWith(
      'ts_live_abcd1234',
    );
    expect(result).toEqual({ ok: true, tail: '…1234' });
  });

  it('reports a write failure without throwing', async () => {
    writeStoredTypesafeApiKeyMock.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    const result = await invoke(ULTRAFAST_IPC.saveKey, 'ts_live_abcd1234');
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("couldn't be saved"),
    });
  });
});

describe('ultrafast:clear-key', () => {
  it('deletes the stored key and clears the last test', async () => {
    const result = await invoke(ULTRAFAST_IPC.clearKey);
    expect(deleteStoredTypesafeApiKeyMock).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
    readStoredTypesafeApiKeyMock.mockReturnValue(null);
    findUvMock.mockReturnValue(null);
    isProvisionedMock.mockReturnValue(false);
    expect(
      (await invoke(ULTRAFAST_IPC.status)) as { lastTest: unknown },
    ).toMatchObject({ lastTest: null });
  });
});

describe('ultrafast:test', () => {
  it('fails fast, honestly, when no key is configured', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue(null);
    const result = await invoke(ULTRAFAST_IPC.test);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('TypeSafe API key'),
    });
    expect(findUvMock).not.toHaveBeenCalled();
  });

  it('fails when uv is unavailable', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_abcd1234');
    findUvMock.mockReturnValue(null);
    const result = await invoke(ULTRAFAST_IPC.test);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('uv'),
    });
  });

  it('provisions when not yet provisioned, and surfaces a provisioning failure', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_abcd1234');
    findUvMock.mockReturnValue('/opt/homebrew/bin/uv');
    isProvisionedMock.mockReturnValue(false);
    provisionPythonEnvMock.mockResolvedValue({
      ok: false,
      message: 'uv venv failed',
    });
    const result = await invoke(ULTRAFAST_IPC.test);
    expect(provisionPythonEnvMock).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, message: 'uv venv failed' });
  });

  it('surfaces a failing self-test', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_abcd1234');
    findUvMock.mockReturnValue('/opt/homebrew/bin/uv');
    isProvisionedMock.mockReturnValue(true);
    runCommandMock.mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'ModuleNotFoundError',
    });
    const result = await invoke(ULTRAFAST_IPC.test);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('self-test'),
    });
    expect(startTestPageMock).not.toHaveBeenCalled();
  });

  it('runs the real task against the test page on success, and remembers it as lastTest', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_abcd1234');
    findUvMock.mockReturnValue('/opt/homebrew/bin/uv');
    isProvisionedMock.mockReturnValue(true);
    runCommandMock.mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    callBrowserTaskMock.mockResolvedValue({
      isError: false,
      content: [
        {
          type: 'text',
          text: 'status: done · 2 step(s) · 640ms · 2 jev decision(s) · 1 text call(s)',
        },
        { type: 'image', data: 'AAA', mimeType: 'image/jpeg' },
      ],
    });

    const result = await invoke(ULTRAFAST_IPC.test);
    expect(callBrowserTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://127.0.0.1:9999', maxSteps: 6 }),
    );
    expect(result).toMatchObject({
      ok: true,
      status: 'done',
      steps: 2,
      screenshotDataUrl: 'data:image/jpeg;base64,AAA',
    });

    const status = await invoke(ULTRAFAST_IPC.status);
    expect((status as { lastTest: unknown }).lastTest).toMatchObject({
      ok: true,
      status: 'done',
    });
  });

  it('closes the test page even when callBrowserTask throws', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_abcd1234');
    findUvMock.mockReturnValue('/opt/homebrew/bin/uv');
    isProvisionedMock.mockReturnValue(true);
    runCommandMock.mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    const close = jest.fn(async () => {});
    startTestPageMock.mockResolvedValue({
      url: 'http://127.0.0.1:9999',
      close,
    });
    callBrowserTaskMock.mockRejectedValue(new Error('timed out'));

    const result = await invoke(ULTRAFAST_IPC.test);
    expect(result).toMatchObject({ ok: false, message: 'timed out' });
    expect(close).toHaveBeenCalled();
  });
});
