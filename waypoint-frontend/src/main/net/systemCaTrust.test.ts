const getCACertificatesMock = jest.fn<Array<string | Buffer>, [string]>();
jest.mock('node:tls', () => ({
  getCACertificates: (...args: [string]) => getCACertificatesMock(...args),
}));

const logWarnMock = jest.fn();
jest.mock('electron-log', () => ({
  warn: (...args: unknown[]) => logWarnMock(...args),
}));

const setGlobalDispatcherMock = jest.fn();
class FakeAgent {
  options: unknown;

  constructor(options: unknown) {
    this.options = options;
  }
}
jest.mock('undici', () => ({
  Agent: FakeAgent,
  setGlobalDispatcher: (...args: unknown[]) => setGlobalDispatcherMock(...args),
}));

// eslint-disable-next-line import/order, import/first
import { installSystemCaTrust } from './systemCaTrust';

beforeEach(() => {
  jest.resetAllMocks();
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
    expect(logWarnMock).not.toHaveBeenCalled();
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
      expect(logWarnMock).not.toHaveBeenCalled();
    } finally {
      tls.getCACertificates = original;
    }
  });

  it('warns, without throwing, and skips installing a dispatcher, when reading the OS trust store fails', () => {
    const readError = new Error('keychain access denied');
    getCACertificatesMock.mockImplementation(() => {
      throw readError;
    });

    expect(() => installSystemCaTrust()).not.toThrow();

    expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock.mock.calls[0][0]).toMatch(/certificate store/i);
    expect(logWarnMock.mock.calls[0][1]).toBe(readError);
  });
});
