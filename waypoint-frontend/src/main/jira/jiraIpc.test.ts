import type { JiraCredential } from './jiraAuth';
import type { JiraIdentity, JiraResult } from './jiraTypes';

const ipcMainHandleMock = jest.fn();
const showSaveDialogMock = jest.fn();
const showOpenDialogMock = jest.fn();
const showItemInFolderMock = jest.fn();
// `dialog`, `shell` and `app` join `ipcMain` here because the attachment
// channels reach main/jira/jiraFiles.ts, which is the one file in this feature
// that touches them. They are stubbed rather than left out so a handler that
// unexpectedly opened a real dialog would fail loudly instead of hanging.
jest.mock('electron', () => ({
  ipcMain: { handle: ipcMainHandleMock },
  dialog: {
    showSaveDialog: (...args: unknown[]) => showSaveDialogMock(...args),
    showOpenDialog: (...args: unknown[]) => showOpenDialogMock(...args),
  },
  shell: { showItemInFolder: (p: string) => showItemInFolderMock(p) },
  app: { getPath: () => '/Users/max/Downloads' },
}));

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
const listPriorityOptionsMock = jest.fn();
const setTicketPriorityMock = jest.fn();
const searchAssignableUsersMock = jest.fn();
const setTicketAssigneeMock = jest.fn();
const listCommentsMock = jest.fn();
const postCommentMock = jest.fn();
const downloadAttachmentMock = jest.fn();
const uploadAttachmentMock = jest.fn();
jest.mock('./jiraClient', () => ({
  MAX_TRANSFER_BYTES: 100 * 1024 * 1024,
  downloadAttachment: (...args: unknown[]) => downloadAttachmentMock(...args),
  uploadAttachment: (...args: unknown[]) => uploadAttachmentMock(...args),
  validateCredential: (...args: unknown[]) => validateCredentialMock(...args),
  listMyTickets: (...args: unknown[]) => listMyTicketsMock(...args),
  listTransitions: (...args: unknown[]) => listTransitionsMock(...args),
  transitionTicket: (...args: unknown[]) => transitionTicketMock(...args),
  listPriorityOptions: (...args: unknown[]) => listPriorityOptionsMock(...args),
  setTicketPriority: (...args: unknown[]) => setTicketPriorityMock(...args),
  searchAssignableUsers: (...args: unknown[]) =>
    searchAssignableUsersMock(...args),
  setTicketAssignee: (...args: unknown[]) => setTicketAssigneeMock(...args),
  listComments: (...args: unknown[]) => listCommentsMock(...args),
  postComment: (...args: unknown[]) => postCommentMock(...args),
}));

