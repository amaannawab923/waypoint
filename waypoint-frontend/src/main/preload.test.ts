const ipcRendererMock = {
  send: jest.fn(),
  on: jest.fn(),
  once: jest.fn(),
  removeListener: jest.fn(),
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
  onDone: (result: { fullText: string; sessionId: string | null }) => void;
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
        args: { prompt: string; resumeSessionId?: string },
        handlers: RunPromptHandlers,
      ) => () => void;
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
    });
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
