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

// Same hazard jiraAuth.test.ts documents: this file's own
// `import { app, safeStorage } from 'electron'` must run only after the
// mocks above exist.
// eslint-disable-next-line import/order, import/first
import {
  accountAuthorizationHeader,
  deleteStoredAccountCredential,
  isAccountSecureStorageAvailable,
  readStoredAccountCredential,
  toAccountIdentity,
  writeStoredAccountCredential,
} from './accountAuth';
import type { AccountCredential } from './accountTypes';

const CREDENTIAL: AccountCredential = {
  backendUrl: 'https://accounts.waypoint.sh',
  token: 'opaque-session-token-do-not-log',
  email: 'jordan@example.test',
  fullName: 'Jordan Reyes',
  avatarUrl: 'https://avatar.example/48',
};

function storedFile(credential: Partial<AccountCredential>): string {
  return JSON.stringify({
    encrypted: Buffer.from(`enc:${JSON.stringify(credential)}`).toString('base64'),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  isEncryptionAvailableMock.mockReturnValue(true);
});

describe('isAccountSecureStorageAvailable', () => {
  it('reflects safeStorage', () => {
    isEncryptionAvailableMock.mockReturnValue(false);
    expect(isAccountSecureStorageAvailable()).toBe(false);
  });
});

describe('readStoredAccountCredential', () => {
  it('reads and decrypts a valid stored credential', () => {
    readFileSyncMock.mockReturnValue(storedFile(CREDENTIAL));
    expect(readStoredAccountCredential()).toEqual(CREDENTIAL);
  });

  it('defaults a missing fullName to the email and a missing avatar to null', () => {
    readFileSyncMock.mockReturnValue(
      storedFile({ backendUrl: CREDENTIAL.backendUrl, token: CREDENTIAL.token, email: CREDENTIAL.email }),
    );
    expect(readStoredAccountCredential()).toEqual({
      backendUrl: CREDENTIAL.backendUrl,
      token: CREDENTIAL.token,
      email: CREDENTIAL.email,
      fullName: CREDENTIAL.email,
      avatarUrl: null,
    });
  });

  it.each([
    ['no file', () => readFileSyncMock.mockImplementation(() => { throw new Error('ENOENT'); })],
    ['malformed JSON', () => readFileSyncMock.mockReturnValue('not json')],
    ['no encrypted field', () => readFileSyncMock.mockReturnValue(JSON.stringify({}))],
    ['missing backendUrl', () => readFileSyncMock.mockReturnValue(storedFile({ token: 't', email: 'e' }))],
    ['missing token', () => readFileSyncMock.mockReturnValue(storedFile({ backendUrl: 'b', email: 'e' }))],
    ['missing email', () => readFileSyncMock.mockReturnValue(storedFile({ backendUrl: 'b', token: 't' }))],
  ])('collapses to null on %s', (_label, setup) => {
    setup();
    expect(readStoredAccountCredential()).toBeNull();
  });

  it('returns null when encryption is unavailable, even with a well-formed file', () => {
    readFileSyncMock.mockReturnValue(storedFile(CREDENTIAL));
    isEncryptionAvailableMock.mockReturnValue(false);
    expect(readStoredAccountCredential()).toBeNull();
  });
});

describe('writeStoredAccountCredential', () => {
  it('refuses to write when secure storage is unavailable', () => {
    isEncryptionAvailableMock.mockReturnValue(false);
    expect(() => writeStoredAccountCredential(CREDENTIAL)).toThrow(/[Ss]ecure storage/);
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('encrypts, writes at 0o600, and chmods on every write (not just create)', () => {
    writeStoredAccountCredential(CREDENTIAL);
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('/fake/userData'),
      expect.stringContaining('"encrypted"'),
      { mode: 0o600 },
    );
    expect(chmodSyncMock).toHaveBeenCalledWith(expect.stringContaining('/fake/userData'), 0o600);
    const written = JSON.parse(writeFileSyncMock.mock.calls[0][1] as string);
    expect(decryptStringMock(Buffer.from(written.encrypted, 'base64').toString() as unknown as Buffer)).toBeDefined();
  });

  it('uses its own file, distinct from jira-auth.json', () => {
    writeStoredAccountCredential(CREDENTIAL);
    const path = writeFileSyncMock.mock.calls[0][0] as string;
    expect(path).toContain('account-auth.json');
    expect(path).not.toContain('jira-auth.json');
  });
});

describe('deleteStoredAccountCredential', () => {
  it('unlinks the file', () => {
    deleteStoredAccountCredential();
    expect(unlinkSyncMock).toHaveBeenCalledWith(expect.stringContaining('account-auth.json'));
  });

  it('is a no-op, not an error, when nothing is there', () => {
    unlinkSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => deleteStoredAccountCredential()).not.toThrow();
  });
});

describe('toAccountIdentity', () => {
  it('drops the token and keeps everything else', () => {
    expect(toAccountIdentity(CREDENTIAL)).toEqual({
      backendUrl: CREDENTIAL.backendUrl,
      email: CREDENTIAL.email,
      fullName: CREDENTIAL.fullName,
      avatarUrl: CREDENTIAL.avatarUrl,
    });
    expect(toAccountIdentity(CREDENTIAL)).not.toHaveProperty('token');
  });
});

describe('accountAuthorizationHeader', () => {
  it('is null with no credential, and a Bearer header with one', () => {
    expect(accountAuthorizationHeader(null)).toBeNull();
    expect(accountAuthorizationHeader(CREDENTIAL)).toBe(`Bearer ${CREDENTIAL.token}`);
  });
});
