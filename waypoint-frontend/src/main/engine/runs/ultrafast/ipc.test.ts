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
const envKeyMock = jest.fn<string | null, []>(() => null);
const writeStoredTypesafeApiKeyMock = jest.fn<void, [string]>();
const deleteStoredTypesafeApiKeyMock = jest.fn<void, []>();
const isUltrafastSecureStorageAvailableMock = jest.fn<boolean, []>(() => true);
jest.mock('./auth', () => ({
  readStoredTypesafeApiKey: () => readStoredTypesafeApiKeyMock(),
  resolveTypesafeApiKey: () => {
    const stored = readStoredTypesafeApiKeyMock();
    if (stored) return { key: stored, source: 'settings' };
    const env = envKeyMock();
    return env ? { key: env, source: 'env' } : null;
  },
  writeStoredTypesafeApiKey: (k: string) => writeStoredTypesafeApiKeyMock(k),
  deleteStoredTypesafeApiKey: () => deleteStoredTypesafeApiKeyMock(),
  isUltrafastSecureStorageAvailable: () =>
    isUltrafastSecureStorageAvailableMock(),
  maskedTail: (k: string) => `…${k.slice(-4)}`,
  // F1: runSelfTest/runUltrafastTest call the REAL registration.ts (not
  // mocked in this file), whose buildServerEnv now writes the key to a
  // runtime file via these two — this file's own `fs` mock below has no
  // writeFileSync/chmodSync/unlinkSync for a real implementation to call,
  // and this file's tests care about the orchestration flow, not the
  // runtime-file mechanism itself (covered separately by auth.test.ts and
  // registration.test.ts), so these are plain no-ops here.
  writeRuntimeSecretFile: jest.fn(),
  removeRuntimeSecretFile: jest.fn(),
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

// F20 (tech-lead review, 2026-09-22): defaults to a matching greeting so
// every existing "success" test keeps meaning success without change;
// F20's own new tests override `greeting` per case to prove
// runUltrafastTest() no longer trusts jev's status alone.
const testPageGreetingMock = jest.fn<string | null, []>(() => 'Hello, Ada!');
const startTestPageMock = jest.fn(async () => ({
  url: 'http://127.0.0.1:9999',
  close: jest.fn(async () => {}),
  greeting: () => testPageGreetingMock(),
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

// F15 (tech-lead review, 2026-09-22): saveKey/clearKey now call these two
// directly. buildServerEnv (used by runUltrafastTest, below) stays real —
// only the registration-triggering calls are spied on, so this file can
// assert ipc.ts actually calls them without standing up a real daemon
// connection (that's registration.test.ts's own job).
const reregisterUltrafastBrowserMock = jest.fn();
const unregisterUltrafastBrowserMock = jest.fn();
jest.mock('./registration', () => {
  const actual = jest.requireActual('./registration');
  return {
    ...actual,
    reregisterUltrafastBrowser: () => reregisterUltrafastBrowserMock(),
    unregisterUltrafastBrowser: () => unregisterUltrafastBrowserMock(),
  };
});

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
  it('aggregates key/uv/provisioned/scripts/registered facts and the last test', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_abcd1234');
    findUvMock.mockReturnValue('/opt/homebrew/bin/uv');
    isProvisionedMock.mockReturnValue(true);
    const status = await invoke(ULTRAFAST_IPC.status);
    expect(status).toEqual({
      uvAvailable: true,
      provisioned: true,
      // existsSyncMock defaults to true in beforeEach — both scripts "exist".
      scriptsInstalled: true,
      // Nothing in this test file has called registerUltrafastBrowser, so
      // registration.ts's own isUltrafastRegistered() is honestly false —
      // every other gate can pass while this stays false, which is
      // exactly the fact F19 added this field to surface.
      registered: false,
      key: { configured: true, tail: '…1234', source: 'settings' },
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
      scriptsInstalled: true,
      registered: false,
      key: { configured: false, tail: null, source: null },
      lastTest: null,
    });
  });

  // F19 (tech-lead review, 2026-09-22): scriptsInstalled existed as a fact
  // (ultrafastAvailability()) but never reached the renderer — a missing-
  // scripts install (a bad build, extraResources not copied) could satisfy
  // key/uv/provisioned and still never explain why the tool doesn't work.
  it('reports missing scripts honestly, independent of every other gate', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_abcd1234');
    findUvMock.mockReturnValue('/opt/homebrew/bin/uv');
    isProvisionedMock.mockReturnValue(true);
    existsSyncMock.mockReturnValue(false);
    const status = (await invoke(ULTRAFAST_IPC.status)) as {
      scriptsInstalled: boolean;
    };
    expect(status.scriptsInstalled).toBe(false);
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
    // F15: a saved key forces a fresh registration attempt immediately —
    // not just written and left for whatever daemon reconnect happens
    // next — so a Fix dispatched on the same connection sees
    // browser_task in its very first brief.
    expect(reregisterUltrafastBrowserMock).toHaveBeenCalledTimes(1);
  });

  it('reports a write failure without throwing, and does not attempt to register a key that never saved', async () => {
    writeStoredTypesafeApiKeyMock.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    const result = await invoke(ULTRAFAST_IPC.saveKey, 'ts_live_abcd1234');
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("couldn't be saved"),
    });
    expect(reregisterUltrafastBrowserMock).not.toHaveBeenCalled();
  });

  it('does not attempt to register an empty or refused key', async () => {
    await invoke(ULTRAFAST_IPC.saveKey, '   ');
    isUltrafastSecureStorageAvailableMock.mockReturnValue(false);
    await invoke(ULTRAFAST_IPC.saveKey, 'ts_live_abcd1234');
    expect(reregisterUltrafastBrowserMock).not.toHaveBeenCalled();
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

  // F15: isUltrafastRegistered() (and so engineIpc.ts's own
  // ultrafastAvailable) must reflect a cleared key immediately, not stay
  // stuck reporting "yes" until the daemon happens to reconnect.
  it('unregisters immediately, not just on the next daemon reconnect', async () => {
    await invoke(ULTRAFAST_IPC.clearKey);
    expect(unregisterUltrafastBrowserMock).toHaveBeenCalledTimes(1);
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

  // F20 (tech-lead review, 2026-09-22): the exact scenario the finding
  // named — a run that clicks Continue without ever typing a name (the
  // field defaults to "there") still reports jev's own `status: done`
  // with `isError: false`. Before this fix, `ok: !result.isError` alone
  // made that a green Test result.
  it('reports failure when jev claims done but the page never actually greeted Ada', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_abcd1234');
    findUvMock.mockReturnValue('/opt/homebrew/bin/uv');
    isProvisionedMock.mockReturnValue(true);
    runCommandMock.mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    testPageGreetingMock.mockReturnValueOnce('Hello, there!');
    callBrowserTaskMock.mockResolvedValue({
      isError: false,
      content: [
        {
          type: 'text',
          text: 'status: done · 1 step(s) · 300ms · 1 jev decision(s) · 0 text call(s)',
        },
      ],
    });

    const result = await invoke(ULTRAFAST_IPC.test);
    expect(result).toMatchObject({
      ok: false,
      status: 'done',
      message: expect.stringContaining('never actually greeted Ada'),
    });
    expect((result as { message: string }).message).toContain(
      'it said "Hello, there!"',
    );
  });

  it('reports failure when jev claims done but the page recorded no greeting at all', async () => {
    readStoredTypesafeApiKeyMock.mockReturnValue('ts_live_abcd1234');
    findUvMock.mockReturnValue('/opt/homebrew/bin/uv');
    isProvisionedMock.mockReturnValue(true);
    runCommandMock.mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    testPageGreetingMock.mockReturnValueOnce(null);
    callBrowserTaskMock.mockResolvedValue({
      isError: false,
      content: [
        {
          type: 'text',
          text: 'status: blocked · 3 step(s) · 900ms · 3 jev decision(s) · 1 text call(s)',
        },
      ],
    });

    const result = await invoke(ULTRAFAST_IPC.test);
    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      message: expect.stringContaining('no greeting was recorded at all'),
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
      // callBrowserTask rejects below, so runUltrafastTest never reaches
      // page.greeting() — this is here only to satisfy TestPageHandle's
      // shape.
      greeting: () => null,
    });
    callBrowserTaskMock.mockRejectedValue(new Error('timed out'));

    const result = await invoke(ULTRAFAST_IPC.test);
    expect(result).toMatchObject({ ok: false, message: 'timed out' });
    expect(close).toHaveBeenCalled();
  });
});
