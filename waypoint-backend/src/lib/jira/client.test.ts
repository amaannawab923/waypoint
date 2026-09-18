import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jiraGet, jiraPost, type JiraCredential } from './client';

// This layer had zero direct coverage before this file: every failure case
// in providers/jira.ts's own tests is driven through a hand-built fail()
// helper that never touches this module's actual status-code mapping, URL
// construction, or network-error classification. That's the real transport
// underneath every Jira read and write this app ships — a bug in timeout
// handling, status classification, or URL building here would pass every
// other test in the suite undetected.
//
// Pattern mirrors waypoint-frontend/src/main/jira/jiraClient.test.ts (the
// module comment in client.ts explains why that one isn't reused directly):
// a mocked global.fetch, jsonResponse/emptyResponse builders, and asserting
// on the actual constructed URL/headers/body rather than trusting them.
//
// Deliberately NOT covered here: the exact race where the abort timer
// outlives `fetch()` itself to also bound a stalled response.text() read
// (jiraRequest's own comment explains why that's deliberate). A mocked
// fetch doesn't implement AbortSignal semantics, so a test built on one
// can't actually exercise that race — asserting it would either be
// vacuous or would require reimplementing enough of real Fetch/AbortController
// to be its own dependency, disproportionate to one timing detail.

const CREDENTIAL: JiraCredential = {
  site: 'waypoint123.atlassian.net',
  email: 'max@northwind.dev',
  apiToken: 'ATATT3xFfGF0-not-a-real-token',
};

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function emptyResponse(status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => '',
  } as unknown as Response;
}

function textResponse(body: string, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  } as unknown as Response;
}

/** The URL and init of the nth fetch call. */
function call(index = 0): [string, RequestInit] {
  return fetchMock.mock.calls[index] as [string, RequestInit];
}

function headerValue(index: number, name: string): string | undefined {
  const headers = call(index)[1].headers as Record<string, string>;
  return headers[name];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

describe('request building', () => {
  it('builds the URL from the credential site and the given path, never a hardcoded host', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4');

    expect(call()[0]).toBe('https://waypoint123.atlassian.net/rest/api/3/issue/ENG-4');
  });

  it('appends query params via URLSearchParams', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await jiraGet(CREDENTIAL, '/rest/api/3/search/jql', { jql: 'project = ENG', maxResults: '50' });

    const params = new URL(call()[0]).searchParams;
    expect(params.get('jql')).toBe('project = ENG');
    expect(params.get('maxResults')).toBe('50');
  });

  it('authenticates with HTTP Basic over base64(email:apiToken)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4');

    expect(headerValue(0, 'Authorization')).toBe(
      `Basic ${Buffer.from(`${CREDENTIAL.email}:${CREDENTIAL.apiToken}`).toString('base64')}`,
    );
  });

  // A credential in a query string ends up in proxy logs, browser history and
  // crash reports. It belongs in the header and nowhere else.
  it('never puts the token or email in the URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4');

    expect(call()[0]).not.toContain(CREDENTIAL.apiToken);
    expect(call()[0]).not.toContain(CREDENTIAL.email);
  });

  it('sends no Content-Type or body on a GET', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4');

    expect(headerValue(0, 'Content-Type')).toBeUndefined();
    expect(call()[1].body).toBeUndefined();
    expect(call()[1].method).toBe('GET');
  });

  it('sends the JSON-serialized body and a matching Content-Type on a POST', async () => {
    fetchMock.mockResolvedValue(emptyResponse(204));

    await jiraPost(CREDENTIAL, '/rest/api/3/issue/ENG-4/transitions', {
      transition: { id: '31' },
    });

    expect(call()[1].method).toBe('POST');
    expect(headerValue(0, 'Content-Type')).toBe('application/json');
    expect(call()[1].body).toBe(JSON.stringify({ transition: { id: '31' } }));
  });

  // jiraPost's own doc comment: T is frequently void, since Jira answers a
  // transition POST with 204 and an empty body.
  it('treats a 204 with an empty body as ok with an undefined value', async () => {
    fetchMock.mockResolvedValue(emptyResponse(204));

    expect(await jiraPost(CREDENTIAL, '/rest/api/3/issue/ENG-4/transitions', {})).toEqual({
      ok: true,
      value: undefined,
    });
  });
});

describe('success responses', () => {
  it('parses a JSON body and returns it as the value', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ key: 'ENG-4', fields: { summary: 'Checkout 500s' } }));

    const result = await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4');

    expect(result).toEqual({ ok: true, value: { key: 'ENG-4', fields: { summary: 'Checkout 500s' } } });
  });

  // A hostname that answers on https with a login page or a parked-domain
  // page is not a Jira site; saying so beats a downstream "cannot read
  // property of undefined" several layers up.
  it('reports a 200 that is not JSON as site_not_found, not a parse crash', async () => {
    fetchMock.mockResolvedValue(textResponse('<!doctype html><title>Parked domain</title>'));

    expect(await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4')).toEqual({
      ok: false,
      reason: 'site_not_found',
      message: 'That address answered, but not like a Jira Cloud site — check the site address.',
    });
  });
});

