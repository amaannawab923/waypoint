import type { JiraCredential } from './jiraAuth';

const readStoredJiraCredentialMock = jest.fn<JiraCredential | null, []>();
const markJiraCredentialInvalidMock = jest.fn();
const clearJiraCredentialInvalidMarkerMock = jest.fn();
jest.mock('./jiraAuth', () => ({
  readStoredJiraCredential: () => readStoredJiraCredentialMock(),
  markJiraCredentialInvalid: () => markJiraCredentialInvalidMock(),
  clearJiraCredentialInvalidMarker: () => clearJiraCredentialInvalidMarkerMock(),
}));

// eslint-disable-next-line import/order, import/first
import {
  deleteComment,
  downloadAttachment,
  getComment,
  getMyPermissions,
  getTicket,
  listComments,
  listMyTickets,
  listPriorityOptions,
  listTransitions,
  postComment,
  searchAssignableUsers,
  setTicketAssignee,
  setTicketPriority,
  transitionTicket,
  updateComment,
  uploadAttachment,
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

  // ROAD-41: settles the dispute over whether labels, duedate, subtasks and
  // issuelinks are requested. `*all` is Jira's own "every field, standard and
  // custom" value — not a curated subset — so all four (and `description`,
  // already read for the plain-text flatten) were already arriving in the
  // response on both the bulk search above and the single-issue read below.
  // Nothing about the request changed for ROAD-41; only jiraMap.ts's mapIssue
  // started reading what was already there.
  it('requests every field on a single-issue read too, the same way the search does', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: '10421',
        key: 'ENG-421',
        fields: {
          summary: 's',
          project: { key: 'ENG' },
          status: { name: 'To Do', statusCategory: { key: 'new' } },
        },
      }),
    );

    await getTicket('10421');

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

  // ROAD-16: this probes a CANDIDATE the connect form just typed in, not the
  // credential jira:status reports on — nothing is stored yet at this point,
  // and a mistyped token here is not "a previously good connection just
  // stopped working". Flagging the connection here would either mark an
  // unrelated credential from an earlier session, or write a marker with no
  // credential behind it at all.
  it('does not flag the stored connection over a rejected CANDIDATE credential', async () => {
    fetchMock.mockResolvedValue(emptyResponse(401));

    await validateCredential(CREDENTIAL);

    expect(markJiraCredentialInvalidMock).not.toHaveBeenCalled();
  });

  // The same opt-out, the other direction: a candidate probe SUCCEEDING says
  // nothing about whether the credential actually stored on disk (a
  // different email/token, from an earlier session) is still good — so it
  // must not clear that stored credential's marker either.
  it('does not clear the stored connection marker over a successful CANDIDATE credential', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ accountId: CREDENTIAL.accountId, emailAddress: CREDENTIAL.email }),
    );

    await validateCredential(CREDENTIAL);

    expect(clearJiraCredentialInvalidMarkerMock).not.toHaveBeenCalled();
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

  // ROAD-21: a typo'd *.atlassian.net subdomain never reaches a Jira site at
  // all — Atlassian's own edge answers a real 404 for it, which is the same
  // underlying fact ENOTFOUND reports for a domain that doesn't resolve.
  // Before this, `jiraFetch` still classified it `not_found` (correct for
  // every OTHER caller — see jiraTypes.ts) and the connect form showed
  // whatever `messageFromErrorBody` fell back to, e.g. "Jira returned 404."
  it('translates a 404 from a *.atlassian.net host to "site doesn\'t exist"', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ errorMessages: ['Site does not exist.'] }, 404),
    );

    expect(await validateCredential(CREDENTIAL)).toEqual({
      ok: false,
      reason: 'site_not_found',
      message:
        "That site doesn't exist — check the address (e.g. yourteam.atlassian.net).",
    });
  });

  // A host outside atlassian.net that 404s DID resolve and answered
  // something — just not a Jira Cloud API — so it gets the other
  // already-written message rather than "that site doesn't exist".
  it('translates a 404 from a non-atlassian.net host to "not like a Jira Cloud site"', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ errorMessages: ['Not Found'] }, 404),
    );

    expect(
      await validateCredential({ ...CREDENTIAL, site: 'jira.northwind.dev' }),
    ).toEqual({
      ok: false,
      reason: 'site_not_found',
      message:
        'That address answered, but not like a Jira Cloud site — check the site address.',
    });
  });

  // Atlassian's edge answers an unregistered subdomain with an HTML page,
  // not JSON — `messageFromErrorBody` never gets a body it can read, and the
  // classification here doesn't need one: it decides from the candidate
  // hostname alone, so nothing from that HTML page can leak into the
  // message shown next to the address field.
  it('classifies an HTML 404 body the same way, without leaking HTML into the message', async () => {
    fetchMock.mockResolvedValue({
      status: 404,
      ok: false,
      text: async () =>
        '<!doctype html><title>Oops, this site doesn’t exist</title>',
    } as unknown as Response);

    const result = await validateCredential(CREDENTIAL);

    expect(result).toEqual({
      ok: false,
      reason: 'site_not_found',
      message:
        "That site doesn't exist — check the address (e.g. yourteam.atlassian.net).",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toMatch(/<|doctype|html/i);
    }
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

  // The comment on this map has always said one unusual issue must not take
  // the whole list down. The filter alone only skipped an issue mapIssue
  // RETURNED null for; one that made it THROW still rejected the entire read,
  // so a single pathological description failed every row in the queue.
  it('skips an issue that cannot be mapped instead of failing the whole read', async () => {
    // adfToPlainText recurses without a depth bound, so deep enough nesting
    // is a real RangeError rather than a contrived throw.
    let description: Record<string, unknown> = {
      type: 'text',
      text: 'bottom',
    };
    // 2000 is a deliberate window, verified empirically: JSON.stringify and
    // JSON.parse both still handle this depth, so the fixture survives the
    // round trip through the mocked response, while adfToPlainText's
    // unbounded recursion does not. Any deeper and the test's own
    // stringify throws instead, testing nothing.
    for (let i = 0; i < 2000; i += 1) {
      description = { type: 'blockquote', content: [description] };
    }

    fetchMock.mockResolvedValue(
      jsonResponse({
        issues: [
          {
            id: '1',
            key: 'ENG-1',
            fields: {
              summary: 'poison',
              project: { key: 'ENG' },
              status: { name: 'To Do', statusCategory: { key: 'new' } },
              description,
            },
          },
          {
            id: '2',
            key: 'ENG-2',
            fields: {
              summary: 'ordinary',
              project: { key: 'ENG' },
              status: { name: 'To Do', statusCategory: { key: 'new' } },
            },
          },
        ],
        isLast: true,
      }),
    );

    const result = await listMyTickets();

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.tickets.map((t) => t.key)).toEqual([
      'ENG-2',
    ]);
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
      value: { tickets: [{ id: '10421', key: 'ENG-421', role: 'assignee' }] },
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
      // Jira said it was done, so this is the whole answer and the list may
      // be rendered as one.
      value: { tickets: [{ id: '1' }, { id: '2' }], truncated: false },
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

    const result = await listMyTickets();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    // The cap stopping the crawl is not the interesting part — it already
    // did that. Saying so is: this flag is the only thing standing between
    // the UI and rendering a prefix as if it were the queue. And it says
    // WHICH kind, because only this one licenses the UI's "first 500".
    expect(result).toMatchObject({
      ok: true,
      value: { truncated: 'page-cap' },
    });
  });

  // The boundary case the flag is easiest to get wrong on: the crawl used
  // every page it had, and Jira happened to finish on exactly the last one.
  // "We stopped at the cap" and "Jira ran out at the cap" look identical
  // from the page count alone, and only the first is truncation.
  it('is not truncated when the final allowed page is genuinely the last', async () => {
    const page = (nextPageToken?: string) =>
      jsonResponse({
        issues: [{ id: '1', key: 'ENG-1', fields: {} }],
        ...(nextPageToken ? { nextPageToken } : { isLast: true }),
      });
    fetchMock
      .mockResolvedValueOnce(page('p2'))
      .mockResolvedValueOnce(page('p3'))
      .mockResolvedValueOnce(page('p4'))
      .mockResolvedValueOnce(page('p5'))
      .mockResolvedValueOnce(page());

    const result = await listMyTickets();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({ ok: true, value: { truncated: false } });
  });

  // `truncated` and "can this crawl continue?" are different questions, and
  // one flag answered both. They diverge exactly here: Jira denies being on
  // the last page but hands back no cursor. The crawl genuinely cannot go on,
  // so the old flag went false and carried `truncated: false` with it — the
  // UI then rendered a prefix as the whole queue, which is the single claim
  // this flag exists to prevent.
  it('reports truncation when Jira says there is more but offers no cursor', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        issues: [{ id: '1', key: 'ENG-1', fields: {} }],
        isLast: false,
      }),
    );

    const result = await listMyTickets();

    // Stopped, because there is nothing to page with...
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // ...but said so, because the answer is incomplete — and said it is NOT
    // the cap, since this can happen on page one and the cap's copy names a
    // 500-issue limit that never applied here.
    expect(result).toMatchObject({
      ok: true,
      value: { truncated: 'no-cursor' },
    });
  });

  // A 200 with no body is not an empty queue. This was the one place a
  // non-answer became a positive claim about the user's Jira.
  it('refuses to read an empty response as an empty queue', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers(),
      text: async () => '',
    } as unknown as Response);

    expect(await listMyTickets()).toMatchObject({
      ok: false,
      reason: 'jira_error',
    });
  });

  // Deliberately narrow, and pinned as such: an object body that simply has
  // no issues IS an empty queue, and must stay one. Erroring here would turn
  // "you're all caught up" into an alarm.
  it('still reads a body with no issues as a genuinely empty queue', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ isLast: true }));

    expect(await listMyTickets()).toMatchObject({
      ok: true,
      value: { tickets: [], truncated: false },
    });
  });

  // ---- Regression pins on the other three branches ---------------------

  // An ordinary last page: no cursor, no isLast at all. Absence must not be
  // read as a denial, or every complete read would claim truncation.
  it('is not truncated on a last page that simply offers no cursor', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ issues: [{ id: '1', key: 'ENG-1', fields: {} }] }),
    );

    const result = await listMyTickets();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, value: { truncated: false } });
  });

  // Jira's own word about being finished beats a cursor it also handed over.
  it('stops and reports complete when isLast is true despite a cursor', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        issues: [{ id: '1', key: 'ENG-1', fields: {} }],
        nextPageToken: 'more',
        isLast: true,
      }),
    );

    const result = await listMyTickets();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, value: { truncated: false } });
  });

  // A cursor with no isLast is the token API's normal shape: keep going.
  it('keeps paging on a cursor with no isLast, then finishes cleanly', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          issues: [{ id: '1', key: 'ENG-1', fields: {} }],
          nextPageToken: 'p2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ issues: [{ id: '2', key: 'ENG-2', fields: {} }] }),
      );

    const result = await listMyTickets();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, value: { truncated: false } });
    expect(result.ok && result.value.tickets).toHaveLength(2);
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

