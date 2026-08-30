import { EventEmitter } from 'events';

const ipcMainHandleMock = jest.fn();
const getPathMock = jest.fn(() => '/fake/userData');
const isEncryptionAvailableMock = jest.fn(() => true);
const encryptStringMock = jest.fn((s: string) => Buffer.from(`enc:${s}`));
const decryptStringMock = jest.fn((b: Buffer) =>
  b.toString().replace(/^enc:/, ''),
);

jest.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: { handle: ipcMainHandleMock },
  safeStorage: {
    isEncryptionAvailable: isEncryptionAvailableMock,
    encryptString: encryptStringMock,
    decryptString: decryptStringMock,
  },
}));

type FakeStdin = EventEmitter & {
  writes: string[];
  ended: boolean;
  write: (chunk: string) => boolean;
  end: () => void;
};

function makeFakeStdin(): FakeStdin {
  const emitter = new EventEmitter() as FakeStdin;
  emitter.writes = [];
  emitter.ended = false;
  emitter.write = (chunk: string) => {
    emitter.writes.push(chunk);
    return true;
  };
  emitter.end = () => {
    emitter.ended = true;
  };
  return emitter;
}

type FakeStream = EventEmitter & { setEncoding: jest.Mock; resume: jest.Mock };

function makeFakeStream(): FakeStream {
  return Object.assign(new EventEmitter(), {
    setEncoding: jest.fn(),
    resume: jest.fn(),
  });
}

type FakeChild = EventEmitter & {
  stdin: FakeStdin;
  stdout: FakeStream;
  stderr: FakeStream;
  kill: jest.Mock;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = makeFakeStdin();
  child.stdout = makeFakeStream();
  child.stderr = makeFakeStream();
  child.kill = jest.fn();
  return child;
}

let lastChild: FakeChild | null = null;
const spawnCalls: Array<{
  binary: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string | undefined> };
}> = [];
const spawnMock = jest.fn(
  (
    binary: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string | undefined> },
  ) => {
    lastChild = makeFakeChild();
    spawnCalls.push({ binary, args, options });
    return lastChild;
  },
);
jest.mock('child_process', () => ({
  spawn: (
    ...args: [
      string,
      string[],
      { cwd?: string; env?: Record<string, string | undefined> },
    ]
  ) => spawnMock(...args),
}));

const readFileSyncMock = jest.fn();
const writeFileSyncMock = jest.fn();
const unlinkSyncMock = jest.fn();
jest.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
}));

// Same hazard documented in preload.test.ts/copilotRunner.test.ts: this
// file's own `import { app, ipcMain, safeStorage } from 'electron'` must run
// only after the mocks/helpers above exist.
// eslint-disable-next-line import/order, import/first
import {
  getStoredSubscriptionToken,
  registerCopilotAuthIpc,
} from './copilotAuth';

const VALID_TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123';

function getHandler(channel: string) {
  const call = ipcMainHandleMock.mock.calls.find((c) => c[0] === channel);
  if (!call)
    throw new Error(`ipcMain.handle was never called with "${channel}"`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

function successJsonOutput() {
  return `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' })}\n`;
}

function rejectedJsonOutput() {
  return `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 401,
    result:
      'Failed to authenticate. API Error: 401 OAuth access token has expired.',
  })}\n`;
}

beforeEach(() => {
  jest.clearAllMocks();
  getPathMock.mockReturnValue('/fake/userData');
  isEncryptionAvailableMock.mockReturnValue(true);
  encryptStringMock.mockImplementation((s: string) => Buffer.from(`enc:${s}`));
  decryptStringMock.mockImplementation((b: Buffer) =>
    b.toString().replace(/^enc:/, ''),
  );
  spawnCalls.length = 0;
  lastChild = null;
  registerCopilotAuthIpc();
});

describe('getStoredSubscriptionToken', () => {
  it('returns null when no token file exists', () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(getStoredSubscriptionToken()).toBeNull();
  });

  it('decrypts and returns a stored token', () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        encrypted: Buffer.from(`enc:${VALID_TOKEN}`).toString('base64'),
      }),
    );
    expect(getStoredSubscriptionToken()).toBe(VALID_TOKEN);
  });

  it('returns null when the stored file is malformed JSON', () => {
    readFileSyncMock.mockReturnValue('{not valid json');
    expect(getStoredSubscriptionToken()).toBeNull();
  });

  it('returns null when encryption is unavailable, even with a file present', () => {
    isEncryptionAvailableMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        encrypted: Buffer.from(`enc:${VALID_TOKEN}`).toString('base64'),
      }),
    );
    expect(getStoredSubscriptionToken()).toBeNull();
  });
});

