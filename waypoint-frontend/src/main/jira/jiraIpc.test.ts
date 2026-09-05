import type { JiraCredential } from './jiraAuth';
import type { JiraIdentity, JiraResult } from './jiraTypes';

const ipcMainHandleMock = jest.fn();
jest.mock('electron', () => ({ ipcMain: { handle: ipcMainHandleMock } }));

const readStoredJiraCredentialMock = jest.fn<JiraCredential | null, []>();
const writeStoredJiraCredentialMock = jest.fn();
const deleteStoredJiraCredentialMock = jest.fn();
const isJiraSecureStorageAvailableMock = jest.fn(() => true);
jest.mock('./jiraAuth', () => ({
  readStoredJiraCredential: () => readStoredJiraCredentialMock(),
  writeStoredJiraCredential: (c: unknown) => writeStoredJiraCredentialMock(c),
  deleteStoredJiraCredential: () => deleteStoredJiraCredentialMock(),
  isJiraSecureStorageAvailable: () => isJiraSecureStorageAvailableMock(),
  toJiraIdentity: (c: JiraCredential) => ({
    site: c.site,
    accountId: c.accountId,
    email: c.email,
    displayName: c.displayName,
    avatarUrl: c.avatarUrl,
  }),
}));

const validateCredentialMock = jest.fn();
const listMyTicketsMock = jest.fn();
const listTransitionsMock = jest.fn();
const transitionTicketMock = jest.fn();
const listCommentsMock = jest.fn();
const postCommentMock = jest.fn();
jest.mock('./jiraClient', () => ({
  validateCredential: (...args: unknown[]) => validateCredentialMock(...args),
  listMyTickets: (...args: unknown[]) => listMyTicketsMock(...args),
  listTransitions: (...args: unknown[]) => listTransitionsMock(...args),
  transitionTicket: (...args: unknown[]) => transitionTicketMock(...args),
  listComments: (...args: unknown[]) => listCommentsMock(...args),
  postComment: (...args: unknown[]) => postCommentMock(...args),
}));

// eslint-disable-next-line import/order, import/first
import { registerJiraIpc } from './jiraIpc';

const CREDENTIAL: JiraCredential = {
  site: 'waypoint123.atlassian.net',
  email: 'max@northwind.dev',
  apiToken: 'ATATT3xFfGF0-not-a-real-token',
  accountId: '5f8a1b2c3d4e5f6a7b8c9d0e',
  displayName: 'Max Chen',
  avatarUrl: null,
};

const IDENTITY: JiraIdentity = {
  site: CREDENTIAL.site,
  accountId: CREDENTIAL.accountId,
  email: CREDENTIAL.email,
  displayName: CREDENTIAL.displayName,
  avatarUrl: null,
};