describe('priority', () => {
  const EDITMETA = {
    fields: {
      summary: { required: true, name: 'Summary' },
      priority: {
        required: false,
        name: 'Priority',
        schema: { type: 'priority', system: 'priority' },
        allowedValues: [
          { id: '1', name: 'Highest' },
          { id: '3', name: 'Medium' },
          { id: '5', name: 'Lowest' },
        ],
      },
    },
  };

  const UPDATED_ISSUE = {
    id: '10421',
    key: 'ENG-421',
    fields: {
      summary: 'Webhook receiver drops events',
      project: { key: 'ENG' },
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      priority: { id: '3', name: 'Medium' },
    },
  };

  describe('listPriorityOptions', () => {
    // Per-issue, not the global /rest/api/3/priority list: a site can attach a
    // different priority scheme to each project, so the global list is a
    // superset containing values this issue would 400 on.
    it('reads the issue’s own editmeta, not the site-wide priority list', async () => {
      fetchMock.mockResolvedValue(jsonResponse(EDITMETA));

      const result = await listPriorityOptions('10421');

      const [url, init] = call();
      expect(url).toContain('/rest/api/3/issue/10421/editmeta');
      expect(url).not.toContain('/rest/api/3/priority');
      expect(init.method).toBe('GET');
      expect(result).toMatchObject({
        ok: true,
        value: [
          { id: '1', name: 'Highest' },
          { id: '3', name: 'Medium' },
          { id: '5', name: 'Lowest' },
        ],
      });
    });

    // Priority not being editable on an issue type is an ordinary answer, not
    // a fault — reporting it as a failure would put a red error in front of a
    // user whose Jira is behaving perfectly normally.
    it('reports an issue with no editable priority as an empty list, not a failure', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ fields: { summary: { required: true } } }),
      );

      expect(await listPriorityOptions('10421')).toEqual({
        ok: true,
        value: [],
      });
    });

    it('still reports a real read failure as one', async () => {
      fetchMock.mockResolvedValue(emptyResponse(403));

      expect(await listPriorityOptions('10421')).toMatchObject({
        ok: false,
        reason: 'forbidden',
      });
    });
  });

  describe('setTicketPriority', () => {
    it('PUTs the chosen id to the issue itself and returns the re-read issue', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(EDITMETA))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(jsonResponse(UPDATED_ISSUE));

      const result = await setTicketPriority('10421', '3');

      const [putUrl, putInit] = call(1);
      expect(putInit.method).toBe('PUT');
      expect(putUrl).toContain('/rest/api/3/issue/10421');
      expect(putUrl).not.toContain('/transitions');
      expect(JSON.parse(putInit.body as string)).toEqual({
        fields: { priority: { id: '3' } },
      });
      expect(result).toMatchObject({
        ok: true,
        value: { priorityId: '3', priorityName: 'Medium', priority: 'medium' },
      });
    });

    // The same defense transitionTicket has: the id in hand came from a menu
    // that may have been open a while, and live metadata is the only thing
    // that knows whether it is still legal.
    it('reads the live editmeta BEFORE the write, in that order', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(EDITMETA))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(jsonResponse(UPDATED_ISSUE));

      await setTicketPriority('10421', '3');

      expect(call(0)[0]).toContain('/editmeta');
      expect(call(0)[1].method).toBe('GET');
      expect(call(1)[1].method).toBe('PUT');
    });

    // Not merely "fails" — fails *without writing*. A priority this issue has
    // stopped accepting must never be attempted, so the user gets a sentence
    // that explains itself instead of a bare 400 from Jira.
    it('refuses a priority the issue no longer offers, without issuing the PUT', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(EDITMETA));

      const result = await setTicketPriority('10421', '99');

      expect(result).toMatchObject({
        ok: false,
        reason: 'jira_error',
        message: expect.stringContaining("isn't available on this issue"),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit).method === 'PUT',
        ),
      ).toBe(false);
    });

    it('refuses every priority, without writing, when the issue has none editable', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ fields: {} }));

      expect(await setTicketPriority('10421', '3')).toMatchObject({
        ok: false,
        reason: 'jira_error',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("surfaces Jira's own error message when it rejects the write", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(EDITMETA))
        .mockResolvedValueOnce(
          jsonResponse(
            { errors: { priority: 'Field priority cannot be set.' } },
            400,
          ),
        );

      expect(await setTicketPriority('10421', '3')).toMatchObject({
        ok: false,
        reason: 'jira_error',
        message: 'Field priority cannot be set.',
      });
    });

    it('refuses without a stored credential rather than calling out unauthenticated', async () => {
      readStoredJiraCredentialMock.mockReturnValue(null);

      expect(await setTicketPriority('10421', '3')).toMatchObject({
        ok: false,
        reason: 'not_connected',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('assignee', () => {
  const ASSIGNABLE = [
    {
      accountId: 'acct-sam',
      displayName: 'Sam Lee',
      emailAddress: 'sam@northwind.dev',
      avatarUrls: { '48x48': 'https://avatar.example/48' },
    },
    { accountId: 'acct-priya', displayName: 'Priya Raman' },
  ];

  const REASSIGNED_ISSUE = {
    id: '10421',
    key: 'ENG-421',
    fields: {
      summary: 'Webhook receiver drops events',
      project: { key: 'ENG' },
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      assignee: { accountId: 'acct-sam', displayName: 'Sam Lee' },
      reporter: { accountId: 'someone-else' },
      watches: { watchCount: 1, isWatching: false },
    },
  };

  describe('searchAssignableUsers', () => {
    // The one call in this whole client that takes an issue KEY. Jira's
    // assignable-user search is specified in terms of `issueKey`, while
    // everything else here travels by the numeric id — sending the id on this
    // channel is a silent zero-result search, not an error.
    it('searches by the issue KEY, not the numeric id this app otherwise holds', async () => {
      fetchMock.mockResolvedValue(jsonResponse(ASSIGNABLE));

      await searchAssignableUsers('ENG-421', 'sam');

      const [url, init] = call();
      const params = new URL(url).searchParams;
      expect(url).toContain('/rest/api/3/user/assignable/search');
      expect(init.method).toBe('GET');
      expect(params.get('issueKey')).toBe('ENG-421');
      expect(params.get('query')).toBe('sam');
      expect(params.get('issueId')).toBeNull();
    });

    // Per-issue, not site-wide: "Assignable User" is a project permission, so
    // who can take ENG-421 is not who can take OPS-3, and the generic user
    // search would happily offer someone Jira then refuses.
    it('never falls back to the site-wide user search', async () => {
      fetchMock.mockResolvedValue(jsonResponse(ASSIGNABLE));

      await searchAssignableUsers('ENG-421', '');

      expect(call()[0]).not.toContain('/rest/api/3/user/search');
      expect(call()[0]).not.toContain('/rest/api/3/users');
    });

    it('maps the results down to id, name and avatar', async () => {
      fetchMock.mockResolvedValue(jsonResponse(ASSIGNABLE));

      const result = await searchAssignableUsers('ENG-421', 'a');

      expect(result).toEqual({
        ok: true,
        value: [
          {
            accountId: 'acct-sam',
            displayName: 'Sam Lee',
            avatarUrl: 'https://avatar.example/48',
          },
          {
            accountId: 'acct-priya',
            displayName: 'Priya Raman',
            avatarUrl: null,
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('sam@northwind.dev');
    });

    // A blank query is what the panel opens with, and Jira answers it with
    // the first page of assignable users — it is a real call, not a no-op the
    // client should short-circuit into an empty list.
    it('treats a blank query as a real search for the first page', async () => {
      fetchMock.mockResolvedValue(jsonResponse(ASSIGNABLE));

      const result = await searchAssignableUsers('ENG-421', '');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(new URL(call()[0]).searchParams.get('query')).toBe('');
      expect(result).toMatchObject({
        ok: true,
        value: expect.arrayContaining([
          expect.objectContaining({ displayName: 'Sam Lee' }),
        ]),
      });
    });

    // A site can restrict "Browse users and groups". That must not arrive as
    // an empty list: "nobody matches" and "you may not ask who does" are
    // different answers, and only one of them is about the user's colleagues.
    it('reports a restricted user search as forbidden, not as zero results', async () => {
      fetchMock.mockResolvedValue(emptyResponse(403));

      expect(await searchAssignableUsers('ENG-421', 'sam')).toMatchObject({
        ok: false,
        reason: 'forbidden',
      });
    });

    it('refuses without a stored credential rather than calling out unauthenticated', async () => {
      readStoredJiraCredentialMock.mockReturnValue(null);

      expect(await searchAssignableUsers('ENG-421', 'sam')).toMatchObject({
        ok: false,
        reason: 'not_connected',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('setTicketAssignee', () => {
    // The dedicated assignee endpoint, not the generic issue edit PUT that
    // setTicketPriority uses: Jira grants "Assign issues" separately from
    // "Edit issues", and the generic path additionally needs the assignee
    // field to be on that issue type's edit screen.
    it('PUTs to the dedicated assignee endpoint and returns the re-read issue', async () => {
      fetchMock
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(jsonResponse(REASSIGNED_ISSUE));

      const result = await setTicketAssignee('10421', 'acct-sam');

      const [putUrl, putInit] = call(0);
      expect(putInit.method).toBe('PUT');
      expect(putUrl).toContain('/rest/api/3/issue/10421/assignee');
      expect(JSON.parse(putInit.body as string)).toEqual({
        accountId: 'acct-sam',
      });
      expect(result).toMatchObject({
        ok: true,
        value: { assigneeName: 'Sam Lee', assigneeAccountId: 'acct-sam' },
      });
    });

    // The write is addressed by the numeric id, unlike the search above —
    // both are Jira's own contracts, and the difference between them is the
    // single sharpest thing to get wrong in this feature.
    it('addresses the write by the numeric id, not the key', async () => {
      fetchMock
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(jsonResponse(REASSIGNED_ISSUE));

      await setTicketAssignee('10421', 'acct-sam');

      expect(call(0)[0]).toContain('/issue/10421/assignee');
      expect(call(0)[0]).not.toContain('ENG-421');
    });

    // `{ accountId: null }` is Jira's own documented payload for unassign. A
    // JSON body with an explicit null is a different thing from one with the
    // key omitted, and from one carrying an empty string — this is the end of
    // the chain that starts at the picker's Unassign row.
    it('sends a literal null to unassign, never "" and never an omitted key', async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(204)).mockResolvedValueOnce(
        jsonResponse({
          ...REASSIGNED_ISSUE,
          fields: { ...REASSIGNED_ISSUE.fields, assignee: null },
        }),
      );

      const result = await setTicketAssignee('10421', null);

      const body = call(0)[1].body as string;
      expect(body).toBe('{"accountId":null}');
      expect(JSON.parse(body)).toEqual({ accountId: null });
      expect(Object.keys(JSON.parse(body))).toContain('accountId');
      expect(result).toMatchObject({
        ok: true,
        value: { assigneeName: 'Unassigned', assigneeAccountId: null },
      });
    });

    // No editmeta pre-flight, unlike setTicketPriority — an account id needs
    // no resolving against live metadata, so a second round trip would buy
    // nothing but latency. Exactly two requests: the write and the re-read.
    it('writes without a metadata pre-flight, then re-reads once', async () => {
      fetchMock
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(jsonResponse(REASSIGNED_ISSUE));

      await setTicketAssignee('10421', 'acct-sam');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(call(0)[0]).not.toContain('/editmeta');
      expect(call(1)[1].method).toBe('GET');
    });

    // Jira's own wording ("User cannot be assigned issues.") is the whole
    // reason there is no pre-flight check restating it less well.
    it("surfaces Jira's own error message when it rejects the write", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { errorMessages: ['User cannot be assigned issues.'] },
          400,
        ),
      );

      expect(await setTicketAssignee('10421', 'acct-sam')).toMatchObject({
        ok: false,
        reason: 'jira_error',
        message: 'User cannot be assigned issues.',
      });
      // Failed write, so nothing was re-read and nothing is reported as
      // having changed.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports a permission failure as forbidden, not as bad credentials', async () => {
      fetchMock.mockResolvedValueOnce(emptyResponse(403));

      expect(await setTicketAssignee('10421', 'acct-sam')).toMatchObject({
        ok: false,
        reason: 'forbidden',
      });
    });

    it('refuses without a stored credential rather than calling out unauthenticated', async () => {
      readStoredJiraCredentialMock.mockReturnValue(null);

      expect(await setTicketAssignee('10421', null)).toMatchObject({
        ok: false,
        reason: 'not_connected',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('downloadAttachment', () => {
  /** A binary response. `arrayBuffer` rather than `text`, and a real
   * `content-length`, because the size guard reads that header before it
   * allocates anything. */
  function binaryResponse(
    bytes: Buffer,
    headers: Record<string, string> = {
      'content-length': String(bytes.byteLength),
    },
  ): Response {
    return {
      status: 200,
      ok: true,
      headers: new Headers(headers),
      arrayBuffer: jest.fn(async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      ),
      text: jest.fn(async () => {
        throw new Error('text() must not be called on the binary path');
      }),
    } as unknown as Response;
  }

  const BYTES = Buffer.from('replay log, line one\n');

  /**
   * The single most important assertion about attachments.
   *
   * Jira hands back a `content` URL on every attachment object, and following
   * it with the Basic-auth header attached would send a credential for the
   * user's entire Atlassian account to whatever host that field named. So the
   * URL is *constructed*: the site comes from the stored credential, the id
   * from the caller, and nothing in between comes out of a response body.
   */
  it('builds the URL from the stored site and the id, never from a response field', async () => {
    fetchMock.mockResolvedValue(binaryResponse(BYTES));

    await downloadAttachment('10050');

    const [url, init] = call();
    expect(url).toBe(
      'https://waypoint123.atlassian.net/rest/api/3/attachment/content/10050',
    );
    expect(init.method).toBe('GET');
    expect(headerValue(0, 'Authorization')).toContain('Basic ');
  });

  it('returns the bytes Jira sent', async () => {
    fetchMock.mockResolvedValue(binaryResponse(BYTES));

    const result = await downloadAttachment('10050');

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('expected a successful download');
    expect(result.value.bytes.equals(BYTES)).toBe(true);
  });

  // The response is an attachment, not JSON. Reading it with .text() would
  // corrupt anything that is not valid UTF-8 — which is most files worth
  // attaching — so the binary path must never take the JSON body route. The
  // mock's text() throws, which is what makes this assertion real rather than
  // a spy count.
  it('reads the body with arrayBuffer(), never text()', async () => {
    const response = binaryResponse(BYTES);
    fetchMock.mockResolvedValue(response);

    expect(await downloadAttachment('10050')).toMatchObject({ ok: true });
    expect(response.arrayBuffer).toHaveBeenCalledTimes(1);
    expect(response.text).not.toHaveBeenCalled();
  });

  // The regression this covers hung the app rather than failing it. `fetch`
  // resolves when the response HEADERS arrive, and the abort timer used to be
  // cleared right there — so a server that sent headers and then stalled left
  // `arrayBuffer()` running with no timeout and a disarmed controller. It
  // never settled and never rejected: the IPC invoke never answered, the save
  // dialog never opened, and the spinner never cleared. The timer now spans
  // the body read, so a stall aborts, and an abort has to surface as the
  // network failure it is rather than as a hang or a misleading "not a Jira
  // site" parse error.
  it('reports a body that stalls after the headers as a network failure', async () => {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    const response = binaryResponse(BYTES);
    (response.arrayBuffer as jest.Mock).mockRejectedValue(abort);
    fetchMock.mockResolvedValue(response);

    expect(await downloadAttachment('10050')).toMatchObject({
      ok: false,
      reason: 'network',
    });
  });

  // Refused from the declared length, before anything is allocated — the
  // whole point is not to buffer an arbitrarily large file into main's heap.
  it('refuses an oversized attachment on content-length, without reading the body', async () => {
    const response = binaryResponse(BYTES, {
      'content-length': String(500 * 1024 * 1024),
    });
    fetchMock.mockResolvedValue(response);

    expect(await downloadAttachment('10050')).toMatchObject({
      ok: false,
      reason: 'jira_error',
      message: expect.stringContaining('100MB'),
    });
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });

  // A chunked response declares no length. That is ordinary, not an error, so
  // the transfer proceeds — the post-read backstop is the only check left.
  it('still downloads when the response declares no length', async () => {
    fetchMock.mockResolvedValue(binaryResponse(BYTES, {}));

    expect(await downloadAttachment('10050')).toMatchObject({ ok: true });
  });

  it('reports a deleted attachment as not_found, in Jira’s own words', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ errorMessages: ['Attachment does not exist.'] }, 404),
    );

    expect(await downloadAttachment('10050')).toMatchObject({
      ok: false,
      reason: 'not_found',
      message: 'Attachment does not exist.',
    });
  });

  it('reports a permission failure as forbidden, not as bad credentials', async () => {
    fetchMock.mockResolvedValue(emptyResponse(403));

    expect(await downloadAttachment('10050')).toMatchObject({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('refuses without a stored credential rather than calling out unauthenticated', async () => {
    readStoredJiraCredentialMock.mockReturnValue(null);

    expect(await downloadAttachment('10050')).toMatchObject({
      ok: false,
      reason: 'not_connected',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('uploadAttachment', () => {
  const BYTES = Buffer.from('replay log, line one\n');

  const UPDATED_ISSUE = {
    id: '10421',
    key: 'ENG-421',
    fields: {
      summary: 'Webhook receiver drops events',
      project: { key: 'ENG' },
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      attachment: [
        {
          id: '10050',
          filename: 'replay-log.txt',
          size: 21,
          mimeType: 'text/plain',
          author: { displayName: 'Max Chen' },
        },
      ],
    },
  };

  /** What Jira answers an upload with: an array of the attachments it just
   * stored, not the issue — which is why this client re-reads the issue. */
  const UPLOAD_RESPONSE = [{ id: '10050', filename: 'replay-log.txt' }];

  function upload() {
    return uploadAttachment('10421', 'replay-log.txt', BYTES, 'text/plain');
  }

  it('POSTs to the issue’s attachments endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(UPLOAD_RESPONSE))
      .mockResolvedValueOnce(jsonResponse(UPDATED_ISSUE));

    await upload();

    const [url, init] = call(0);
    expect(url).toBe(
      'https://waypoint123.atlassian.net/rest/api/3/issue/10421/attachments',
    );
    expect(init.method).toBe('POST');
  });

  // Atlassian's XSRF guard. Jira's own documentation is blunt about the
  // consequence of omitting it: the request is blocked.
  it('carries X-Atlassian-Token: no-check', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(UPLOAD_RESPONSE))
      .mockResolvedValueOnce(jsonResponse(UPDATED_ISSUE));

    await upload();

    expect(headerValue(0, 'X-Atlassian-Token')).toBe('no-check');
  });

  /**
   * The single easiest way to get this endpoint wrong.
   *
   * `fetch` derives `Content-Type` from the `FormData` instance INCLUDING the
   * boundary parameter that tells the far side where each part begins. Setting
   * `Content-Type: multipart/form-data` by hand drops that boundary and
   * produces a body Jira cannot parse. So the assertion is about absence: no
   * Content-Type may be set on this path, at all.
   */
  it('sets no Content-Type by hand, leaving fetch to derive the boundary', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(UPLOAD_RESPONSE))
      .mockResolvedValueOnce(jsonResponse(UPDATED_ISSUE));

    await upload();

    const headers = call(0)[1].headers as Record<string, string>;
    expect(Object.keys(headers)).not.toContain('Content-Type');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(
      'content-type',
    );
    // The two that must be there, so this isn't passing because the headers
    // went missing entirely.
    expect(Object.keys(headers)).toEqual(
      expect.arrayContaining(['Authorization', 'X-Atlassian-Token']),
    );
  });

  it('sends the file as a FormData part named "file"', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(UPLOAD_RESPONSE))
      .mockResolvedValueOnce(jsonResponse(UPDATED_ISSUE));

    await upload();

    const { body } = call(0)[1];
    expect(body).toBeInstanceOf(FormData);
    // `file` is Jira's own parameter name on this endpoint, not a convention.
    const part = (body as FormData).get('file');
    expect(part).not.toBeNull();
    expect((part as File).name).toBe('replay-log.txt');
  });

  // Jira answers with the attachments it stored, not the issue — so the state
  // the caller gets has to come from a re-read, the same pattern every other
  // write here follows.
  it('re-reads the issue afterwards and returns that', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(UPLOAD_RESPONSE))
      .mockResolvedValueOnce(jsonResponse(UPDATED_ISSUE));

    const result = await upload();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1)[0]).toContain('/rest/api/3/issue/10421');
    expect(call(1)[1].method).toBe('GET');
    expect(result).toMatchObject({
      ok: true,
      value: {
        attachments: [
          expect.objectContaining({ id: '10050', fileName: 'replay-log.txt' }),
        ],
      },
    });
  });

  it("surfaces Jira's own error message when it rejects the upload", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { errorMessages: ['The file exceeds its maximum permitted size.'] },
        413,
      ),
    );

    expect(await upload()).toMatchObject({
      ok: false,
      reason: 'jira_error',
      message: 'The file exceeds its maximum permitted size.',
    });
    // Failed write, so nothing was re-read and nothing is reported as changed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a permission failure as forbidden, not as bad credentials', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(403));

    expect(await upload()).toMatchObject({ ok: false, reason: 'forbidden' });
  });

  it('refuses without a stored credential rather than calling out unauthenticated', async () => {
    readStoredJiraCredentialMock.mockReturnValue(null);

    expect(await upload()).toMatchObject({
      ok: false,
      reason: 'not_connected',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('comments', () => {
  // v3 for the read, deliberately: v2 pre-flattens an ADF-authored comment
  // into legacy wiki markup, which is what turned a real Jira @mention into a
  // raw `[~accountid:...]` on screen. v3 hands back the ADF tree, where the
  // mention node carries its own display text and the account id never
  // surfaces.
  it('reads comments from the v3 endpoint, not v2', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        comments: [
          {
            id: '10500',
            author: { displayName: 'Sam Lee' },
            body: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'mention',
                      attrs: {
                        id: '712020:6d51d3e3-1111',
                        text: '@Amaan Nawab',
                      },
                    },
                    { type: 'text', text: ' replay log attached.' },
                  ],
                },
              ],
            },
            created: '2026-09-01T09:00:00.000+0000',
          },
        ],
      }),
    );

    const result = await listComments('10421');

    expect(call()[0]).toContain('/rest/api/3/issue/10421/comment');
    expect(call()[0]).not.toContain('/rest/api/2/');
    expect(result).toMatchObject({
      ok: true,
      value: {
        comments: [
          { authorName: 'Sam Lee', body: '@Amaan Nawab replay log attached.' },
        ],
      },
    });
  });

  // The cap is 100. Ascending order means those 100 are the oldest hundred on
  // a busy ticket — the newest activity, which is the point of the list,
  // falls off the end.
  it('fetches newest-first but hands the caller oldest-first', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        comments: [
          {
            id: '3',
            author: { displayName: 'Sam Lee' },
            body: 'newest',
            created: '2026-09-03T09:00:00.000+0000',
          },
          {
            id: '2',
            author: { displayName: 'Sam Lee' },
            body: 'middle',
            created: '2026-09-02T09:00:00.000+0000',
          },
          {
            id: '1',
            author: { displayName: 'Sam Lee' },
            body: 'oldest',
            created: '2026-09-01T09:00:00.000+0000',
          },
        ],
      }),
    );

    const result = await listComments('10421');

    expect(call()[0]).toContain('orderBy=-created');
    // The drawer renders in array order and appends a new comment with
    // `[...cs, comment]`, so ascending is the contract.
    expect(result).toMatchObject({
      ok: true,
      value: { comments: [{ id: '1' }, { id: '2' }, { id: '3' }] },
    });
  });

  // The cap is only safe to keep because the caller is told it applied.
  // Without `total`, a hundred-comment page and a complete thread are the
  // same value, and the drawer renders both under a heading that just says
  // "Comments".
  it("reports Jira's own total, so a capped page can say so", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        total: 312,
        comments: [
          {
            id: '312',
            author: { displayName: 'Sam Lee' },
            body: 'newest',
            created: '2026-09-03T09:00:00.000+0000',
          },
        ],
      }),
    );

    const result = await listComments('10421');

    expect(call()[0]).toContain('maxResults=100');
    expect(result).toMatchObject({ ok: true, value: { total: 312 } });
  });

  // A missing `total` is an unknown, and 0 is not a safe way to say unknown:
  // it renders as "showing 3 of 0" and makes every short thread look
  // truncated in the wrong direction.
  it('falls back to the page length when Jira reports no total', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        comments: [
          {
            id: '1',
            author: { displayName: 'Sam Lee' },
            body: 'only',
            created: '2026-09-01T09:00:00.000+0000',
          },
        ],
      }),
    );

    const result = await listComments('10421');

    expect(result).toMatchObject({ ok: true, value: { total: 1 } });
  });

  const PLAIN_ADF_BODY = {
    type: 'doc' as const,
    version: 1 as const,
    content: [
      {
        type: 'paragraph' as const,
        content: [{ type: 'text' as const, text: 'Taking it.' }],
      },
    ],
  };

  it('posts an ADF body to the v3 endpoint', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: '10502',
        author: { displayName: 'Max Chen' },
        body: PLAIN_ADF_BODY,
        created: '2026-09-01T10:00:00.000+0000',
      }),
    );

    const result = await postComment('10421', PLAIN_ADF_BODY);

    // The write moved to v3 alongside the read: v2's comment-create endpoint
    // takes a plain string and has no way to carry a `mention` node, which is
    // exactly what the composer needs once its @-mention picker is real
    // rather than cosmetic.
    const [url, init] = call();
    expect(url).toContain('/rest/api/3/issue/10421/comment');
    expect(url).not.toContain('/rest/api/2/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ body: PLAIN_ADF_BODY });
    expect(result).toMatchObject({ ok: true, value: { id: '10502' } });
  });

  it('posts a body carrying a real mention node', async () => {
    const mentionBody = {
      type: 'doc' as const,
      version: 1 as const,
      content: [
        {
          type: 'paragraph' as const,
          content: [
            {
              type: 'mention' as const,
              attrs: { id: '712020:6d51d3e3-1111', text: '@Sam Lee' },
            },
            { type: 'text' as const, text: ' can you take this?' },
          ],
        },
      ],
    };
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: '10503',
        author: { displayName: 'Max Chen' },
        body: mentionBody,
        created: '2026-09-01T10:05:00.000+0000',
      }),
    );

    const result = await postComment('10421', mentionBody);

    const [, init] = call();
    expect(JSON.parse(init.body as string)).toEqual({ body: mentionBody });
    expect(result).toMatchObject({ ok: true, value: { id: '10503' } });
  });

  it('reports a permission failure as forbidden, not as bad credentials', async () => {
    fetchMock.mockResolvedValue(emptyResponse(403));

    expect(await postComment('10421', PLAIN_ADF_BODY)).toMatchObject({
      ok: false,
      reason: 'forbidden',
    });
  });

  // The one thing the founder's live check could NOT confirm: whether this
  // public write endpoint accepts `parentId` at all. This only pins what
  // Waypoint sends, never what Jira does with it — see postComment's own
  // comment and jiraApi.ts's toComment for why the RESPONSE, not this
  // request, is what ever gets trusted about whether a reply actually nested.
  it('includes parentId in the request body when replying', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: '10510',
        author: { displayName: 'Max Chen' },
        body: PLAIN_ADF_BODY,
        created: '2026-09-01T10:10:00.000+0000',
      }),
    );

    await postComment('10421', PLAIN_ADF_BODY, '10158');

    const [, init] = call();
    expect(JSON.parse(init.body as string)).toEqual({
      body: PLAIN_ADF_BODY,
      parentId: '10158',
    });
  });

  // Not `parentId: null` or `parentId: undefined` on the wire — the field is
  // omitted outright for an ordinary comment, the same "say nothing rather
  // than send an empty claim" choice this codebase makes elsewhere for an
  // undocumented or partially-known field.
  it('omits parentId entirely for an ordinary, non-reply comment', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: '10511',
        author: { displayName: 'Max Chen' },
        body: PLAIN_ADF_BODY,
        created: '2026-09-01T10:11:00.000+0000',
      }),
    );

    await postComment('10421', PLAIN_ADF_BODY, null);

    const [, init] = call();
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ body: PLAIN_ADF_BODY });
    expect(Object.prototype.hasOwnProperty.call(sent, 'parentId')).toBe(false);
  });

  // The whole safety property this feature is built on: a reply's own
  // returned comment reflects what JIRA reported, not what was requested. If
  // Jira silently ignored the field (undocumented, unverified — see
  // postComment's own comment), the response carries no parentId and the
  // mapped comment must say so honestly.
  it("maps the response's own parentId, not the one that was requested", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: '10512',
        author: { displayName: 'Max Chen' },
        body: PLAIN_ADF_BODY,
        created: '2026-09-01T10:12:00.000+0000',
        // No `parentId` here — Jira's honest answer when it declined (or
        // never recognized) the field this request asked for.
      }),
    );

    const result = await postComment('10421', PLAIN_ADF_BODY, '10158');

    expect(result).toMatchObject({ ok: true, value: { parentId: null } });
  });
});