describe('copilot:auth:status', () => {
  it('reports disconnected with no stored token', async () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await getHandler('copilot:auth:status')({});
    expect(result).toEqual({ connected: false, last4: null });
  });

  it('reports connected with the last 4 characters, never the full token', async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        encrypted: Buffer.from(`enc:${VALID_TOKEN}`).toString('base64'),
      }),
    );
    const result = await getHandler('copilot:auth:status')({});
    expect(result).toEqual({ connected: true, last4: VALID_TOKEN.slice(-4) });
  });
});

describe('copilot:auth:save', () => {
  it('rejects a blank token without spawning anything', async () => {
    const result = await getHandler('copilot:auth:save')({}, '   ');
    expect(result).toEqual({ ok: false, message: 'Paste a token first.' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a non-subscription-token shape without spawning anything', async () => {
    const result = await getHandler('copilot:auth:save')(
      {},
      'sk-ant-api03-not-a-subscription-token',
    );
    expect((result as { ok: boolean }).ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses to save when secure storage is unavailable', async () => {
    isEncryptionAvailableMock.mockReturnValue(false);
    const result = await getHandler('copilot:auth:save')({}, VALID_TOKEN);
    expect((result as { ok: boolean }).ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('validates the token via a real isolated probe before saving, and saves on success', async () => {
    const promise = getHandler('copilot:auth:save')({}, VALID_TOKEN);
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnCalls).toHaveLength(1);
    // The probe env is isolated — only the candidate token, PATH, and proxy
    // vars — not the full ambient environment, so it can't be masked by an
    // already-logged-in CLI session.
    expect(spawnCalls[0].options.env).toEqual(
      expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: VALID_TOKEN }),
    );
    expect(spawnCalls[0].args).toEqual(
      expect.arrayContaining(['--tools', '', '--output-format', 'json']),
    );

    const child = lastChild as FakeChild;
    child.stdout.emit('data', successJsonOutput());
    child.emit('close', 0);

    const result = await promise;
    expect(result).toEqual({ ok: true, last4: VALID_TOKEN.slice(-4) });
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContents, writeOptions] =
      writeFileSyncMock.mock.calls[0];
    expect(writtenPath).toContain('copilot-auth.json');
    expect(writeOptions).toEqual({ mode: 0o600 });
    const stored = JSON.parse(writtenContents as string) as {
      encrypted: string;
    };
    expect(Buffer.from(stored.encrypted, 'base64').toString()).toBe(
      `enc:${VALID_TOKEN}`,
    );
  });

  it('does not save a token the probe rejects, and surfaces the real rejection reason', async () => {
    const promise = getHandler('copilot:auth:save')({}, VALID_TOKEN);
    await Promise.resolve();
    await Promise.resolve();

    const child = lastChild as FakeChild;
    child.stdout.emit('data', rejectedJsonOutput());
    child.emit('close', 0);

    const result = await promise;
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('401'),
    });
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('reports a clear message when the CLI is not installed (ENOENT)', async () => {
    const promise = getHandler('copilot:auth:save')({}, VALID_TOKEN);
    await Promise.resolve();
    await Promise.resolve();

    const child = lastChild as FakeChild;
    const enoent = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
    });
    child.emit('error', enoent);

    const result = await promise;
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("isn't installed"),
    });
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  // A locked keychain or a full disk previously rejected this invoke
  // outright rather than resolving — every caller's `await ...save(...)`
  // never settled the way it expected, stranding the UI (a modal stuck on
  // "Waiting for sign-in…", a manual-save button stuck on "Validating…")
  // with a validated-but-unsaved token silently discarded.
  it('reports a clear message, not a rejected promise, when writing the token fails', async () => {
    writeFileSyncMock.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const promise = getHandler('copilot:auth:save')({}, VALID_TOKEN);
    await Promise.resolve();
    await Promise.resolve();

    const child = lastChild as FakeChild;
    child.stdout.emit('data', successJsonOutput());
    child.emit('close', 0);

    await expect(promise).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('valid'),
    });
  });

  it("writes the prompt to stdin, not argv, matching copilotRunner.ts's own injection guard", async () => {
    const promise = getHandler('copilot:auth:save')({}, VALID_TOKEN);
    await Promise.resolve();
    await Promise.resolve();

    const child = lastChild as FakeChild;
    expect(child.stdin.writes.join('')).not.toBe('');
    expect(child.stdin.ended).toBe(true);
    expect(spawnCalls[0].args).not.toContain(child.stdin.writes.join(''));

    child.stdout.emit('data', successJsonOutput());
    child.emit('close', 0);
    await promise;
  });
});

describe('copilot:auth:clear', () => {
  it('deletes the stored token file', async () => {
    const result = await getHandler('copilot:auth:clear')({});
    expect(result).toEqual({ ok: true });
    expect(unlinkSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('copilot-auth.json'),
    );
  });

  it('is a no-op, not an error, when no token was ever saved', async () => {
    unlinkSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await getHandler('copilot:auth:clear')({});
    expect(result).toEqual({ ok: true });
  });
});
