import { getActiveMemberId } from './activeIdentity';
import { CURRENT_USER_ID } from './currentUser';

const account = {
  status: jest.fn(),
  hostedFetch: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  (window as unknown as { electron: unknown }).electron = { account };
});

describe('getActiveMemberId', () => {
  it('falls back to the Personal constant when nothing is signed in', async () => {
    account.status.mockResolvedValue({ connected: false, identity: null });
    await expect(getActiveMemberId()).resolves.toBe(CURRENT_USER_ID);
    expect(account.hostedFetch).not.toHaveBeenCalled();
  });

  it('falls back when signed in but no workspace is active', async () => {
    account.status.mockResolvedValue({
      connected: true,
      identity: { backendUrl: 'https://x', email: 'a@x.test', fullName: 'A', avatarUrl: null, activeWorkspaceId: null },
    });
    await expect(getActiveMemberId()).resolves.toBe(CURRENT_USER_ID);
    expect(account.hostedFetch).not.toHaveBeenCalled();
  });

  it('resolves the real member id via GET /me when a workspace is active', async () => {
    account.status.mockResolvedValue({
      connected: true,
      identity: { backendUrl: 'https://x', email: 'a@x.test', fullName: 'A', avatarUrl: null, activeWorkspaceId: 'ws-1' },
    });
    account.hostedFetch.mockResolvedValue({ ok: true, status: 200, body: { id: 'mem-real' } });
    await expect(getActiveMemberId()).resolves.toBe('mem-real');
    expect(account.hostedFetch).toHaveBeenCalledWith({ path: '/me' });
  });

  it('falls back when the hosted call fails', async () => {
    account.status.mockResolvedValue({
      connected: true,
      identity: { backendUrl: 'https://x', email: 'a@x.test', fullName: 'A', avatarUrl: null, activeWorkspaceId: 'ws-1' },
    });
    account.hostedFetch.mockResolvedValue({ ok: false, message: 'refused' });
    await expect(getActiveMemberId()).resolves.toBe(CURRENT_USER_ID);
  });

  it('falls back rather than rejecting when window.electron itself is unavailable', async () => {
    (window as unknown as { electron: unknown }).electron = undefined;
    await expect(getActiveMemberId()).resolves.toBe(CURRENT_USER_ID);
  });

  it('falls back when account:status itself rejects', async () => {
    account.status.mockRejectedValue(new Error('IPC channel closed'));
    await expect(getActiveMemberId()).resolves.toBe(CURRENT_USER_ID);
  });
});