describe('deleteComment', () => {
  it('DELETEs the exact issue/comment path', async () => {
    fetchMock.mockResolvedValue(emptyResponse(204));

    await deleteComment('10421', '10500');

    const [url, init] = call();
    expect(init.method).toBe('DELETE');
    expect(url).toContain('/rest/api/3/issue/10421/comment/10500');
  });

  // Jira's documented answer on success: 204, no body. `readJsonBody`'s
  // existing 204 branch resolves this to `undefined` without attempting a
  // body read, which is what makes `JiraResult<void>` true rather than
  // something this function had to special-case.
  it('reports success on a 204 with no body', async () => {
    fetchMock.mockResolvedValue(emptyResponse(204));

    expect(await deleteComment('10421', '10500')).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('reports a permission failure as forbidden, not as bad credentials', async () => {
    fetchMock.mockResolvedValue(emptyResponse(403));

    expect(await deleteComment('10421', '10500')).toMatchObject({
      ok: false,
      reason: 'forbidden',
    });
  });

  // Someone else's tab already deleted the same comment, it never existed, or
  // this account may no longer browse it. Jira reports all three as the same
  // 404 carrying its own error body, same as every other write here —
  // surfaced through the shared classification rather than a bespoke branch.
  it('reports an already-deleted comment as not_found, in Jira’s own words', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ errorMessages: ['The comment could not be found.'] }, 404),
    );

    expect(await deleteComment('10421', '10500')).toMatchObject({
      ok: false,
      reason: 'not_found',
      message: 'The comment could not be found.',
    });
  });

  it('refuses without a stored credential rather than calling out unauthenticated', async () => {
    readStoredJiraCredentialMock.mockReturnValue(null);

    const result = await deleteComment('10421', '10500');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, reason: 'not_connected' });
  });
});