describe('status-code classification', () => {
  it('reports 401 as invalid_credentials', async () => {
    fetchMock.mockResolvedValue(emptyResponse(401));

    expect(await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4')).toMatchObject({
      ok: false,
      reason: 'invalid_credentials',
    });
  });

  it('reports 403 as forbidden', async () => {
    fetchMock.mockResolvedValue(emptyResponse(403));

    expect(await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4')).toMatchObject({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('reports 404 as not_found, carrying Jira\'s own errorMessages text', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errorMessages: ['Issue does not exist'] }, 404));

    expect(await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-999')).toEqual({
      ok: false,
      reason: 'not_found',
      message: 'Issue does not exist',
    });
  });

  it('falls back to a generic message when a 404 body carries nothing usable', async () => {
    fetchMock.mockResolvedValue(emptyResponse(404));

    expect(await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-999')).toEqual({
      ok: false,
      reason: 'not_found',
      message: 'Jira has no such issue.',
    });
  });

  it('reports 429 as rate_limited', async () => {
    fetchMock.mockResolvedValue(emptyResponse(429));

    expect(await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4')).toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
  });

  // A 400 on a transition POST is the normal "that move isn't legal right
  // now" case — jira_error is the catch-all for every status this file
  // doesn't special-case, carrying Jira's own explanation through.
  it('reports an unrecognized status (e.g. 400) as jira_error, carrying the errors-object text', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ errors: { transition: 'Transition id 31 is not valid for issue ENG-4.' } }, 400),
    );

    expect(await jiraPost(CREDENTIAL, '/rest/api/3/issue/ENG-4/transitions', { transition: { id: '31' } })).toEqual({
      ok: false,
      reason: 'jira_error',
      message: 'Transition id 31 is not valid for issue ENG-4.',
    });
  });

  it('falls back to a status-bearing message when a non-2xx body is not JSON at all', async () => {
    fetchMock.mockResolvedValue(textResponse('<html>Internal Server Error</html>', 500));

    expect(await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4')).toEqual({
      ok: false,
      reason: 'jira_error',
      message: 'Jira returned 500.',
    });
  });
});

describe('network-error classification', () => {
  it('reports an aborted request (timeout) as network, with the timeout-specific message', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));

    expect(await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4')).toEqual({
      ok: false,
      reason: 'network',
      message: 'Jira took too long to respond.',
    });
  });

  // Distinguishes "this Jira site's hostname doesn't resolve" (a typo'd or
  // stale site) from a generic connectivity failure — the connect/read UI
  // needs to say something different for each.
  it('reports a DNS-resolution failure (ENOTFOUND) as site_not_found', async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));

    expect(await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4')).toMatchObject({
      ok: false,
      reason: 'site_not_found',
    });
  });

  it('reports EAI_AGAIN (transient DNS failure) as site_not_found too', async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } }));

    expect(await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4')).toMatchObject({
      ok: false,
      reason: 'site_not_found',
    });
  });

  it('reports any other network failure (e.g. connection refused) as a generic network error', async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));

    expect(await jiraGet(CREDENTIAL, '/rest/api/3/issue/ENG-4')).toEqual({
      ok: false,
      reason: 'network',
      message: "Couldn't reach Jira.",
    });
  });
});

// ROAD-157: the allowlist added alongside the dashboard/filter endpoints —
// narrowness enforced as a runtime property (see client.ts's own header
// comment), not just described. Every prefix here has to have a real,
// reviewed caller in providers/jira.ts; this file's job is only to prove the
// gate itself works, both ways, not to re-verify each caller's own path.
describe('path allowlist', () => {
  it('rejects a path outside every allowed prefix, before any fetch happens', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    await expect(jiraGet(CREDENTIAL, '/rest/gadget/1.0/portal/foo')).rejects.toThrow(
      /outside this client's allowed path scope/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a path that only shares a prefix by accident (no trailing slash/segment boundary)', async () => {
    // '/rest/api/3/issue/' (with the trailing slash) is allowed;
    // '/rest/api/3/issuetype' is a real, different Jira endpoint this client
    // has never called and must not be let through just because the two
    // strings share a run of characters.
    await expect(jiraGet(CREDENTIAL, '/rest/api/3/issuetype')).rejects.toThrow(
      /outside this client's allowed path scope/,
    );
  });

  it.each([
    '/rest/api/3/issue/ENG-4',
    '/rest/api/3/issue/ENG-4/comment',
    '/rest/api/3/issue/ENG-4/transitions',
    '/rest/api/3/search/jql',
    '/rest/api/3/dashboard',
    '/rest/api/3/dashboard/10000/gadget',
    '/rest/api/3/dashboard/10000/items/10001/properties/config',
    '/rest/api/3/filter/10123',
    '/rest/api/3/filter/search',
  ])('allows %s straight through to fetch', async (path) => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await jiraGet(CREDENTIAL, path);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Round-1 review (ROAD-157): a "../" segment in an interpolated id (e.g. a
  // dashboard gadget id, which comes from Jira's own response body, not a
  // literal this codebase wrote) resolves away under new URL(...) before
  // fetch ever sees it — so the check has to run against the NORMALIZED
  // path, not the pre-normalization string a naive prefix test would see.
  it('checks the path fetch will actually receive, not the pre-normalization string', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    // Would prefix-match '/rest/api/3/dashboard' as a raw string, but
    // normalizes (via new URL) to '/rest/api/3/gadget' — outside every
    // allowed prefix.
    await expect(
      jiraGet(CREDENTIAL, `/rest/api/3/dashboard/${encodeURIComponent('..')}/gadget`),
    ).rejects.toThrow(/outside this client's allowed path scope/);
    expect(fetchMock).not.toHaveBeenCalled();

    // Normalizes to '/rest/api/3/', which is still inside the allowed
    // '/rest/api/3/filter' family only by accident of this specific example
    // — asserting the actually-dispatched URL, not just that fetch fired,
    // so a future prefix change can't silently make this vacuous.
    await jiraGet(CREDENTIAL, `/rest/api/3/filter/${encodeURIComponent('..')}/filter/10123`);
    expect(call()[0]).toBe('https://waypoint123.atlassian.net/rest/api/3/filter/10123');
  });
});
