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
const chmodSyncMock = jest.fn();
jest.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
  chmodSync: (...args: unknown[]) => chmodSyncMock(...args),
}));

// Same hazard documented in copilotAuth.test.ts: this file's own
// `import { app, safeStorage } from 'electron'` must run only after the mocks
// above exist.
// eslint-disable-next-line import/order, import/first
import {
  deleteStoredJiraCredential,
  encodeJiraCredentialHeader,
  JIRA_CREDENTIAL_HEADER,
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
  // The module comment has always promised "a hard refusal when
  // isEncryptionAvailable() is false rather than a plaintext fallback". That
  // refusal lived only in the IPC caller, so the store failed closed by
  // accident; a second caller would have inherited nothing.
  it('refuses to write at all when secure storage is unavailable', () => {
    isEncryptionAvailableMock.mockReturnValue(false);

    expect(() => writeStoredJiraCredential(CREDENTIAL)).toThrow(
      /secure storage is unavailable/i,
    );
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('encrypts the whole credential and writes it owner-only', () => {
    writeStoredJiraCredential(CREDENTIAL);

    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const [writtenPath, contents, options] = writeFileSyncMock.mock.calls[0];
    expect(writtenPath).toBe('/fake/userData/jira-auth.json');
    expect(options).toEqual({ mode: 0o600 });
    // `mode` on writeFileSync applies only when the file is created; on an
    // existing file it is ignored, so a jira-auth.json left at 0644 by an
    // earlier build or a restored backup kept that mode forever while this
    // code read as though it enforced 0600. The chmod is what makes the
    // guarantee hold on the rewrite path too.
    expect(chmodSyncMock).toHaveBeenCalledWith(
      '/fake/userData/jira-auth.json',
      0o600,
    );

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

// The other function that decides what leaves this process — the credential
// as another process receives it. Shared by the two callers that lend it: the
// MCP config (agent/sessionPolicy.ts, so Copilot's tools can READ Jira) and
// the approve POST (copilot/proposalApproval.ts, so an approved proposal can
// WRITE). One encoder, so the backend's one parser has one shape to accept.
describe('encodeJiraCredentialHeader', () => {
  function decode(header: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  }

  it('sends what authenticates the request, plus the name a person reads', () => {
    const encoded = encodeJiraCredentialHeader(CREDENTIAL);

    expect(decode(encoded as string)).toEqual({
      site: CREDENTIAL.site,
      email: CREDENTIAL.email,
      apiToken: CREDENTIAL.apiToken,
      // Not authentication. It is here so a write-approval card can say whose
      // Jira account the write will post as — which the other three cannot
      // answer in a form a person reads.
      displayName: CREDENTIAL.displayName,
    });
  });

  it('never sends the identity fields the backend has no use for', () => {
    const decoded = decode(encodeJiraCredentialHeader(CREDENTIAL) as string);

    expect(Object.keys(decoded).sort()).toEqual([
      'apiToken',
      'displayName',
      'email',
      'site',
    ]);
    expect(decoded).not.toHaveProperty('accountId');
    expect(decoded).not.toHaveProperty('avatarUrl');
  });

  // Base64 is not decoration: an HTTP header value may carry only visible
  // ASCII, while a token, an email and a person's own name are arbitrary
  // user-supplied strings. Raw JSON would be rejected by the transport for a
  // non-ASCII value — or would carry a newline into the header block.
  it('produces a header-safe value even for a name with non-ASCII characters', () => {
    const encoded = encodeJiraCredentialHeader({
      ...CREDENTIAL,
      displayName: 'Zoë Ó Briain \n injected: yes',
    }) as string;

    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(decode(encoded).displayName).toBe('Zoë Ó Briain \n injected: yes');
  });

  it('is null when nothing is connected, so callers simply omit the header', () => {
    expect(encodeJiraCredentialHeader(null)).toBeNull();
  });

  // The two projects share no package, so this constant and the backend's own
  // are kept in step by nothing but this assertion and its counterpart in
  // waypoint-backend's credentialHeader.test.ts.
  it('names the header the backend actually parses', () => {
    expect(JIRA_CREDENTIAL_HEADER).toBe('x-waypoint-jira-credential');
  });
});