describe('getComment', () => {
  it('GETs the exact issue/comment path', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: '10500',
        author: { displayName: 'Sam Lee' },
        body: 'Original text.',
        created: '2026-09-01T09:00:00.000+0000',
        updated: '2026-09-03T08:15:00.000+0000',
        updateAuthor: { displayName: 'Priya Raman' },
      }),
    );

    await getComment('10421', '10500');

    const [url, init] = call();
    expect(init.method).toBe('GET');
    expect(url).toContain('/rest/api/3/issue/10421/comment/10500');
  });

  // The whole reason this channel exists: `listComments` is capped and
  // newest-first, so it cannot reliably answer "what is this ONE comment's
  // updated/updateAuthor right now" for an old comment on a busy thread. This
  // pins that the mapped result carries the freshness fields, not just id
  // and body.
  it('maps the freshness fields off the single comment Jira returns', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: '10500',
        author: { displayName: 'Sam Lee' },
        body: 'Original text.',
        created: '2026-09-01T09:00:00.000+0000',
        updated: '2026-09-03T08:15:00.000+0000',
        updateAuthor: { displayName: 'Priya Raman' },
      }),
    );

    expect(await getComment('10421', '10500')).toMatchObject({
      ok: true,
      value: {
        id: '10500',
        updatedAt: '2026-09-03T08:15:00.000+0000',
        updateAuthorName: 'Priya Raman',
      },
    });
  });

  it('reports a permission failure as forbidden, not as bad credentials', async () => {
    fetchMock.mockResolvedValue(emptyResponse(403));

    expect(await getComment('10421', '10500')).toMatchObject({
      ok: false,
      reason: 'forbidden',
    });
  });

  // The comment was deleted (by someone else, or in another tab) between the
  // thread being read on mount and the freshness check running — or this
  // account lost permission to browse it, which Jira answers identically.
  // `not_found` rather than `jira_error` is the whole point of this path:
  // it is the signal the renderer's freshness guards branch on, and the
  // only evidence they are allowed to treat as "this is really gone" (see
  // jiraTypes.ts's own comment on the reason).
  it('reports a comment Jira will not show as not_found, in Jira’s own words', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ errorMessages: ['The comment could not be found.'] }, 404),
    );

    expect(await getComment('10421', '10500')).toMatchObject({
      ok: false,
      reason: 'not_found',
      message: 'The comment could not be found.',
    });
  });

  it('refuses without a stored credential rather than calling out unauthenticated', async () => {
    readStoredJiraCredentialMock.mockReturnValue(null);

    const result = await getComment('10421', '10500');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, reason: 'not_connected' });
  });
});