function getHandler(channel: string) {
  const call = ipcMainHandleMock.mock.calls.find((c) => c[0] === channel);
  if (!call)
    throw new Error(`ipcMain.handle was never called with "${channel}"`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

const GOOD_CONNECT = {
  site: 'https://waypoint123.atlassian.net/jira/software',
  email: 'max@northwind.dev',
  apiToken: 'ATATT3xFfGF0-not-a-real-token',
};

beforeEach(() => {
  jest.clearAllMocks();
  readStoredJiraCredentialMock.mockReturnValue(null);
  isJiraSecureStorageAvailableMock.mockReturnValue(true);
  registerJiraIpc();
});

describe('jira:status', () => {
  it('reports disconnected with no stored credential, without any network call', async () => {
    expect(await getHandler('jira:status')({})).toEqual({
      connected: false,
      identity: null,
    });
    expect(validateCredentialMock).not.toHaveBeenCalled();
  });

  // The single most important assertion in this file: the credential store
  // holds an API token, and nothing that crosses back to the renderer may
  // contain it.
  it('returns the identity but never the API token', async () => {
    readStoredJiraCredentialMock.mockReturnValue(CREDENTIAL);

    const result = await getHandler('jira:status')({});

    expect(result).toEqual({ connected: true, identity: IDENTITY });
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL.apiToken);
  });
});

describe('jira:connect', () => {
  it('normalizes a pasted URL down to a bare hostname before it is used or stored', async () => {
    validateCredentialMock.mockResolvedValue({ ok: true, value: IDENTITY });

    const result = (await getHandler('jira:connect')(
      {},
      GOOD_CONNECT,
    )) as JiraResult<JiraIdentity>;

    expect(validateCredentialMock).toHaveBeenCalledWith(
      expect.objectContaining({ site: 'waypoint123.atlassian.net' }),
    );
    expect(writeStoredJiraCredentialMock).toHaveBeenCalledWith(
      expect.objectContaining({
        site: 'waypoint123.atlassian.net',
        accountId: CREDENTIAL.accountId,
      }),
    );
    expect(result).toEqual({ ok: true, value: IDENTITY });
  });

  it.each([
    [{ ...GOOD_CONNECT, site: '   ' }, 'a blank site'],
    [
      { ...GOOD_CONNECT, site: 'attacker@evil.example' },
      'a site with userinfo',
    ],
    [{ ...GOOD_CONNECT, email: 'not-an-email' }, 'a malformed email'],
    [{ ...GOOD_CONNECT, apiToken: '  ' }, 'a blank token'],
  ])('refuses %#: %s, without sending anything anywhere', async (args) => {
    const result = (await getHandler('jira:connect')(
      {},
      args,
    )) as JiraResult<JiraIdentity>;

    expect(result).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(validateCredentialMock).not.toHaveBeenCalled();
    expect(writeStoredJiraCredentialMock).not.toHaveBeenCalled();
  });

  // Checked before the network call, not after: validating a token this app
  // has already decided it cannot store would mean sending a real credential
  // to Atlassian purely to throw the result away.
  it('refuses before validating when secure storage is unavailable', async () => {
    isJiraSecureStorageAvailableMock.mockReturnValue(false);

    expect(await getHandler('jira:connect')({}, GOOD_CONNECT)).toMatchObject({
      ok: false,
      reason: 'storage_unavailable',
    });
    expect(validateCredentialMock).not.toHaveBeenCalled();
  });

  it('does not store a credential Jira rejected, and passes the reason through', async () => {
    validateCredentialMock.mockResolvedValue({
      ok: false,
      reason: 'invalid_credentials',
      message: 'Jira rejected that email and API token.',
    });

    expect(await getHandler('jira:connect')({}, GOOD_CONNECT)).toMatchObject({
      ok: false,
      reason: 'invalid_credentials',
    });
    expect(writeStoredJiraCredentialMock).not.toHaveBeenCalled();
  });

  // A locked keychain or a full disk must resolve with a message, never
  // reject — the same hazard copilotAuth.ts's save handler documents, where
  // an unsettled invoke strands the UI mid-flight.
  it('resolves with a message, not a rejection, when the write fails', async () => {
    validateCredentialMock.mockResolvedValue({ ok: true, value: IDENTITY });
    writeStoredJiraCredentialMock.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    await expect(
      getHandler('jira:connect')({}, GOOD_CONNECT),
    ).resolves.toMatchObject({ ok: false, reason: 'storage_unavailable' });
  });
});

describe('jira:disconnect', () => {
  it('deletes the stored credential outright', async () => {
    expect(await getHandler('jira:disconnect')({})).toEqual({ ok: true });
    expect(deleteStoredJiraCredentialMock).toHaveBeenCalledTimes(1);
  });
});

describe('per-ticket channels', () => {
  // IPC is an external input to the privileged process even when the only
  // caller is this app's own renderer, so nothing caller-supplied reaches a
  // REST path unchecked.
  it.each(['jira:tickets:transitions', 'jira:comments:list'])(
    '%s refuses a ticket id that is not one',
    async (channel) => {
      expect(await getHandler(channel)({}, '../../../admin')).toMatchObject({
        ok: false,
        reason: 'invalid_input',
      });
      expect(listTransitionsMock).not.toHaveBeenCalled();
      expect(listCommentsMock).not.toHaveBeenCalled();
    },
  );

  it('jira:tickets:transition requires both a ticket and a transition', async () => {
    expect(
      await getHandler('jira:tickets:transition')(
        {},
        {
          ticketId: '10421',
          transitionId: '',
        },
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(transitionTicketMock).not.toHaveBeenCalled();
  });

  it('jira:tickets:transition passes through only string field values', async () => {
    transitionTicketMock.mockResolvedValue({ ok: true, value: {} });

    await getHandler('jira:tickets:transition')(
      {},
      {
        ticketId: '10421',
        transitionId: '31',
        fieldValues: { resolution: 'Fixed', bogus: { nested: true }, n: 5 },
      },
    );

    expect(transitionTicketMock).toHaveBeenCalledWith('10421', '31', {
      resolution: 'Fixed',
    });
  });

  it('jira:comments:post refuses an empty body', async () => {
    expect(
      await getHandler('jira:comments:post')(
        {},
        {
          ticketId: '10421',
          body: '   ',
        },
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(postCommentMock).not.toHaveBeenCalled();
  });

  it('jira:tickets:list delegates straight to the client', async () => {
    listMyTicketsMock.mockResolvedValue({ ok: true, value: [] });

    expect(await getHandler('jira:tickets:list')({})).toEqual({
      ok: true,
      value: [],
    });
  });
});
