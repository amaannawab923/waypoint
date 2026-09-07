import type { JiraCredential } from '../jira/jiraAuth';

// The whole point of this module is that the Jira credential reaches the
// backend on an approve, so these tests are mostly about one header: is it
// there, is it the real encoding, and is it absent where it must be.

const ipcMainHandleMock = jest.fn();
jest.mock('electron', () => ({
  ipcMain: { handle: (...args: unknown[]) => ipcMainHandleMock(...args) },
  app: { getPath: () => '/fake/userData' },
}));

// Only the credential STORE is stubbed — encodeJiraCredentialHeader and the
// header name come through from the real module, so what is asserted below is
// the encoding the backend actually parses rather than a second copy of it
// written here. Mocked rather than left to fall through the real store, which
// would return null here only by accident (its readFileSync throwing ENOENT
// against a fake userData path) and would start reading a developer's ACTUAL
// keychain the moment that accident stopped holding.
const readStoredJiraCredentialMock = jest.fn<JiraCredential | null, []>(
  () => null,
);
jest.mock('../jira/jiraAuth', () => ({
  ...jest.requireActual('../jira/jiraAuth'),
  readStoredJiraCredential: () => readStoredJiraCredentialMock(),
}));

// eslint-disable-next-line import/order, import/first
import { registerProposalApprovalIpc } from './proposalApproval';

const CREDENTIAL: JiraCredential = {
  site: 'yourteam.atlassian.net',
  email: 'max@northwind.dev',
  apiToken: 'ATATT3xFfGF0-not-a-real-token',
  accountId: 'acc-secret',
  displayName: 'Max Chen',
  avatarUrl: 'https://avatar.example.com/me.png',
};

const fetchMock = jest.fn();

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/** The handler registered for a channel, invoked as ipcMain would. */
function handlerFor(
  channel: string,
): (event: unknown, arg: unknown) => Promise<unknown> {
  const call = ipcMainHandleMock.mock.calls.find(([name]) => name === channel);
  if (!call)
    throw new Error(`ipcMain.handle was never called with "${channel}"`);
  return call[1] as (event: unknown, arg: unknown) => Promise<unknown>;
}

function lastRequest(): {
  url: string;
  init: { headers: Record<string, string>; body: string };
} {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, init };
}