describe('updateComment', () => {
  const EDITED_ADF_BODY = {
    type: 'doc' as const,
    version: 1 as const,
    content: [
      {
        type: 'paragraph' as const,
        content: [{ type: 'text' as const, text: 'Edited text.' }],
      },
    ],
  };

  it('PUTs the exact issue/comment path with the new body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: '10500',
        author: { displayName: 'Sam Lee' },
        body: EDITED_ADF_BODY,
        created: '2026-09-01T09:00:00.000+0000',
      }),
    );

    await updateComment('10421', '10500', EDITED_ADF_BODY);

    const [url, init] = call();
    expect(init.method).toBe('PUT');
    expect(url).toContain('/rest/api/3/issue/10421/comment/10500');
    expect(JSON.parse(init.body as string)).toEqual({ body: EDITED_ADF_BODY });
  });

  // The whole safety property an edit is built on, same as postComment's own
  // reply-nesting test just above: the returned comment reflects what JIRA
  // reported for THIS comment, never fields assembled from the request. A
  // parentId here comes only from the response, so an edited reply keeps
  // whatever thread position Jira still reports for it.
  it("maps the response's own comment, not one assembled from the request", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: '10500',
        author: { displayName: 'Sam Lee' },
        body: EDITED_ADF_BODY,
        created: '2026-09-01T09:00:00.000+0000',
        parentId: 10158,
      }),
    );

    const result = await updateComment('10421', '10500', EDITED_ADF_BODY);

    expect(result).toMatchObject({
      ok: true,
      value: { id: '10500', body: 'Edited text.', parentId: '10158' },
    });
  });

  it('reports a permission failure as forbidden, not as bad credentials', async () => {
    fetchMock.mockResolvedValue(emptyResponse(403));

    expect(
      await updateComment('10421', '10500', EDITED_ADF_BODY),
    ).toMatchObject({ ok: false, reason: 'forbidden' });
  });

  it('reports a not-found comment as not_found, in Jira’s own words', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ errorMessages: ['The comment could not be found.'] }, 404),
    );

    expect(
      await updateComment('10421', '10500', EDITED_ADF_BODY),
    ).toMatchObject({
      ok: false,
      reason: 'not_found',
      message: 'The comment could not be found.',
    });
  });

  it('refuses without a stored credential rather than calling out unauthenticated', async () => {
    readStoredJiraCredentialMock.mockReturnValue(null);

    const result = await updateComment('10421', '10500', EDITED_ADF_BODY);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, reason: 'not_connected' });
  });
});

