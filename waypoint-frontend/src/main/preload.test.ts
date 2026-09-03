const ipcRendererMock = {
  send: jest.fn(),
  on: jest.fn(),
  once: jest.fn(),
  removeListener: jest.fn(),
  invoke: jest.fn(),
};

const exposeInMainWorldMock = jest.fn();

jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeInMainWorldMock },
  ipcRenderer: ipcRendererMock,
}));

// Regression harness for the "Illegal invocation" bug: Crypto.prototype.randomUUID
// is a native method that requires its `crypto` receiver. jsdom's own
// crypto.randomUUID doesn't reliably exist in this test environment, so a
// real-implementation test wouldn't actually exercise the invariant that
// broke — this stub does, by throwing exactly like the real thing does when
// called with the wrong `this` (e.g. via `const { randomUUID } = crypto`,
// which is precisely the regression this guards against).
let uuidCounter = 0;
const receiverCheckingCrypto = {
  randomUUID: jest.fn(function randomUUID(this: unknown) {
    if (this !== receiverCheckingCrypto) {
      throw new TypeError('Illegal invocation');
    }
    uuidCounter += 1;
    return `mock-uuid-${uuidCounter}`;
  }),
};
// A plain assignment silently no-ops here: jsdom defines `globalThis.crypto`
// via a getter (confirmed via Object.getOwnPropertyDescriptor), and
// assigning to a getter-only accessor property is a silent non-strict-mode
// failure, not a throw. It is configurable, so defineProperty overrides it.
// globalThis is standard ES2020; this project's eslint env just doesn't have
// it in its globals list yet.
// eslint-disable-next-line no-undef
Object.defineProperty(globalThis, 'crypto', {
  value: receiverCheckingCrypto,
  configurable: true,
  writable: true,
});

// Deliberately NOT hoisted to the top of the file (and exempted from
// import/order's auto-fix, which would otherwise move it back and reintroduce
// this exact bug): preload.ts has a module-level side effect
// (exposeInMainWorld, calling crypto.randomUUID indirectly through
// electronHandler) that must run only after the electron/crypto mocks above
// are fully set up. An import hoisted above them would run preload.ts's
// import of 'electron' first, triggering the jest.mock('electron', ...)
// factory before exposeInMainWorldMock exists yet — a temporal-dead-zone
// ReferenceError, confirmed by hitting it live after eslint's own
// auto-fix moved this import to the top once already.
// eslint-disable-next-line import/order, import/first
import './preload';

type RunPromptHandlers = {
  onChunk: (text: string) => void;
  onDone: (result: {
    fullText: string;
    sessionId: string | null;
    needsRepoLink: boolean;
  }) => void;
  onError: (err: { kind: string; message: string }) => void;
};

// Captured once, before any beforeEach clearing: preload.ts's module-level
// contextBridge.exposeInMainWorld(...) call only ever happens the one time
// this file is imported above — jest.clearAllMocks() in beforeEach (needed
// to reset ipcRendererMock's call history between tests) would otherwise
// also wipe exposeInMainWorldMock's one recorded call before any test body
// gets a chance to read it.
function getElectronHandler() {
  const call = exposeInMainWorldMock.mock.calls.find(
    (c) => c[0] === 'electron',
  );
  if (!call)
    throw new Error(
      'contextBridge.exposeInMainWorld was never called with "electron"',
    );
  return call[1] as {
    ipcRenderer: {
      sendMessage: (channel: string, ...args: unknown[]) => void;
      on: (channel: string, func: (...args: unknown[]) => void) => () => void;
      once: (channel: string, func: (...args: unknown[]) => void) => void;
    };
    copilot: {
      runPrompt: (
        args: { prompt: string; resumeSessionId?: string; repoPath?: string },
        handlers: RunPromptHandlers,
      ) => () => void;
    };
    repo: {
      chooseFolder: (opts?: {
        defaultPath?: string;
        title?: string;
        message?: string;
      }) => Promise<
        | { canceled: true }
        | { canceled: false; path: string; looksLikeGitRepo: boolean }
      >;
      checkPath: (repoPath: string) => Promise<{ exists: boolean }>;
      describe: (repoPath: string) => Promise<unknown>;
    };
  };
}

