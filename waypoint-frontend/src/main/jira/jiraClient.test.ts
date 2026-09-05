import type { JiraCredential } from './jiraAuth';

const readStoredJiraCredentialMock = jest.fn<JiraCredential | null, []>();
jest.mock('./jiraAuth', () => ({
  readStoredJiraCredential: () => readStoredJiraCredentialMock(),
}));

// eslint-disable-next-line import/order, import/first
import {
  listComments,
  listMyTickets,
  listTransitions,
  postComment,
  transitionTicket,
  validateCredential,
} from './jiraClient';

const CREDENTIAL: JiraCredential = {
  site: 'waypoint123.atlassian.net',
  email: 'max@northwind.dev',
  apiToken: 'ATATT3xFfGF0-not-a-real-token',
  accountId: '5f8a1b2c3d4e5f6a7b8c9d0e',
  displayName: 'Max Chen',
  avatarUrl: null,
};

const fetchMock = jest.fn();

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

/** The URL and init of the nth fetch this test made. */
function call(index = 0): [string, RequestInit] {
  return fetchMock.mock.calls[index] as [string, RequestInit];
}

function headerValue(index: number, name: string): string {
  const headers = call(index)[1].headers as Record<string, string>;
  return headers[name];
}

beforeEach(() => {
  jest.clearAllMocks();
  readStoredJiraCredentialMock.mockReturnValue(CREDENTIAL);
  (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

describe('request building', () => {
  it('authenticates with HTTP Basic over base64(email:apiToken), against the stored site only', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ issues: [] }));

    await listMyTickets();

    const [url] = call();
    expect(url).toMatch(/^https:\/\/waypoint123\.atlassian\.net\//);
    expect(headerValue(0, 'Authorization')).toBe(
      `Basic ${Buffer.from(`${CREDENTIAL.email}:${CREDENTIAL.apiToken}`).toString('base64')}`,
    );
  });

  // A credential in a query string ends up in proxy logs, browser history and
  // crash reports. It belongs in the header and nowhere else.
  it('never puts the token in the URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ issues: [] }));

    await listMyTickets();

    expect(call()[0]).not.toContain(CREDENTIAL.apiToken);
    expect(call()[0]).not.toContain(CREDENTIAL.email);
  });

  // JQL binds AND tighter than OR: without the parentheses the Unresolved
  // filter would apply only to the watcher clause, and the queue would fill
  // with issues closed months ago.
  it('groups the three role clauses so "Unresolved" applies to all of them', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ issues: [] }));

    await listMyTickets();

    const jql = new URL(call()[0]).searchParams.get('jql') ?? '';
    expect(jql).toContain(
      '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())',
    );
    expect(jql).toContain('AND resolution = Unresolved');
  });

  it('asks for the field names it needs to find per-site custom fields', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ issues: [] }));

    await listMyTickets();

    const params = new URL(call()[0]).searchParams;
    expect(params.get('fields')).toBe('*all');
    expect(params.get('expand')).toContain('names');
  });
});