describe('getMyPermissions', () => {
  function permissionsResponse(
    have: Partial<
      Record<
        | 'DELETE_ALL_COMMENTS'
        | 'DELETE_OWN_COMMENTS'
        | 'EDIT_ALL_COMMENTS'
        | 'EDIT_OWN_COMMENTS',
        boolean
      >
    >,
  ) {
    const keys = [
      'DELETE_ALL_COMMENTS',
      'DELETE_OWN_COMMENTS',
      'EDIT_ALL_COMMENTS',
      'EDIT_OWN_COMMENTS',
    ] as const;
    return {
      permissions: Object.fromEntries(
        keys.map((key) => [key, { havePermission: have[key] === true }]),
      ),
    };
  }

  it('asks mypermissions for exactly the four comment permissions, scoped to the issue', async () => {
    fetchMock.mockResolvedValue(jsonResponse(permissionsResponse({})));

    await getMyPermissions('ENG-421');

    const params = new URL(call()[0]).searchParams;
    expect(call()[0]).toContain('/rest/api/3/mypermissions');
    expect(params.get('issueKey')).toBe('ENG-421');
    expect(params.get('permissions')).toBe(
      'DELETE_ALL_COMMENTS,DELETE_OWN_COMMENTS,EDIT_ALL_COMMENTS,EDIT_OWN_COMMENTS',
    );
  });

  // The common real-site case: a non-admin may remove their own remarks but
  // not moderate everyone else's.
  it('parses a site where the user may delete/edit only their own comments', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        permissionsResponse({
          DELETE_OWN_COMMENTS: true,
          EDIT_OWN_COMMENTS: true,
        }),
      ),
    );

    expect(await getMyPermissions('ENG-421')).toEqual({
      ok: true,
      value: {
        deleteAll: false,
        deleteOwn: true,
        editAll: false,
        editOwn: true,
      },
    });
  });

  it('parses a project admin who may delete/edit anyone’s comments', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        permissionsResponse({
          DELETE_ALL_COMMENTS: true,
          DELETE_OWN_COMMENTS: true,
          EDIT_ALL_COMMENTS: true,
          EDIT_OWN_COMMENTS: true,
        }),
      ),
    );

    expect(await getMyPermissions('ENG-421')).toEqual({
      ok: true,
      value: { deleteAll: true, deleteOwn: true, editAll: true, editOwn: true },
    });
  });

  // A key Jira's answer omits entirely is not evidence the user holds it —
  // read closed, not open, the same direction every other unknown in this
  // client degrades toward.
  it('reads a permission Jira omitted from its answer as false, not true', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ permissions: {} }));

    expect(await getMyPermissions('ENG-421')).toEqual({
      ok: true,
      value: {
        deleteAll: false,
        deleteOwn: false,
        editAll: false,
        editOwn: false,
      },
    });
  });

  it('refuses without a stored credential rather than calling out unauthenticated', async () => {
    readStoredJiraCredentialMock.mockReturnValue(null);

    const result = await getMyPermissions('ENG-421');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, reason: 'not_connected' });
  });
});

