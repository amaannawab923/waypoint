const ipcMainHandleMock = jest.fn();
jest.mock('electron', () => ({ ipcMain: { handle: ipcMainHandleMock } }));

const readStoredAccountCredentialMock = jest.fn();
const writeStoredAccountCredentialMock = jest.fn();
const deleteStoredAccountCredentialMock = jest.fn();
const isAccountSecureStorageAvailableMock = jest.fn(() => true);
jest.mock('./accountAuth', () => ({
  readStoredAccountCredential: () => readStoredAccountCredentialMock(),
  writeStoredAccountCredential: (c: unknown) => writeStoredAccountCredentialMock(c),
  deleteStoredAccountCredential: () => deleteStoredAccountCredentialMock(),
  isAccountSecureStorageAvailable: () => isAccountSecureStorageAvailableMock(),
  toAccountIdentity: (c: { backendUrl: string; email: string; fullName: string; avatarUrl: string | null }) => ({
    backendUrl: c.backendUrl,
    email: c.email,
    fullName: c.fullName,
    avatarUrl: c.avatarUrl,
  }),
}));

const checkInstanceSetupStatusMock = jest.fn();
const startSignInMock = jest.fn();
const cancelSignInMock = jest.fn();
const revokeAccountSessionMock = jest.fn().mockResolvedValue(undefined);
jest.mock('./accountSignIn', () => ({
  checkInstanceSetupStatus: () => checkInstanceSetupStatusMock(),
  startSignIn: (purpose: unknown) => startSignInMock(purpose),
  cancelSignIn: () => cancelSignInMock(),
  revokeAccountSession: (backendUrl: unknown, token: unknown) => revokeAccountSessionMock(backendUrl, token),
}));

// eslint-disable-next-line import/order, import/first
import { registerAccountIpc } from './accountIpc';

const CREDENTIAL = {
  backendUrl: 'https://backend.example.test',
  token: 'tok-secret-do-not-return',
  email: 'jordan@example.test',
  fullName: 'Jordan Reyes',
  avatarUrl: null as string | null,
};

function getHandler(channel: string) {
  const call = ipcMainHandleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`ipcMain.handle was never called with "${channel}"`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

beforeEach(() => {
  jest.clearAllMocks();
  isAccountSecureStorageAvailableMock.mockReturnValue(true);
  registerAccountIpc();
});

describe('account:status', () => {
  it('reports disconnected with nothing stored', () => {
    readStoredAccountCredentialMock.mockReturnValue(null);
    expect(getHandler('account:status')({})).toEqual({ connected: false, identity: null });
  });

  it('reports connected with an identity projection, never the token', () => {
    readStoredAccountCredentialMock.mockReturnValue(CREDENTIAL);
    const res = getHandler('account:status')({}) as { connected: boolean; identity: Record<string, unknown> };
    expect(res.connected).toBe(true);
    expect(res.identity).not.toHaveProperty('token');
    expect(JSON.stringify(res)).not.toContain(CREDENTIAL.token);
  });
});

describe('account:setupStatus', () => {
  it('passes the checkInstanceSetupStatus result straight through', async () => {
    const value = { ok: true, value: { setupRequired: false, instanceName: 'X', authMethods: ['email'], signupMode: 'open' } };
    checkInstanceSetupStatusMock.mockResolvedValue(value);
    await expect(getHandler('account:setupStatus')({})).resolves.toEqual(value);
  });
});

describe('account:signIn', () => {
  it('refuses before ever opening a browser when secure storage is unavailable', async () => {
    isAccountSecureStorageAvailableMock.mockReturnValue(false);
    const res = await getHandler('account:signIn')({}, { purpose: 'sync' });
    expect(res).toMatchObject({ ok: false, reason: 'storage_unavailable' });
    expect(startSignInMock).not.toHaveBeenCalled();
  });

  it('passes through a startSignIn failure (e.g. cancelled) without writing anything', async () => {
    startSignInMock.mockResolvedValue({ ok: false, reason: 'cancelled', message: 'Cancelled.' });
    const res = await getHandler('account:signIn')({}, { purpose: 'sync' });
    expect(res).toEqual({ ok: false, reason: 'cancelled', message: 'Cancelled.' });
    expect(writeStoredAccountCredentialMock).not.toHaveBeenCalled();
  });

  it('on success, stores the credential and returns the identity projection only', async () => {
    startSignInMock.mockResolvedValue({
      ok: true,
      value: {
        backendUrl: CREDENTIAL.backendUrl,
        token: CREDENTIAL.token,
        email: CREDENTIAL.email,
        fullName: CREDENTIAL.fullName,
        avatarUrl: CREDENTIAL.avatarUrl,
        purpose: 'fairweather-labs',
      },
    });
    const res = (await getHandler('account:signIn')({}, { purpose: 'fairweather-labs' })) as {
      ok: true;
      value: Record<string, unknown>;
    };
    expect(startSignInMock).toHaveBeenCalledWith('fairweather-labs');
    expect(writeStoredAccountCredentialMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: CREDENTIAL.token, email: CREDENTIAL.email }),
    );
    expect(res.ok).toBe(true);
    expect(res.value).not.toHaveProperty('token');
    expect(JSON.stringify(res)).not.toContain(CREDENTIAL.token);
  });

  it('resolves, never throws, when the credential cannot be saved after a real sign-in', async () => {
    startSignInMock.mockResolvedValue({
      ok: true,
      value: { ...CREDENTIAL, purpose: null },
    });
    writeStoredAccountCredentialMock.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    const res = await getHandler('account:signIn')({}, { purpose: '' });
    expect(res).toMatchObject({ ok: false, reason: 'storage_unavailable' });
  });

  it('treats a missing purpose as undefined, not the empty string, on the way to startSignIn', async () => {
    startSignInMock.mockResolvedValue({ ok: false, reason: 'cancelled', message: 'x' });
    await getHandler('account:signIn')({}, {});
    expect(startSignInMock).toHaveBeenCalledWith(undefined);
  });
});

describe('account:signIn:cancel', () => {
  it('calls cancelSignIn and answers ok', () => {
    expect(getHandler('account:signIn:cancel')({})).toEqual({ ok: true });
    expect(cancelSignInMock).toHaveBeenCalledTimes(1);
  });
});

describe('account:signOut', () => {
  it('revokes the session on the backend, then deletes the stored credential, then answers ok', async () => {
    readStoredAccountCredentialMock.mockReturnValue(CREDENTIAL);
    await expect(getHandler('account:signOut')({})).resolves.toEqual({ ok: true });
    expect(revokeAccountSessionMock).toHaveBeenCalledWith(CREDENTIAL.backendUrl, CREDENTIAL.token);
    expect(deleteStoredAccountCredentialMock).toHaveBeenCalledTimes(1);
    // Revoke (which needs the token) happens before delete (which would
    // lose it) — order matters, not just that both were called.
    const revokeOrder = revokeAccountSessionMock.mock.invocationCallOrder[0];
    const deleteOrder = deleteStoredAccountCredentialMock.mock.invocationCallOrder[0];
    expect(revokeOrder).toBeLessThan(deleteOrder);
  });

  it('still deletes the local credential and answers ok when nothing was stored — no revoke call with no token', async () => {
    readStoredAccountCredentialMock.mockReturnValue(null);
    await expect(getHandler('account:signOut')({})).resolves.toEqual({ ok: true });
    expect(revokeAccountSessionMock).not.toHaveBeenCalled();
    expect(deleteStoredAccountCredentialMock).toHaveBeenCalledTimes(1);
  });
});