const electronHandler = getElectronHandler();

function getRegisteredStreamListener(): (
  event: unknown,
  payload: unknown,
) => void {
  const call = ipcRendererMock.on.mock.calls.find(
    (c) => c[0] === 'copilot:stream',
  );
  if (!call)
    throw new Error('ipcRenderer.on was never called with "copilot:stream"');
  return call[1];
}

beforeEach(() => {
  jest.clearAllMocks();
  uuidCounter = 0;
});

describe('electronHandler.copilot.runPrompt', () => {
  it('generates its requestId by calling crypto.randomUUID() properly bound, not destructured', () => {
    // The regression this exists to catch: `const { randomUUID } = crypto`
    // would call receiverCheckingCrypto.randomUUID with `this` set to
    // something other than receiverCheckingCrypto, throwing here. If
    // preload.ts calls it as `crypto.randomUUID()` (bound), this succeeds.
    expect(() => {
      electronHandler.copilot.runPrompt(
        { prompt: 'hi' },
        { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
      );
    }).not.toThrow();

    expect(receiverCheckingCrypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('sends copilot:run with the prompt, resumeSessionId, and a fresh requestId', () => {
    electronHandler.copilot.runPrompt(
      { prompt: 'what is my sprint status', resumeSessionId: 'sess-abc' },
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
    );

    expect(ipcRendererMock.send).toHaveBeenCalledWith('copilot:run', {
      requestId: 'mock-uuid-1',
      prompt: 'what is my sprint status',
      resumeSessionId: 'sess-abc',
    });
  });

  it('omits resumeSessionId when none is given (first message in a conversation)', () => {
    electronHandler.copilot.runPrompt(
      { prompt: 'hi' },
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
    );

    expect(ipcRendererMock.send).toHaveBeenCalledWith('copilot:run', {
      requestId: 'mock-uuid-1',
      prompt: 'hi',
    });
  });

  it('registers a copilot:stream listener and routes a matching chunk event to onChunk', () => {
    const onChunk = jest.fn();

    electronHandler.copilot.runPrompt(
      { prompt: 'hi' },
      { onChunk, onDone: jest.fn(), onError: jest.fn() },
    );
    const listener = getRegisteredStreamListener();

    listener({}, { requestId: 'mock-uuid-1', type: 'chunk', text: 'Hello ' });

    expect(onChunk).toHaveBeenCalledWith('Hello ');
  });

  it('routes a matching done event to onDone, defaulting a missing sessionId to null', () => {
    const onDone = jest.fn();

    electronHandler.copilot.runPrompt(
      { prompt: 'hi' },
      { onChunk: jest.fn(), onDone, onError: jest.fn() },
    );
    const listener = getRegisteredStreamListener();

    listener(
      {},
      { requestId: 'mock-uuid-1', type: 'done', fullText: 'the full reply' },
    );

    expect(onDone).toHaveBeenCalledWith({
      fullText: 'the full reply',
      sessionId: null,
      needsRepoLink: false,
    });
  });

  // needsRepoLink drives UI (the in-chat "link a repo" card), so a payload
  // that omits it — or carries anything other than a literal true — must
  // normalize to false rather than reaching the renderer as undefined.
  it('normalizes needsRepoLink to a strict boolean on the done payload', () => {
    const onDone = jest.fn();

    electronHandler.copilot.runPrompt(
      { prompt: 'hi' },
      { onChunk: jest.fn(), onDone, onError: jest.fn() },
    );
    const listener = getRegisteredStreamListener();

    listener(
      {},
      {
        requestId: 'mock-uuid-1',
        type: 'done',
        fullText: 'reply',
        sessionId: 'sess-1',
        needsRepoLink: true,
      },
    );

    expect(onDone).toHaveBeenCalledWith({
      fullText: 'reply',
      sessionId: 'sess-1',
      needsRepoLink: true,
    });
  });

  it('forwards repoPath on copilot:run when the caller supplies one, and omits it otherwise', () => {
    electronHandler.copilot.runPrompt(
      { prompt: 'hi', repoPath: '/Users/amaan/code/waypoint' },
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
    );

    expect(ipcRendererMock.send).toHaveBeenCalledWith(
      'copilot:run',
      expect.objectContaining({ repoPath: '/Users/amaan/code/waypoint' }),
    );

    ipcRendererMock.send.mockClear();
    electronHandler.copilot.runPrompt(
      { prompt: 'hi' },
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
    );

    expect(ipcRendererMock.send.mock.calls[0][1]).not.toHaveProperty('repoPath');
  });

  it('routes a matching error event to onError, defaulting kind and message when absent', () => {
    const onError = jest.fn();

    electronHandler.copilot.runPrompt(
      { prompt: 'hi' },
      { onChunk: jest.fn(), onDone: jest.fn(), onError },
    );
    const listener = getRegisteredStreamListener();

    listener({}, { requestId: 'mock-uuid-1', type: 'error' });

    expect(onError).toHaveBeenCalledWith({
      kind: 'generic',
      message: 'Unknown error',
    });
  });

  // Regression coverage for requestId correlation: without it, a second
  // concurrent run's events could be misattributed to the first caller's
  // handlers (or vice versa).
  it('ignores stream events for a different requestId, so concurrent runs cannot cross-talk', () => {
    const onChunkFirst = jest.fn();
    const onChunkSecond = jest.fn();

    electronHandler.copilot.runPrompt(
      { prompt: 'first' },
      { onChunk: onChunkFirst, onDone: jest.fn(), onError: jest.fn() },
    );
    electronHandler.copilot.runPrompt(
      { prompt: 'second' },
      { onChunk: onChunkSecond, onDone: jest.fn(), onError: jest.fn() },
    );

    const [, firstListener] = ipcRendererMock.on.mock.calls[0];
    const [, secondListener] = ipcRendererMock.on.mock.calls[1];

    // Fire the SECOND run's payload at the FIRST run's listener — it must
    // not call the first run's onChunk.
    firstListener(
      {},
      { requestId: 'mock-uuid-2', type: 'chunk', text: 'for the second run' },
    );
    expect(onChunkFirst).not.toHaveBeenCalled();

    secondListener(
      {},
      { requestId: 'mock-uuid-2', type: 'chunk', text: 'for the second run' },
    );
    expect(onChunkSecond).toHaveBeenCalledWith('for the second run');
  });

  it('removes its own listener once a done event arrives, without waiting on the caller to unsubscribe', () => {
    electronHandler.copilot.runPrompt(
      { prompt: 'hi' },
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
    );
    const listener = getRegisteredStreamListener();

    listener({}, { requestId: 'mock-uuid-1', type: 'done', fullText: 'ok' });

    expect(ipcRendererMock.removeListener).toHaveBeenCalledWith(
      'copilot:stream',
      listener,
    );
  });

  it('removes its own listener once an error event arrives, without waiting on the caller to unsubscribe', () => {
    electronHandler.copilot.runPrompt(
      { prompt: 'hi' },
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
    );
    const listener = getRegisteredStreamListener();

    listener({}, { requestId: 'mock-uuid-1', type: 'error' });

    expect(ipcRendererMock.removeListener).toHaveBeenCalledWith(
      'copilot:stream',
      listener,
    );
  });

  it('does not remove its listener for a chunk event — only done/error are terminal', () => {
    electronHandler.copilot.runPrompt(
      { prompt: 'hi' },
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
    );
    const listener = getRegisteredStreamListener();

    listener({}, { requestId: 'mock-uuid-1', type: 'chunk', text: 'hi' });

    expect(ipcRendererMock.removeListener).not.toHaveBeenCalled();
  });

  it('returns an unsubscribe function that removes exactly the listener it registered', () => {
    const unsubscribe = electronHandler.copilot.runPrompt(
      { prompt: 'hi' },
      { onChunk: jest.fn(), onDone: jest.fn(), onError: jest.fn() },
    );
    const registeredListener = getRegisteredStreamListener();

    unsubscribe();

    expect(ipcRendererMock.removeListener).toHaveBeenCalledWith(
      'copilot:stream',
      registeredListener,
    );
  });
});

describe('electronHandler.ipcRenderer (generic bridge)', () => {
  it('sendMessage forwards to ipcRenderer.send with the channel and args', () => {
    electronHandler.ipcRenderer.sendMessage('ipc-example', 'ping');

    expect(ipcRendererMock.send).toHaveBeenCalledWith('ipc-example', 'ping');
  });

  it('on() strips the event object before calling the callback, and unsubscribes cleanly', () => {
    const callback = jest.fn();

    const unsubscribe = electronHandler.ipcRenderer.on('ipc-example', callback);
    const [, registeredListener] = ipcRendererMock.on.mock.calls.find(
      (c) => c[0] === 'ipc-example',
    )!;

    registeredListener({ some: 'event-object' }, 'pong');
    expect(callback).toHaveBeenCalledWith('pong');

    unsubscribe();
    expect(ipcRendererMock.removeListener).toHaveBeenCalledWith(
      'ipc-example',
      registeredListener,
    );
  });
});

// An invoke/handle bridge (Copilot V3), deliberately top-level rather than
// nested under `copilot`: the main-process side (repoLink.ts) is general
// local-repo introspection, not a Copilot-specific concern.
describe('electronHandler.repo', () => {
  beforeEach(() => {
    ipcRendererMock.invoke.mockReset();
  });

  it('invokes the repo:choose-folder channel and returns the picked path', async () => {
    ipcRendererMock.invoke.mockResolvedValue({
      canceled: false,
      path: '/Users/amaan/code/waypoint',
      looksLikeGitRepo: true,
    });

    const result = await electronHandler.repo.chooseFolder();

    expect(ipcRendererMock.invoke).toHaveBeenCalledWith(
      'repo:choose-folder',
      undefined,
    );
    expect(result).toEqual({
      canceled: false,
      path: '/Users/amaan/code/waypoint',
      looksLikeGitRepo: true,
    });
  });

  // The dialog's context (which project, where to start) is the caller's to
  // decide, so the bridge forwards it verbatim rather than shaping it.
  it('forwards chooseFolder options verbatim to the channel', async () => {
    ipcRendererMock.invoke.mockResolvedValue({ canceled: true });
    const opts = {
      defaultPath: '/Users/amaan/code',
      title: 'Link Launch to its local checkout',
      message: 'Pick the folder that contains .git.',
    };

    await electronHandler.repo.chooseFolder(opts);

    expect(ipcRendererMock.invoke).toHaveBeenCalledWith(
      'repo:choose-folder',
      opts,
    );
  });

  it('passes a canceled result straight through', async () => {
    ipcRendererMock.invoke.mockResolvedValue({ canceled: true });

    await expect(electronHandler.repo.chooseFolder()).resolves.toEqual({
      canceled: true,
    });
  });

  it('invokes repo:check-path with the path and returns its answer', async () => {
    ipcRendererMock.invoke.mockResolvedValue({ exists: false });

    await expect(
      electronHandler.repo.checkPath('/Users/amaan/code/gone'),
    ).resolves.toEqual({ exists: false });
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith(
      'repo:check-path',
      '/Users/amaan/code/gone',
    );
  });

  it('invokes repo:describe with the path and returns the description', async () => {
    const described = {
      name: 'waypoint',
      displayPath: '~/code/waypoint',
      branch: 'main',
      lastCommitAt: '2026-08-30T10:00:00.000Z',
      trackedFileCount: 1284,
    };
    ipcRendererMock.invoke.mockResolvedValue(described);

    await expect(
      electronHandler.repo.describe('/Users/amaan/code/waypoint'),
    ).resolves.toEqual(described);
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith(
      'repo:describe',
      '/Users/amaan/code/waypoint',
    );
  });
});