// ROAD-16: `jira:status` used to be a purely local file read that never
// noticed a token revoked or expired on Atlassian's side, so it reported
// `connected: true` forever. Every REAL, authenticated call this client
// makes — the stored credential `requireCredential` reads, not a candidate
// being probed — must flag that on a 401, so the next `jira:status` read
// tells the truth. `listMyTickets` stands in for the whole family here
// rather than repeating this once per exported function: they all funnel
// through the same `performRequest`, which is what actually decides this,
// and that single choke point is exactly what `request building` above
// already leans on for the same reason.
describe('flagging the connection dead on a real 401 (ROAD-16)', () => {
  it('flags the stored credential when an authenticated call is rejected', async () => {
    fetchMock.mockResolvedValue(emptyResponse(401));

    await listMyTickets();

    expect(markJiraCredentialInvalidMock).toHaveBeenCalledTimes(1);
  });

  it('does not flag anything on a successful call', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ issues: [] }));

    await listMyTickets();

    expect(markJiraCredentialInvalidMock).not.toHaveBeenCalled();
  });

  // 403/429 are a real, live credential Jira is choosing not to honor for
  // this call — a permission or a rate limit, not "this token is dead". Only
  // 401 is Jira's own word that authentication itself failed.
  it('does not flag the connection on 403 or 429, only on 401', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(403));
    await listMyTickets();
    fetchMock.mockResolvedValueOnce(emptyResponse(429));
    await listMyTickets();

    expect(markJiraCredentialInvalidMock).not.toHaveBeenCalled();
  });

  // A single transient or spurious 401 (an Atlassian auth-service blip, a
  // briefly-locked account) must not pin jira:status to "not connected"
  // forever once the same credential goes on to work again — the marker has
  // to be self-healing, not just settable.
  it('clears a stale marker the moment the same credential succeeds again', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ issues: [] }));

    await listMyTickets();

    expect(clearJiraCredentialInvalidMarkerMock).toHaveBeenCalledTimes(1);
  });

  it('does not clear anything on a failed call', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(401));
    await listMyTickets();
    fetchMock.mockResolvedValueOnce(emptyResponse(403));
    await listMyTickets();
    fetchMock.mockResolvedValueOnce(emptyResponse(429));
    await listMyTickets();

    expect(clearJiraCredentialInvalidMarkerMock).not.toHaveBeenCalled();
  });
});