function decodeCredentialHeader(header: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

beforeEach(() => {
  jest.clearAllMocks();
  readStoredJiraCredentialMock.mockReturnValue(null);
  fetchMock.mockResolvedValue(
    okResponse({ id: 'prop-abc1234', status: 'executed' }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  delete process.env.WAYPOINT_API_BASE_URL;
  registerProposalApprovalIpc();
});

describe('registerProposalApprovalIpc', () => {
  it('lends the stored Jira credential on approve — the whole reason this lives in main', async () => {
    // Without this header the backend sees no credential, resolves every
    // Jira-targeted proposal as stale, and the Approve button can never do
    // anything. The renderer cannot send it: the API token never leaves this
    // process (see jira/jiraAuth.ts).
    readStoredJiraCredentialMock.mockReturnValue(CREDENTIAL);

    await handlerFor('copilot:proposals:approve')(null, 'prop-abc1234');

    const { url, init } = lastRequest();
    expect(url).toBe(
      'http://localhost:14000/copilot/proposals/prop-abc1234/approve',
    );
    const decoded = decodeCredentialHeader(
      init.headers['x-waypoint-jira-credential'],
    );
    expect(decoded).toEqual({
      site: CREDENTIAL.site,
      email: CREDENTIAL.email,
      apiToken: CREDENTIAL.apiToken,
      displayName: CREDENTIAL.displayName,
    });
  });

  it('omits the header entirely when no Jira account is connected', async () => {
    await handlerFor('copilot:proposals:approve')(null, 'prop-abc1234');

    // Not an empty header, not a null — absent. The backend already handles
    // "Jira is not connected" for the header-absent case, which is what
    // almost every approve is.
    expect(lastRequest().init.headers).not.toHaveProperty(
      'x-waypoint-jira-credential',
    );
  });

  it('never sends the credential on a reject, which executes nothing', async () => {
    readStoredJiraCredentialMock.mockReturnValue(CREDENTIAL);

    await handlerFor('copilot:proposals:reject')(null, 'prop-abc1234');

    const { url, init } = lastRequest();
    expect(url).toBe(
      'http://localhost:14000/copilot/proposals/prop-abc1234/reject',
    );
    expect(init.headers).not.toHaveProperty('x-waypoint-jira-credential');
  });

  it('carries the credential on bulk-approve, against the review-queue router', async () => {
    readStoredJiraCredentialMock.mockReturnValue(CREDENTIAL);
    fetchMock.mockResolvedValue(okResponse({ results: [] }));

    await handlerFor('copilot:proposals:bulk-approve')(null, [
      'prop-a',
      'prop-b',
    ]);

    const { url, init } = lastRequest();
    // Bare /proposals/..., not /copilot/proposals/... — a different router.
    expect(url).toBe('http://localhost:14000/proposals/bulk-approve');
    expect(init.headers['x-waypoint-jira-credential']).toEqual(
      expect.any(String),
    );
    expect(JSON.parse(init.body)).toEqual({ ids: ['prop-a', 'prop-b'] });
  });

  it('re-reads the credential per call, so disconnecting Jira takes effect immediately', async () => {
    readStoredJiraCredentialMock.mockReturnValue(CREDENTIAL);
    await handlerFor('copilot:proposals:approve')(null, 'prop-abc1234');
    expect(lastRequest().init.headers).toHaveProperty(
      'x-waypoint-jira-credential',
    );

    readStoredJiraCredentialMock.mockReturnValue(null);
    await handlerFor('copilot:proposals:approve')(null, 'prop-abc1234');

    expect(lastRequest().init.headers).not.toHaveProperty(
      'x-waypoint-jira-credential',
    );
  });

  it('honors WAYPOINT_API_BASE_URL, the same override the MCP config uses', async () => {
    process.env.WAYPOINT_API_BASE_URL = 'http://127.0.0.1:9999';

    await handlerFor('copilot:proposals:approve')(null, 'prop-abc1234');

    expect(lastRequest().url).toBe(
      'http://127.0.0.1:9999/copilot/proposals/prop-abc1234/approve',
    );
  });

  // IPC is an external input to the privileged process, even though the only
  // caller is this app's own preload bridge — and this id is interpolated
  // into a URL path.
  it.each([
    '../../etc/passwd',
    'prop-1/../../x',
    '',
    'no-underscores_here!',
    42,
  ])(
    'refuses the malformed proposal id %p without issuing a request',
    async (bad) => {
      await expect(
        handlerFor('copilot:proposals:approve')(null, bad),
      ).rejects.toThrow(/Invalid proposal id/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('refuses a whole bulk batch if any id is malformed, rather than silently dropping it', async () => {
    // A partial batch would report success for a set the caller never asked
    // for, and the review screen patches its rows straight from that result.
    await expect(
      handlerFor('copilot:proposals:bulk-approve')(null, ['prop-a', '../../x']),
    ).rejects.toThrow(/Invalid proposal ids/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the backend's own error message, which is what the renderer will show", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'That assignee no longer exists.' }),
    });

    await expect(
      handlerFor('copilot:proposals:approve')(null, 'prop-abc1234'),
    ).rejects.toThrow('That assignee no longer exists.');
  });

  it('falls back to a status-bearing message when the failure body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });

    await expect(
      handlerFor('copilot:proposals:approve')(null, 'prop-abc1234'),
    ).rejects.toThrow(/502/);
  });

  it('returns the finalized proposal verbatim, so the renderer patches its list from it', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ id: 'prop-abc1234', status: 'stale' }),
    );

    const view = await handlerFor('copilot:proposals:approve')(
      null,
      'prop-abc1234',
    );

    // 200 with status 'stale' is a normal outcome, not an error — the status
    // field IS the result (see the backend's approveProposal).
    expect(view).toEqual({ id: 'prop-abc1234', status: 'stale' });
  });
});