describe('validateCredential', () => {
  it('returns the identity Jira itself reports for a good token', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        accountId: CREDENTIAL.accountId,
        emailAddress: 'max@northwind.dev',
        displayName: 'Max Chen',
        avatarUrls: { '48x48': 'https://avatar.example/48' },
      }),
    );

    const result = await validateCredential(CREDENTIAL);

    expect(call()[0]).toBe(
      'https://waypoint123.atlassian.net/rest/api/3/myself',
    );
    expect(result).toEqual({
      ok: true,
      value: {
        site: CREDENTIAL.site,
        accountId: CREDENTIAL.accountId,
        email: 'max@northwind.dev',
        displayName: 'Max Chen',
        avatarUrl: 'https://avatar.example/48',
      },
    });
  });

  // Atlassian hides emailAddress unless the account's profile visibility
  // allows it, so the address the user typed is the one to show back.
  it('falls back to the typed email when the account hides its address', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        accountId: CREDENTIAL.accountId,
        displayName: 'Max Chen',
      }),
    );

    const result = await validateCredential(CREDENTIAL);

    expect(result).toMatchObject({
      ok: true,
      value: { email: CREDENTIAL.email },
    });
  });

  it('reports a rejected token as invalid_credentials, distinctly from anything else', async () => {
    fetchMock.mockResolvedValue(emptyResponse(401));

    expect(await validateCredential(CREDENTIAL)).toMatchObject({
      ok: false,
      reason: 'invalid_credentials',
    });
  });

  // The connect form has to say something completely different for "Jira said
  // no" than for "we never reached Jira" — a typo'd token and an offline
  // laptop must not look identical.
  it('distinguishes an unreachable site from bad credentials', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ENOTFOUND' },
      }),
    );

    expect(await validateCredential(CREDENTIAL)).toMatchObject({
      ok: false,
      reason: 'site_not_found',
    });
  });

  it('reports a generic connection failure as network', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED' },
      }),
    );

    expect(await validateCredential(CREDENTIAL)).toMatchObject({
      ok: false,
      reason: 'network',
    });
  });

  // A hostname that answers on https with a login page is not a Jira site;
  // saying so beats a downstream "cannot read property of undefined".
  it('rejects a 200 that is not a Jira API response', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => '<!doctype html><title>Parked domain</title>',
    } as unknown as Response);

    expect(await validateCredential(CREDENTIAL)).toMatchObject({
      ok: false,
      reason: 'site_not_found',
    });
  });

  it('rejects a 200 whose body carries no accountId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hello: 'there' }));

    expect(await validateCredential(CREDENTIAL)).toMatchObject({
      ok: false,
      reason: 'site_not_found',
    });
  });
});

describe('listMyTickets', () => {
  it('refuses without a stored credential rather than calling out unauthenticated', async () => {
    readStoredJiraCredentialMock.mockReturnValue(null);

    expect(await listMyTickets()).toMatchObject({
      ok: false,
      reason: 'not_connected',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps the returned issues', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        issues: [
          {
            id: '10421',
            key: 'ENG-421',
            fields: {
              summary: 'Webhook receiver drops events',
              project: { key: 'ENG' },
              status: {
                name: 'In Progress',
                statusCategory: { key: 'indeterminate' },
              },
              assignee: {
                accountId: CREDENTIAL.accountId,
                displayName: 'Max Chen',
              },
            },
          },
        ],
        isLast: true,
      }),
    );

    const result = await listMyTickets();

    expect(result).toMatchObject({
      ok: true,
      value: [{ id: '10421', key: 'ENG-421', role: 'assignee' }],
    });
  });

  it('follows nextPageToken until the last page', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          issues: [{ id: '1', key: 'ENG-1', fields: {} }],
          nextPageToken: 'p2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issues: [{ id: '2', key: 'ENG-2', fields: {} }],
          isLast: true,
        }),
      );

    const result = await listMyTickets();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(call(1)[0]).searchParams.get('nextPageToken')).toBe('p2');
    expect(result).toMatchObject({
      ok: true,
      value: [{ id: '1' }, { id: '2' }],
    });
  });

  // A pathological account must not turn "load my work" into an unbounded
  // crawl of someone's whole Jira.
  it('stops after the page cap even if Jira keeps offering more', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        issues: [{ id: '1', key: 'ENG-1', fields: {} }],
        nextPageToken: 'more',
      }),
    );

    await listMyTickets();

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe('listTransitions', () => {
  // The bulk search's inline transitions are treated as an optimization, not
  // as the answer of record — this endpoint is unambiguous.
  it('reads the per-issue transitions endpoint with its field metadata', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        transitions: [
          {
            id: '21',
            to: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
            fields: {},
          },
        ],
      }),
    );

    const result = await listTransitions('10421');

    expect(call()[0]).toContain(
      '/rest/api/3/issue/10421/transitions?expand=transitions.fields',
    );
    expect(result).toMatchObject({
      ok: true,
      value: [{ id: '21', targetStateName: 'In Review' }],
    });
  });
});