// jiraFiles is deliberately NOT mocked: it is the thing on the other side of
// these channels, and the property worth testing here — that a cancelled
// dialog is a success rather than a failure — lives in it. Only the Electron
// dialogs and the filesystem underneath it are stubbed.
const writeFileMock = jest.fn();
const statMock = jest.fn();
const readFileMock = jest.fn();
jest.mock('fs', () => ({
  promises: {
    writeFile: (...args: unknown[]) => writeFileMock(...args),
    stat: (...args: unknown[]) => statMock(...args),
    readFile: (...args: unknown[]) => readFileMock(...args),
  },
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

/** The window getter main.ts passes. Null is a real answer there — a window
 * closed and reopened is a different object, and registration happens before
 * any window exists — so tests that do not care about it pass one that says
 * so. */
const WINDOW = { id: 1 } as never;
const getWindowMock = jest.fn<never | null, []>(() => WINDOW);

beforeEach(() => {
  jest.clearAllMocks();
  readStoredJiraCredentialMock.mockReturnValue(null);
  isJiraSecureStorageAvailableMock.mockReturnValue(true);
  getWindowMock.mockReturnValue(WINDOW);
  registerJiraIpc(getWindowMock);
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
  it.each([
    'jira:tickets:transitions',
    'jira:tickets:priority-options',
    'jira:comments:list',
  ])('%s refuses a ticket id that is not one', async (channel) => {
    expect(await getHandler(channel)({}, '../../../admin')).toMatchObject({
      ok: false,
      reason: 'invalid_input',
    });
    expect(listTransitionsMock).not.toHaveBeenCalled();
    expect(listPriorityOptionsMock).not.toHaveBeenCalled();
    expect(listCommentsMock).not.toHaveBeenCalled();
  });

  it('jira:tickets:set-priority refuses a ticket id that is not one', async () => {
    expect(
      await getHandler('jira:tickets:set-priority')(
        {},
        { ticketId: '../../../admin', priorityId: '3' },
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(setTicketPriorityMock).not.toHaveBeenCalled();
  });

  it('jira:tickets:set-priority requires both a ticket and a priority', async () => {
    expect(
      await getHandler('jira:tickets:set-priority')(
        {},
        { ticketId: '10421', priorityId: '  ' },
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(setTicketPriorityMock).not.toHaveBeenCalled();
  });

  it('jira:tickets:set-priority delegates a valid pair to the client', async () => {
    setTicketPriorityMock.mockResolvedValue({ ok: true, value: {} });

    await getHandler('jira:tickets:set-priority')(
      {},
      { ticketId: '10421', priorityId: '3' },
    );

    expect(setTicketPriorityMock).toHaveBeenCalledWith('10421', '3');
  });

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

  it('jira:tickets:set-assignee refuses a ticket id that is not one', async () => {
    expect(
      await getHandler('jira:tickets:set-assignee')(
        {},
        { ticketId: '../../../admin', accountId: 'acct-sam' },
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(setTicketAssigneeMock).not.toHaveBeenCalled();
  });

  // Jira's assignable-user search takes the issue KEY, so this is the one
  // channel carrying one. The same validator holds: an issue key is
  // PROJECT-NUMBER, which is already the shape readTicketId allows, so
  // nothing had to be loosened to let a real key through.
  it('jira:tickets:assignable-users accepts a real issue key and refuses a path', async () => {
    searchAssignableUsersMock.mockResolvedValue({ ok: true, value: [] });

    await getHandler('jira:tickets:assignable-users')(
      {},
      { ticketKey: 'ENG-421', query: 'sam' },
    );
    expect(searchAssignableUsersMock).toHaveBeenCalledWith('ENG-421', 'sam');

    expect(
      await getHandler('jira:tickets:assignable-users')(
        {},
        { ticketKey: '../../../admin', query: 'sam' },
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(searchAssignableUsersMock).toHaveBeenCalledTimes(1);
  });

  // A blank query is what the picker sends on open, and Jira answers it with
  // the first page of assignable users. Rejecting it would break the panel's
  // opening state on the way to guarding nothing.
  it('jira:tickets:assignable-users allows a blank query', async () => {
    searchAssignableUsersMock.mockResolvedValue({ ok: true, value: [] });

    await getHandler('jira:tickets:assignable-users')(
      {},
      { ticketKey: 'ENG-421' },
    );

    expect(searchAssignableUsersMock).toHaveBeenCalledWith('ENG-421', '');
  });

  // The sharpest boundary in this feature. `readString` turns null into '',
  // so an accountId run through it before this check would make "the user
  // pressed Unassign" and "the renderer sent no field" the same value — and
  // this handler would have to guess which one it was looking at. These three
  // cases must stay three different outcomes.
  describe('jira:tickets:set-assignee — null vs missing vs empty string', () => {
    beforeEach(() => {
      setTicketAssigneeMock.mockResolvedValue({ ok: true, value: {} });
    });

    it('passes an explicit null straight through as null, never ""', async () => {
      await getHandler('jira:tickets:set-assignee')(
        {},
        { ticketId: '10421', accountId: null },
      );

      expect(setTicketAssigneeMock).toHaveBeenCalledWith('10421', null);
      // Belt and braces: `toHaveBeenCalledWith(…, null)` would also pass for
      // a stray undefined under some matchers, and '' is the exact value this
      // whole ordering exists to keep out.
      expect(setTicketAssigneeMock.mock.calls[0][1]).toBeNull();
      expect(setTicketAssigneeMock.mock.calls[0][1]).not.toBe('');
    });

    it('refuses a missing accountId rather than silently unassigning', async () => {
      expect(
        await getHandler('jira:tickets:set-assignee')(
          {},
          { ticketId: '10421' },
        ),
      ).toMatchObject({ ok: false, reason: 'invalid_input' });
      expect(setTicketAssigneeMock).not.toHaveBeenCalled();
    });

    it('refuses an empty-string accountId rather than silently unassigning', async () => {
      expect(
        await getHandler('jira:tickets:set-assignee')(
          {},
          { ticketId: '10421', accountId: '   ' },
        ),
      ).toMatchObject({ ok: false, reason: 'invalid_input' });
      expect(setTicketAssigneeMock).not.toHaveBeenCalled();
    });

    it('passes a real account id through trimmed', async () => {
      await getHandler('jira:tickets:set-assignee')(
        {},
        { ticketId: '10421', accountId: '  acct-sam  ' },
      );

      expect(setTicketAssigneeMock).toHaveBeenCalledWith('10421', 'acct-sam');
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

  /**
   * The security property this whole feature is shaped around: no filesystem
   * path crosses this boundary in either direction. The renderer sends an
   * issue id, an attachment id and a suggested filename, and gets back only
   * whether the user cancelled. Everything between the fetch and the file on
   * disk happens inside main, where the native dialog is the authorization.
   */
  describe('jira:attachments:download', () => {
    beforeEach(() => {
      downloadAttachmentMock.mockResolvedValue({
        ok: true,
        value: { bytes: Buffer.from('bytes') },
      });
      showSaveDialogMock.mockResolvedValue({
        canceled: false,
        filePath: '/Users/max/Downloads/replay-log.txt',
      });
      writeFileMock.mockResolvedValue(undefined);
    });

    it('refuses a ticket id that is not one, before any client call', async () => {
      expect(
        await getHandler('jira:attachments:download')(
          {},
          {
            ticketId: '../../../admin',
            attachmentId: '10050',
            fileName: 'x.txt',
          },
        ),
      ).toMatchObject({ ok: false, reason: 'invalid_input' });
      expect(downloadAttachmentMock).not.toHaveBeenCalled();
      expect(showSaveDialogMock).not.toHaveBeenCalled();
    });

    it('refuses an attachment id that is not one, before any client call', async () => {
      expect(
        await getHandler('jira:attachments:download')(
          {},
          {
            ticketId: '10421',
            attachmentId: '../../../etc/passwd',
            fileName: 'x.txt',
          },
        ),
      ).toMatchObject({ ok: false, reason: 'invalid_input' });
      expect(downloadAttachmentMock).not.toHaveBeenCalled();
      expect(showSaveDialogMock).not.toHaveBeenCalled();
    });

    it('accepts a real numeric attachment id and downloads by it', async () => {
      await getHandler('jira:attachments:download')(
        {},
        {
          ticketId: '10421',
          attachmentId: '10050',
          fileName: 'replay-log.txt',
        },
      );

      expect(downloadAttachmentMock).toHaveBeenCalledWith('10050');
    });

    // A user closing a save dialog is a normal outcome, not a failure. The
    // renderer's unwrap() throws on any ok:false and every caller turns that
    // into an error toast, so a cancel modelled as a failure would pop a red
    // message on every Escape.
    it('reports a cancelled save dialog as a success, never a failure', async () => {
      showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: '' });

      expect(
        await getHandler('jira:attachments:download')(
          {},
          {
            ticketId: '10421',
            attachmentId: '10050',
            fileName: 'replay-log.txt',
          },
        ),
      ).toEqual({ ok: true, value: { canceled: true } });
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it('parents the dialog to whatever window exists right now', async () => {
      await getHandler('jira:attachments:download')(
        {},
        { ticketId: '10421', attachmentId: '10050', fileName: 'x.txt' },
      );
      expect(showSaveDialogMock).toHaveBeenCalledWith(
        WINDOW,
        expect.anything(),
      );

      getWindowMock.mockReturnValue(null);
      await getHandler('jira:attachments:download')(
        {},
        { ticketId: '10421', attachmentId: '10050', fileName: 'x.txt' },
      );
      expect(showSaveDialogMock).toHaveBeenLastCalledWith(expect.anything());
    });

    // The renderer cannot say where a file goes, and is not told where it
    // went — the answer it gets is a boolean.
    it('takes no path in and hands no path back', async () => {
      const result = await getHandler('jira:attachments:download')(
        {},
        {
          ticketId: '10421',
          attachmentId: '10050',
          fileName: 'replay-log.txt',
          // A path the renderer has no business sending. It is not a field on
          // this channel, and nothing reads it.
          path: '/etc/cron.d/pwn',
        },
      );

      expect(writeFileMock).toHaveBeenCalledWith(
        '/Users/max/Downloads/replay-log.txt',
        expect.anything(),
      );
      expect(JSON.stringify(result)).not.toContain('/etc/cron.d/pwn');
    });
  });

  /**
   * The upload half of the same property, and the sharper half of it: this
   * channel's entire payload is an issue id. There is no filename and no path
   * to send, so the renderer cannot name what gets read off this machine even
   * if it tried — the native picker is the only thing that chooses a file.
   */
  describe('jira:attachments:upload', () => {
    beforeEach(() => {
      showOpenDialogMock.mockResolvedValue({
        canceled: false,
        filePaths: ['/Users/max/Desktop/replay-log.txt'],
      });
      statMock.mockResolvedValue({ size: 21 });
      readFileMock.mockResolvedValue(Buffer.from('replay log, line one\n'));
      uploadAttachmentMock.mockResolvedValue({
        ok: true,
        value: { id: '10421', key: 'ENG-421' },
      });
    });

    it('refuses a ticket id that is not one, before opening any picker', async () => {
      expect(
        await getHandler('jira:attachments:upload')(
          {},
          { ticketId: '../../../admin' },
        ),
      ).toMatchObject({ ok: false, reason: 'invalid_input' });
      expect(showOpenDialogMock).not.toHaveBeenCalled();
      expect(uploadAttachmentMock).not.toHaveBeenCalled();
    });

    // The whole point of the channel's shape. A path in the payload is not a
    // field this handler reads — main discovers the file itself.
    it('ignores anything path-shaped in the payload and uses the picker', async () => {
      await getHandler('jira:attachments:upload')(
        {},
        { ticketId: '10421', path: '/etc/shadow', fileName: '/etc/shadow' },
      );

      expect(readFileMock).toHaveBeenCalledWith(
        '/Users/max/Desktop/replay-log.txt',
      );
      expect(readFileMock).not.toHaveBeenCalledWith('/etc/shadow');
    });

    it('reports a cancelled picker as a success, never a failure', async () => {
      showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });

      expect(
        await getHandler('jira:attachments:upload')({}, { ticketId: '10421' }),
      ).toEqual({ ok: true, value: { canceled: true } });
      expect(readFileMock).not.toHaveBeenCalled();
    });

    // The re-read ticket comes back so the renderer can patch its cached list
    // with what Jira holds, matching every other write on this boundary.
    it('hands the whole re-read ticket back on success', async () => {
      expect(
        await getHandler('jira:attachments:upload')({}, { ticketId: '10421' }),
      ).toEqual({
        ok: true,
        value: { canceled: false, ticket: { id: '10421', key: 'ENG-421' } },
      });
    });
  });

  it('jira:tickets:list delegates straight to the client', async () => {
    listMyTicketsMock.mockResolvedValue({ ok: true, value: [] });

    expect(await getHandler('jira:tickets:list')({})).toEqual({
      ok: true,
      value: [],
    });
  });
});
