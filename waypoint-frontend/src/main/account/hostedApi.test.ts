const readStoredAccountCredentialMock = jest.fn();
jest.mock('./accountAuth', () => ({
  readStoredAccountCredential: () => readStoredAccountCredentialMock(),
}));

// eslint-disable-next-line import/order, import/first
import { hostedFetch } from './hostedApi';

const CREDENTIAL = {
  backendUrl: 'https://backend.example.test',
  token: 'tok-secret-do-not-return',
  email: 'jordan@example.test',
  fullName: 'Jordan Reyes',
  avatarUrl: null as string | null,
  activeWorkspaceId: 'ws-fairweather' as string | null,
};

// This Jest environment has no native fetch (accountSignIn.test.ts hits
// the same gap and mocks it the same way) — stubbed per test, never left
// set between them.
const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (global as unknown as { fetch: typeof fetch }).fetch = fetchMock;
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('hostedFetch', () => {
  it('refuses before ever calling fetch when nothing is signed in', async () => {
    readStoredAccountCredentialMock.mockReturnValue(null);
    const res = await hostedFetch({ path: '/workspaces' });
    expect(res).toEqual({ ok: false, message: expect.stringContaining('Not signed in') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attaches the Bearer token and the workspace header when one is active', async () => {
    readStoredAccountCredentialMock.mockReturnValue(CREDENTIAL);
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await hostedFetch({ path: '/tickets' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://backend.example.test/tickets');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-secret-do-not-return');
    expect(headers['X-Waypoint-Workspace-Id']).toBe('ws-fairweather');
  });

  it('omits the workspace header entirely when no workspace is active — for routes that work without one', async () => {
    readStoredAccountCredentialMock.mockReturnValue({ ...CREDENTIAL, activeWorkspaceId: null });
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'ws-1' }));
    await hostedFetch({ path: '/workspaces', method: 'POST', body: { name: 'Fairweather Labs' } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('X-Waypoint-Workspace-Id');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'Fairweather Labs' }));
  });

  it('never lets the raw session token leak into a returned error message', async () => {
    readStoredAccountCredentialMock.mockReturnValue(CREDENTIAL);
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'not_a_member', message: "You aren't a member of that workspace." }));
    const res = await hostedFetch({ path: '/tickets' });
    expect(res).toEqual({ ok: false, status: 403, message: "You aren't a member of that workspace." });
    expect(JSON.stringify(res)).not.toContain(CREDENTIAL.token);
  });

  it('falls back to a generic message when the error body has neither message nor error', async () => {
    readStoredAccountCredentialMock.mockReturnValue(CREDENTIAL);
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    const res = await hostedFetch({ path: '/tickets' });
    expect(res).toMatchObject({ ok: false, status: 500 });
  });

  it('a network failure resolves { ok: false } with no status, distinct from a real HTTP error', async () => {
    readStoredAccountCredentialMock.mockReturnValue(CREDENTIAL);
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const res = await hostedFetch({ path: '/tickets' });
    expect(res).toEqual({ ok: false, message: expect.stringContaining("Couldn't reach the backend") });
    expect(res).not.toHaveProperty('status');
  });

  it('a successful response with no body (204) returns a null body, not a JSON.parse throw', async () => {
    readStoredAccountCredentialMock.mockReturnValue(CREDENTIAL);
    fetchMock.mockResolvedValue({ ok: true, status: 204, text: () => Promise.resolve('') } as unknown as Response);
    const res = await hostedFetch({ path: '/workspaces/ws-1/invites/inv-1', method: 'DELETE' });
    expect(res).toEqual({ ok: true, status: 204, body: null });
  });
});