describe('transitionTicket', () => {
  const TRANSITIONS = {
    transitions: [
      {
        id: '31',
        to: { name: 'Done', statusCategory: { key: 'done' } },
        fields: {
          resolution: {
            required: true,
            name: 'Resolution',
            schema: { type: 'resolution' },
            allowedValues: [{ id: '10001', value: "Won't Do" }],
          },
        },
      },
    ],
  };

  const UPDATED_ISSUE = {
    id: '10421',
    key: 'ENG-421',
    fields: {
      summary: 'Webhook receiver drops events',
      project: { key: 'ENG' },
      status: { name: 'Done', statusCategory: { key: 'done' } },
    },
  };

  it('re-reads the live field metadata, posts resolved ids, and returns the re-read issue', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(TRANSITIONS))
      .mockResolvedValueOnce(emptyResponse(204))
      .mockResolvedValueOnce(jsonResponse(UPDATED_ISSUE));

    const result = await transitionTicket('10421', '31', {
      resolution: "Won't Do",
    });

    const [postUrl, postInit] = call(1);
    expect(postInit.method).toBe('POST');
    expect(postUrl).toContain('/rest/api/3/issue/10421/transitions');
    expect(JSON.parse(postInit.body as string)).toEqual({
      transition: { id: '31' },
      // The label the popover sent, resolved against this site's own
      // allowedValues — see jiraMap's buildTransitionFieldsPayload.
      fields: { resolution: { id: '10001' } },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { stateName: 'Done', stateCategory: 'done' },
    });
  });

  it('omits the fields key entirely when a transition needs none', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          transitions: [{ id: '21', to: { name: 'In Review' }, fields: {} }],
        }),
      )
      .mockResolvedValueOnce(emptyResponse(204))
      .mockResolvedValueOnce(jsonResponse(UPDATED_ISSUE));

    await transitionTicket('10421', '21', {});

    expect(JSON.parse(call(1)[1].body as string)).toEqual({
      transition: { id: '21' },
    });
  });

  // A transition that stopped being legal while the popover was open should
  // say so, not produce a bare 400.
  it('reports a transition that is no longer offered, without attempting the write', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ transitions: [] }));

    const result = await transitionTicket('10421', '31', {});

    expect(result).toMatchObject({ ok: false, reason: 'jira_error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Jira's own wording ("Resolution is required") is far more actionable than
  // "the move failed", so it is surfaced verbatim.
  it("surfaces Jira's own error message when it rejects the write", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(TRANSITIONS))
      .mockResolvedValueOnce(
        jsonResponse(
          { errors: { resolution: 'Resolution is required.' } },
          400,
        ),
      );

    expect(await transitionTicket('10421', '31', {})).toMatchObject({
      ok: false,
      reason: 'jira_error',
      message: 'Resolution is required.',
    });
  });
});

describe('comments', () => {
  // v2, not v3: v2 takes and returns a plain string body, which is exactly
  // what this app's composer produces and its comment list renders.
  it('reads comments from the v2 endpoint', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        comments: [
          {
            id: '10500',
            author: { displayName: 'Sam Lee' },
            body: 'Replay log attached.',
            created: '2026-09-01T09:00:00.000+0000',
          },
        ],
      }),
    );

    const result = await listComments('10421');

    expect(call()[0]).toContain('/rest/api/2/issue/10421/comment');
    expect(result).toMatchObject({
      ok: true,
      value: [{ authorName: 'Sam Lee', body: 'Replay log attached.' }],
    });
  });

  it('posts a plain-string body to the v2 endpoint', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: '10502',
        author: { displayName: 'Max Chen' },
        body: 'Taking it.',
        created: '2026-09-01T10:00:00.000+0000',
      }),
    );

    const result = await postComment('10421', 'Taking it.');

    const [url, init] = call();
    expect(url).toContain('/rest/api/2/issue/10421/comment');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ body: 'Taking it.' });
    expect(result).toMatchObject({ ok: true, value: { id: '10502' } });
  });

  it('reports a permission failure as forbidden, not as bad credentials', async () => {
    fetchMock.mockResolvedValue(emptyResponse(403));

    expect(await postComment('10421', 'Taking it.')).toMatchObject({
      ok: false,
      reason: 'forbidden',
    });
  });
});
