import {
  HostedApiError,
  createTeamWorkspace,
  createWorkspaceInvite,
  listMyWorkspaces,
  revokeWorkspaceInvite,
  setActiveWorkspace,
} from './hostedWorkspace';

const account = {
  hostedFetch: jest.fn(),
  setActiveWorkspace: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  (window as unknown as { electron: unknown }).electron = { account };
});

const WORKSPACE = {
  id: 'ws-1',
  name: 'Fairweather Labs',
  slug: 'fairweather-labs',
  isPersonal: false,
  myMemberId: 'mem-1',
  myRole: 'admin' as const,
};

describe('createTeamWorkspace', () => {
  it('posts the name and returns the created workspace', async () => {
    account.hostedFetch.mockResolvedValue({ ok: true, status: 201, body: WORKSPACE });
    await expect(createTeamWorkspace('Fairweather Labs')).resolves.toEqual(WORKSPACE);
    expect(account.hostedFetch).toHaveBeenCalledWith({ path: '/workspaces', method: 'POST', body: { name: 'Fairweather Labs' } });
  });

  it('throws HostedApiError, carrying the backend\'s own message and status, on failure', async () => {
    account.hostedFetch.mockResolvedValue({ ok: false, status: 401, message: 'Sign in required' });
    await expect(createTeamWorkspace('X')).rejects.toMatchObject({ message: 'Sign in required', status: 401 });
    await expect(createTeamWorkspace('X')).rejects.toBeInstanceOf(HostedApiError);
  });
});

describe('listMyWorkspaces', () => {
  it('returns the list as-is', async () => {
    account.hostedFetch.mockResolvedValue({ ok: true, status: 200, body: [WORKSPACE] });
    await expect(listMyWorkspaces()).resolves.toEqual([WORKSPACE]);
    expect(account.hostedFetch).toHaveBeenCalledWith({ path: '/workspaces', method: undefined, body: undefined });
  });
});

describe('createWorkspaceInvite', () => {
  it('omits the body entirely for a plain "Copy link" invite (no email)', async () => {
    account.hostedFetch.mockResolvedValue({ ok: true, status: 201, body: { id: 'inv-1', expiresAt: 'x', joinUrl: 'https://x/join/tok' } });
    await createWorkspaceInvite('ws-1');
    expect(account.hostedFetch).toHaveBeenCalledWith({ path: '/workspaces/ws-1/invites', method: 'POST', body: {} });
  });

  it('sends the email for "Email invite instead", and encodes the workspace id in the path', async () => {
    account.hostedFetch.mockResolvedValue({ ok: true, status: 201, body: { id: 'inv-1', expiresAt: 'x', joinUrl: 'https://x/join/tok' } });
    await createWorkspaceInvite('ws with space', 'jordan@example.test');
    expect(account.hostedFetch).toHaveBeenCalledWith({
      path: '/workspaces/ws%20with%20space/invites',
      method: 'POST',
      body: { email: 'jordan@example.test' },
    });
  });
});

describe('revokeWorkspaceInvite', () => {
  it('DELETEs the invite by workspace and invite id, both encoded', async () => {
    account.hostedFetch.mockResolvedValue({ ok: true, status: 204, body: null });
    await revokeWorkspaceInvite('ws-1', 'inv-1');
    expect(account.hostedFetch).toHaveBeenCalledWith({ path: '/workspaces/ws-1/invites/inv-1', method: 'DELETE', body: undefined });
  });
});

describe('setActiveWorkspace', () => {
  it('resolves true on success', async () => {
    account.setActiveWorkspace.mockResolvedValue({ ok: true });
    await expect(setActiveWorkspace('ws-1')).resolves.toBe(true);
    expect(account.setActiveWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('resolves false rather than throwing on a storage failure', async () => {
    account.setActiveWorkspace.mockResolvedValue({ ok: false });
    await expect(setActiveWorkspace(null)).resolves.toBe(false);
  });
});
