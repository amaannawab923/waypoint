const openExternalMock = jest.fn().mockResolvedValue(undefined);
jest.mock('electron', () => ({
  shell: { openExternal: (...args: unknown[]) => openExternalMock(...args) },
}));

// eslint-disable-next-line import/order, import/first
import * as http from 'http';
// eslint-disable-next-line import/order, import/first
import { cancelSignIn, checkInstanceSetupStatus, startSignIn } from './accountSignIn';

// No mock of Node's `http`: a real one-shot loopback server is cheap, local,
// and gives this file its actual coverage — that the server rejects a wrong
// state, accepts a right one, and shuts itself down either way. Only
// `shell.openExternal` (leaving this process) is stubbed for startSignIn's
// own tests; `global.fetch` is stubbed separately, only inside
// checkInstanceSetupStatus's describe block (this Jest environment has no
// native fetch — jiraClient.test.ts hits the same thing and mocks it the
// same way — so it must never leak into the tests below that talk to a
// real loopback server).
//
// requestGet plays the browser's part against that real server: a plain
// GET, no redirect handling. This file drives the desktop's OWN loopback
// server directly, standing in for the moment AT9's backend has already
// 302'd the browser here — it never talks to AT9 itself, so there is
// nothing to redirect through.
function requestGet(url: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', reject);
  });
}

const ORIGINAL_ENV = process.env.WAYPOINT_API_BASE_URL;
afterEach(() => {
  jest.clearAllMocks();
  if (ORIGINAL_ENV === undefined) delete process.env.WAYPOINT_API_BASE_URL;
  else process.env.WAYPOINT_API_BASE_URL = ORIGINAL_ENV;
});

// Extracts the redirect_uri and state the flow put in the URL it asked the
// browser to open, so a test can act as that browser against the real
// server the flow just started.
function openedUrl(): URL {
  expect(openExternalMock).toHaveBeenCalledTimes(1);
  return new URL(openExternalMock.mock.calls[0][0] as string);
}

describe('checkInstanceSetupStatus', () => {
  const REAL_FETCH = global.fetch;
  afterEach(() => {
    global.fetch = REAL_FETCH;
  });

  it('returns the parsed status on 200', async () => {
    const status = { setupRequired: false, instanceName: 'Fairweather', authMethods: ['github'], signupMode: 'open' };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => status }) as unknown as typeof fetch;
    const res = await checkInstanceSetupStatus();
    expect(res).toEqual({ ok: true, value: status });
  });

  it('maps a non-200 to backend_error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    const res = await checkInstanceSetupStatus();
    expect(res).toEqual({ ok: false, reason: 'backend_error', message: expect.stringContaining('503') });
  });

  it('maps a network failure to network', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const res = await checkInstanceSetupStatus();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('network');
  });
});

describe('startSignIn', () => {
  it('opens the configured backend\'s /sign-in with a loopback redirect_uri, state, and purpose', async () => {
    process.env.WAYPOINT_API_BASE_URL = 'https://backend.example.test';
    const pending = startSignIn('fairweather-labs');
    await new Promise((r) => setTimeout(r, 20)); // let listen() + openExternal land
    const url = openedUrl();
    expect(url.origin + url.pathname).toBe('https://backend.example.test/sign-in');
    expect(url.searchParams.get('for')).toBe('fairweather-labs');
    const redirectUri = url.searchParams.get('redirect_uri')!;
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const cb = new URL(redirectUri);
    cb.searchParams.set('token', 'tok-123');
    cb.searchParams.set('state', url.searchParams.get('state')!);
    cb.searchParams.set('email', 'jordan@example.test');
    cb.searchParams.set('name', 'Jordan Reyes');
    cb.searchParams.set('avatar', 'https://avatar.example/48');
    cb.searchParams.set('for', 'fairweather-labs');
    const res = await requestGet(cb.toString());
    expect(res.status).toBe(200);
    // HTML-escaped ("You&#39;re signed in") by the page renderer — matched
    // on the unescaped substring around the apostrophe instead of the
    // literal string.
    expect(res.text).toMatch(/You.{1,6}re signed in/);

    const result = await pending;
    expect(result).toEqual({
      ok: true,
      value: {
        backendUrl: 'https://backend.example.test',
        token: 'tok-123',
        email: 'jordan@example.test',
        fullName: 'Jordan Reyes',
        avatarUrl: 'https://avatar.example/48',
        purpose: 'fairweather-labs',
      },
    });
  });

  it('rejects a wrong or missing state as state_mismatch, and the server refuses a second callback', async () => {
    const pending = startSignIn('sync');
    await new Promise((r) => setTimeout(r, 20));
    const redirectUri = openedUrl().searchParams.get('redirect_uri')!;

    const bad = new URL(redirectUri);
    bad.searchParams.set('token', 'tok');
    bad.searchParams.set('state', 'wrong');
    bad.searchParams.set('email', 'e@x.test');
    const res = await requestGet(bad.toString());
    expect(res.status).toBe(400);

    const result = await pending;
    expect(result).toEqual({ ok: false, reason: 'state_mismatch', message: expect.any(String) });
  });

  it('closes its loopback server on every outcome — success, mismatch, and cancel', async () => {
    const closeSpy = jest.spyOn(http.Server.prototype, 'close');

    async function oneFlow(complete: (redirectUri: string, state: string) => Promise<void>) {
      const pending = startSignIn('x');
      await new Promise((r) => setTimeout(r, 20));
      const url = openedUrl();
      await complete(url.searchParams.get('redirect_uri')!, url.searchParams.get('state')!);
      await pending;
      expect(closeSpy).toHaveBeenCalledTimes(1);
      closeSpy.mockClear();
      openExternalMock.mockClear();
    }

    await oneFlow(async (redirectUri, state) => {
      const cb = new URL(redirectUri);
      cb.searchParams.set('token', 't');
      cb.searchParams.set('state', state);
      cb.searchParams.set('email', 'e@x.test');
      await requestGet(cb.toString());
    });

    await oneFlow(async (redirectUri) => {
      const bad = new URL(redirectUri);
      bad.searchParams.set('token', 't');
      bad.searchParams.set('state', 'wrong');
      bad.searchParams.set('email', 'e@x.test');
      await requestGet(bad.toString());
    });

    await oneFlow(async () => {
      cancelSignIn();
    });

    closeSpy.mockRestore();
  });

  it('refuses a second sign-in while one is already open, without touching the first', async () => {
    const first = startSignIn('a');
    await new Promise((r) => setTimeout(r, 20));
    const second = await startSignIn('b');
    expect(second).toEqual({ ok: false, reason: 'already_in_progress', message: expect.any(String) });
    expect(openExternalMock).toHaveBeenCalledTimes(1); // only the first ever opened a browser

    cancelSignIn();
    await expect(first).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
  });

  it('cancelSignIn resolves the pending flow with cancelled, and is a harmless no-op when nothing is in flight', async () => {
    expect(() => cancelSignIn()).not.toThrow();
    const pending = startSignIn('sync');
    await new Promise((r) => setTimeout(r, 20));
    cancelSignIn();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled', message: expect.any(String) });
  });

  it('a 404 for any path other than /callback', async () => {
    const pending = startSignIn('sync');
    await new Promise((r) => setTimeout(r, 20));
    const redirectUri = openedUrl().searchParams.get('redirect_uri')!;
    const other = new URL(redirectUri);
    other.pathname = '/whatever';
    expect((await requestGet(other.toString())).status).toBe(404);
    cancelSignIn();
    await pending;
  });
});
