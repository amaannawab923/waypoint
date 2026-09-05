const getPathMock = jest.fn(() => '/fake/userData');
const isEncryptionAvailableMock = jest.fn(() => true);
const encryptStringMock = jest.fn((s: string) => Buffer.from(`enc:${s}`));
const decryptStringMock = jest.fn((b: Buffer) =>
  b.toString().replace(/^enc:/, ''),
);

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
jest.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
}));

// Same hazard documented in copilotAuth.test.ts: this file's own
// `import { app, safeStorage } from 'electron'` must run only after the mocks
// above exist.
// eslint-disable-next-line import/order, import/first
import {
  deleteStoredJiraCredential,
  readStoredJiraCredential,
  toJiraIdentity,
  writeStoredJiraCredential,
  type JiraCredential,
} from './jiraAuth';

const CREDENTIAL: JiraCredential = {
  site: 'waypoint123.atlassian.net',
  email: 'max@northwind.dev',
  apiToken: 'ATATT3xFfGF0-not-a-real-token',
  accountId: '5f8a1b2c3d4e5f6a7b8c9d0e',
  displayName: 'Max Chen',
  avatarUrl: 'https://avatar.example/48',
};

function storedFile(credential: Partial<JiraCredential>): string {
  return JSON.stringify({
    encrypted: Buffer.from(`enc:${JSON.stringify(credential)}`).toString(
      'base64',
    ),
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
});

describe('writeStoredJiraCredential', () => {
  it('encrypts the whole credential and writes it owner-only', () => {
    writeStoredJiraCredential(CREDENTIAL);

    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const [writtenPath, contents, options] = writeFileSyncMock.mock.calls[0];
    expect(writtenPath).toBe('/fake/userData/jira-auth.json');
    expect(options).toEqual({ mode: 0o600 });

    const parsed = JSON.parse(contents as string) as { encrypted: string };
    expect(
      JSON.parse(
        Buffer.from(parsed.encrypted, 'base64').toString().replace(/^enc:/, ''),
      ),
    ).toEqual(CREDENTIAL);
  });

  // The point of encrypting the whole blob rather than just the token: the
  // site and the email together identify a real person's Atlassian account,
  // and the email is half of the Basic-auth pair.
  it('leaves nothing readable on disk — not the token, not the email, not the site', () => {
    writeStoredJiraCredential(CREDENTIAL);

    const contents = writeFileSyncMock.mock.calls[0][1] as string;
    expect(contents).not.toContain(CREDENTIAL.apiToken);
    expect(contents).not.toContain(CREDENTIAL.email);
    expect(contents).not.toContain(CREDENTIAL.site);
  });
});

describe('readStoredJiraCredential', () => {
  it('returns null when nothing has been stored', () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(readStoredJiraCredential()).toBeNull();
  });

  it('decrypts and returns a stored credential', () => {
    readFileSyncMock.mockReturnValue(storedFile(CREDENTIAL));
    expect(readStoredJiraCredential()).toEqual(CREDENTIAL);
  });

  it('returns null on malformed JSON rather than throwing', () => {
    readFileSyncMock.mockReturnValue('{not valid json');
    expect(readStoredJiraCredential()).toBeNull();
  });

  // Without OS-level encryption there is no way to have written this file
  // safely in the first place, so a file found under those conditions is not
  // trusted back into use.
  it('returns null when encryption is unavailable, even with a file present', () => {
    isEncryptionAvailableMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue(storedFile(CREDENTIAL));
    expect(readStoredJiraCredential()).toBeNull();
  });

  it('returns null when the decrypted blob is missing a required field', () => {
    readFileSyncMock.mockReturnValue(
      storedFile({ site: 'x.atlassian.net', email: 'a@b.c' }),
    );
    expect(readStoredJiraCredential()).toBeNull();
  });

  it('falls back to the email as a display name rather than rejecting the credential', () => {
    readFileSyncMock.mockReturnValue(
      storedFile({ ...CREDENTIAL, displayName: '', avatarUrl: null }),
    );
    expect(readStoredJiraCredential()).toEqual({
      ...CREDENTIAL,
      displayName: CREDENTIAL.email,
      avatarUrl: null,
    });
  });
});

describe('deleteStoredJiraCredential', () => {
  it('removes the credential file', () => {
    deleteStoredJiraCredential();
    expect(unlinkSyncMock).toHaveBeenCalledWith(
      '/fake/userData/jira-auth.json',
    );
  });

  it('is a no-op, not an error, when nothing was ever stored', () => {
    unlinkSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(() => deleteStoredJiraCredential()).not.toThrow();
  });
});

describe('toJiraIdentity', () => {
  // The one function that decides what the renderer is allowed to see. If it
  // ever grows an apiToken field, that token is in the renderer.
  it('projects everything except the API token', () => {
    const identity = toJiraIdentity(CREDENTIAL);

    expect(identity).toEqual({
      site: CREDENTIAL.site,
      accountId: CREDENTIAL.accountId,
      email: CREDENTIAL.email,
      displayName: CREDENTIAL.displayName,
      avatarUrl: CREDENTIAL.avatarUrl,
    });
    expect(JSON.stringify(identity)).not.toContain(CREDENTIAL.apiToken);
  });
});
