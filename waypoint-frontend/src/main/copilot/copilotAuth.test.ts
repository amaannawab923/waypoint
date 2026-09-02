import * as os from 'os';
import type { Options, Query, SDKMessage } from './claudeSdkClient';

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

// The probe now runs through the same SDK seam the runner does, so it mocks
// the same one module — the real (pure-ESM) package is never loaded by a
// test. See copilotRunner.test.ts for the same fake-generator shape.
type FakeQuery = {
  query: Query;
  emit: (message: SDKMessage) => void;
  end: () => void;
  closeMock: jest.Mock;
};

function makeFakeQuery(): FakeQuery {
  const queue: SDKMessage[] = [];
  let finished = false;
  let notify: (() => void) | null = null;
  const wake = () => {
    const resume = notify;
    notify = null;
    resume?.();
  };

  const closeMock = jest.fn(() => {
    finished = true;
    wake();
  });

  const waitForWake = () =>
    new Promise<void>((resolve) => {
      notify = resolve;
    });

  const query = {
    close: closeMock,
    async next(): Promise<IteratorResult<SDKMessage, void>> {
      while (!queue.length && !finished) {
        // eslint-disable-next-line no-await-in-loop
        await waitForWake();
      }
      if (queue.length) {
        return { value: queue.shift() as SDKMessage, done: false };
      }
      return { value: undefined, done: true };
    },
    async return(): Promise<IteratorResult<SDKMessage, void>> {
      finished = true;
      return { value: undefined, done: true };
    },
    async throw(err: unknown): Promise<IteratorResult<SDKMessage, void>> {
      throw err;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as unknown as Query;

  return {
    query,
    closeMock,
    emit: (message: SDKMessage) => {
      queue.push(message);
      wake();
    },
    end: () => {
      finished = true;
      wake();
    },
  };
}

const queries: FakeQuery[] = [];
const runCopilotQueryMock = jest.fn<
  Promise<Query>,
  [{ prompt: string; options: Options }]
>(async () => {
  const fake = makeFakeQuery();
  queries.push(fake);
  return fake.query;
});
jest.mock('./claudeSdkClient', () => ({
  runCopilotQuery: (args: { prompt: string; options: Options }) =>
    runCopilotQueryMock(args),
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

// Fixtures name only the fields parseSdkMessage discriminates on; see
// parseSdkMessage.test.ts for why the cast is the local escape hatch.
function sdkMessage(fields: Record<string, unknown>): SDKMessage {
  return fields as unknown as SDKMessage;
}

function successResult() {
  return sdkMessage({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'OK',
  });
}

// A rejected token comes back as the SUCCESS subtype with is_error set — the
// real shape, verified live, and the reason parseSdkMessage checks is_error
// before the subtype.
function rejectedResult() {
  return sdkMessage({
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 401,
    result:
      'Failed to authenticate. API Error: 401 OAuth access token has expired.',
  });
}

// The probe drives an async generator, so assertions about what it did with a
// message have to let the microtask queue drain first.
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  getPathMock.mockReturnValue('/fake/userData');
  isEncryptionAvailableMock.mockReturnValue(true);
  encryptStringMock.mockImplementation((s: string) => Buffer.from(`enc:${s}`));
  decryptStringMock.mockImplementation((b: Buffer) =>
    b.toString().replace(/^enc:/, ''),
  );
  queries.length = 0;
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
  it('rejects a blank token without running anything', async () => {
    const result = await getHandler('copilot:auth:save')({}, '   ');
    expect(result).toEqual({ ok: false, message: 'Paste a token first.' });
    expect(runCopilotQueryMock).not.toHaveBeenCalled();
  });

  it('rejects a non-subscription-token shape without running anything', async () => {
    const result = await getHandler('copilot:auth:save')(
      {},
      'sk-ant-api03-not-a-subscription-token',
    );
    expect((result as { ok: boolean }).ok).toBe(false);
    expect(runCopilotQueryMock).not.toHaveBeenCalled();
  });

  it('refuses to save when secure storage is unavailable', async () => {
    isEncryptionAvailableMock.mockReturnValue(false);
    const result = await getHandler('copilot:auth:save')({}, VALID_TOKEN);
    expect((result as { ok: boolean }).ok).toBe(false);
    expect(runCopilotQueryMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('validates the token via a real isolated probe before saving, and saves on success', async () => {
    const promise = getHandler('copilot:auth:save')({}, VALID_TOKEN);
    await flush();

    expect(runCopilotQueryMock).toHaveBeenCalledTimes(1);
    const { options } = runCopilotQueryMock.mock.calls[0][0];
    // The probe env is isolated — only the candidate token, CLAUDE_CONFIG_DIR,
    // PATH, and proxy vars — not the full ambient environment, so it can't be
    // masked by an already-logged-in session.
    expect(options.env).toEqual(
      expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: VALID_TOKEN }),
    );
    // Matches copilotRunner.ts's own gating: once this token is connected,
    // every real run sets CLAUDE_CONFIG_DIR alongside CLAUDE_CODE_OAUTH_TOKEN
    // (see copilotRunner.test.ts), so the probe must validate the token
    // under that same redirected config/credential namespace.
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(
      '/fake/userData/copilot-claude-config',
    );
    // No tool access is needed for a "reply with OK" round trip, and the
    // probe holds the same settings isolation the real runner does rather
    // than the weaker CLI --safe-mode posture it used to pass.
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.cwd).toBe(os.tmpdir());

    queries[0].emit(successResult());
    queries[0].end();

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
    await flush();

    queries[0].emit(rejectedResult());
    queries[0].end();

    const result = await promise;
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('401'),
    });
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('surfaces an authentication failure reported mid-stream rather than waiting for a result', async () => {
    const promise = getHandler('copilot:auth:save')({}, VALID_TOKEN);
    await flush();

    queries[0].emit(
      sdkMessage({
        type: 'system',
        subtype: 'api_retry',
        error: 'authentication_failed',
      }),
    );

    await expect(promise).resolves.toEqual({
      ok: false,
      message: expect.stringMatching(/claude login/i),
    });
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  // The runtime failing to start at all no longer means "the CLI isn't
  // installed" — nothing looks a binary up on PATH any more — so the probe
  // simply reports whatever the failure actually was.
  it('reports the underlying reason when the runtime cannot start at all', async () => {
    runCopilotQueryMock.mockRejectedValueOnce(
      new Error('spawn /app.asar/claude ENOTDIR'),
    );
    const promise = getHandler('copilot:auth:save')({}, VALID_TOKEN);

    const result = await promise;
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('ENOTDIR'),
    });
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  // A stream that ends with no terminal result proves nothing about the
  // token, so it must not be saved on the strength of "nothing went wrong".
  it('does not save a token when the probe stream ends without a result', async () => {
    const promise = getHandler('copilot:auth:save')({}, VALID_TOKEN);
    await flush();

    queries[0].end();

    const result = await promise;
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("Couldn't validate the token"),
    });
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  // The rewritten Promise.race/query?.close()/finally{clearTimeout} shape is
  // new in this migration (the old version was a plain setTimeout +
  // child.kill() inside a promise executor) and has a real closure-capture
  // hazard worth covering directly: `query` is declared before run() starts
  // and assigned only once runCopilotQuery resolves, so the timeout callback
  // reads whatever `query` holds AT THE MOMENT it fires, not a snapshot from
  // when the timer was set.
  it('times out and closes the probe query when it never produces a result', async () => {
    jest.useFakeTimers();
    try {
      const promise = getHandler('copilot:auth:save')({}, VALID_TOKEN);
      // Let runCopilotQuery's own promise resolve so `query` is actually
      // assigned before the timeout fires — otherwise this would only prove
      // the timeout resolves, not that it closes the right thing.
      await Promise.resolve();
      await Promise.resolve();

      await jest.advanceTimersByTimeAsync(20_000);

      const result = await promise;
      expect(result).toEqual({
        ok: false,
        message: 'Timed out validating the token.',
      });
      expect(queries[0].closeMock).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
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
    await flush();

    queries[0].emit(successResult());
    queries[0].end();

    await expect(promise).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('valid'),
    });
  });

  it('sends the probe question as the query prompt, never as an option', async () => {
    const promise = getHandler('copilot:auth:save')({}, VALID_TOKEN);
    await flush();

    const { prompt, options } = runCopilotQueryMock.mock.calls[0][0];
    expect(prompt).not.toBe('');
    expect(JSON.stringify(options)).not.toContain(prompt);

    queries[0].emit(successResult());
    queries[0].end();
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
