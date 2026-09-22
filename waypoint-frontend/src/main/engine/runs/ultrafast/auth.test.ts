const getPathMock = jest.fn(() => '/fake/userData');
const isEncryptionAvailableMock = jest.fn(() => true);
const encryptStringMock = jest.fn((s: string) => Buffer.from(`enc:${s}`));
const decryptStringMock = jest.fn((b: Buffer) => b.toString().replace(/^enc:/, ''));

jest.mock('electron', () => ({
  app: { getPath: getPathMock },
  safeStorage: {
    isEncryptionAvailable: isEncryptionAvailableMock,
    encryptString: encryptStringMock,
    decryptString: decryptStringMock,
  },
}));

const readFileSyncMock = jest.fn();
const writeFileSyncMock = jest.fn();
const unlinkSyncMock = jest.fn();
const chmodSyncMock = jest.fn();
jest.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
  chmodSync: (...args: unknown[]) => chmodSyncMock(...args),
}));

// eslint-disable-next-line import/order, import/first
import {
  deleteStoredTypesafeApiKey,
  isUltrafastSecureStorageAvailable,
  maskedTail,
  readStoredTypesafeApiKey,
  writeStoredTypesafeApiKey,
} from './auth';

const KEY = 'ts_live_abcdEFGH1234wxyz';

beforeEach(() => {
  jest.clearAllMocks();
  isEncryptionAvailableMock.mockReturnValue(true);
});

describe('isUltrafastSecureStorageAvailable', () => {
  it('mirrors safeStorage.isEncryptionAvailable', () => {
    isEncryptionAvailableMock.mockReturnValue(false);
    expect(isUltrafastSecureStorageAvailable()).toBe(false);
  });
});

describe('readStoredTypesafeApiKey', () => {
  it('returns null when no file exists', () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(readStoredTypesafeApiKey()).toBeNull();
  });

  it('decrypts a stored key', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ encrypted: Buffer.from(`enc:${KEY}`).toString('base64') }));
    expect(readStoredTypesafeApiKey()).toBe(KEY);
  });

  it('returns null when encryption is unavailable, even with a file present', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ encrypted: 'anything' }));
    isEncryptionAvailableMock.mockReturnValue(false);
    expect(readStoredTypesafeApiKey()).toBeNull();
  });

  it('returns null on malformed JSON rather than throwing', () => {
    readFileSyncMock.mockReturnValue('not json');
    expect(readStoredTypesafeApiKey()).toBeNull();
  });
});

describe('writeStoredTypesafeApiKey', () => {
  it('encrypts and writes with 0o600, then chmods to 0o600', () => {
    writeStoredTypesafeApiKey(KEY);
    expect(encryptStringMock).toHaveBeenCalledWith(KEY);
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      '/fake/userData/ultrafast-auth.json',
      expect.any(String),
      { mode: 0o600 },
    );
    expect(chmodSyncMock).toHaveBeenCalledWith('/fake/userData/ultrafast-auth.json', 0o600);
  });

  it('throws rather than writing in the clear when encryption is unavailable', () => {
    isEncryptionAvailableMock.mockReturnValue(false);
    expect(() => writeStoredTypesafeApiKey(KEY)).toThrow(/Secure storage/);
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});

describe('deleteStoredTypesafeApiKey', () => {
  it('unlinks the file', () => {
    deleteStoredTypesafeApiKey();
    expect(unlinkSyncMock).toHaveBeenCalledWith('/fake/userData/ultrafast-auth.json');
  });

  it('is a no-op when the file is already gone', () => {
    unlinkSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => deleteStoredTypesafeApiKey()).not.toThrow();
  });
});

describe('maskedTail', () => {
  it('shows only the last four characters', () => {
    expect(maskedTail(KEY)).toBe('…wxyz');
  });
});
