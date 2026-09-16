const getCACertificatesMock = jest.fn<Array<string | Buffer>, [string]>();
jest.mock('node:tls', () => ({
  getCACertificates: (...args: [string]) => getCACertificatesMock(...args),
}));

const logWarnMock = jest.fn();
jest.mock('electron-log', () => ({ warn: (...args: unknown[]) => logWarnMock(...args) }));

const GLOBAL_DISPATCHER_KEY = Symbol.for('undici.globalDispatcher.1');

const setGlobalDispatcherMock = jest.fn();
class FakeAgent {
  options: unknown;

  constructor(options: unknown) {
    this.options = options;
  }
}
// Toggled per-test to simulate the two real behaviors this module has to
// tell apart: a normal undici copy shares its dispatcher via the
// well-known globalThis symbol (default here); a hypothetical future
// Electron/undici build whose bundled fetch reads a different symbol
// would not (see the "warns" test below).
let writeGlobalDispatcherSymbol = true;
jest.mock('undici', () => ({
  Agent: FakeAgent,
  setGlobalDispatcher: (agent: unknown) => {
    setGlobalDispatcherMock(agent);
    if (writeGlobalDispatcherSymbol) {
      (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER_KEY] = agent;
    }
  },
}));

// eslint-disable-next-line import/order, import/first
import { installSystemCaTrust } from './systemCaTrust';

beforeEach(() => {
  jest.resetAllMocks();
  writeGlobalDispatcherSymbol = true;
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER_KEY];
});

describe('installSystemCaTrust', () => {
  it('merges the bundled, system, and extra CA stores into one dispatcher', () => {
    getCACertificatesMock.mockImplementation((type) => {
      if (type === 'bundled') return ['bundled-1', 'bundled-2'];
      if (type === 'system') return ['system-1'];
      if (type === 'extra') return ['extra-1'];
      return [];
    });

    installSystemCaTrust();

    expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
    const dispatcher = setGlobalDispatcherMock.mock.calls[0][0] as FakeAgent;
    expect(dispatcher).toBeInstanceOf(FakeAgent);
    expect(dispatcher.options).toEqual({
      connect: { ca: ['bundled-1', 'bundled-2', 'system-1', 'extra-1'] },
    });
  });

  it('does not warn when the dispatcher write reaches the shared global symbol', () => {
    getCACertificatesMock.mockReturnValue([]);

    installSystemCaTrust();

    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it('warns, without throwing, when the dispatcher write does not reach the shared global symbol', () => {
    getCACertificatesMock.mockReturnValue([]);
    // Simulate a future Electron/undici build whose bundled `fetch` reads a
    // different globalThis symbol than the one this module writes to.
    writeGlobalDispatcherSymbol = false;

    expect(() => installSystemCaTrust()).not.toThrow();

    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock.mock.calls[0][0]).toMatch(/certificate store/i);
  });

  it('does nothing when tls.getCACertificates is not exposed by this Node build', () => {
    // Simulate an older Node/Electron: the mocked module has no such export.
    // Restored afterwards — the mocked `node:tls` object is shared by every
    // test in this file via Node's module cache, so leaving it deleted
    // would break the tests that follow.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const tls = require('node:tls');
    const original = tls.getCACertificates;
    delete tls.getCACertificates;

    try {
      installSystemCaTrust();
      expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
    } finally {
      tls.getCACertificates = original;
    }
  });

  it('does nothing, and does not throw, when reading the OS trust store fails', () => {
    getCACertificatesMock.mockImplementation(() => {
      throw new Error('keychain access denied');
    });

    expect(() => installSystemCaTrust()).not.toThrow();
    expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
  });
});
