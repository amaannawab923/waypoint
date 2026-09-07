import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../lib/jira/client.js', async (importOriginal) => ({
  // Only the transport is mocked. validateCredential and the failure
  // classification are the real ones, so a test cannot pass by disagreeing
  // with how the client actually reports a 404.
  ...(await importOriginal<typeof import('../lib/jira/client.js')>()),
  jiraGet: vi.fn(),
}));
vi.mock('../services/ticketRefs.service.js');
vi.mock('../services/jiraConnection.service.js');

const { jiraGet } = await import('../lib/jira/client.js');
const ticketRefs = await import('../services/ticketRefs.service.js');
const jiraConnection = await import('../services/jiraConnection.service.js');
const { getJiraProvider, isExternalRef } = await import('./jira.js');
const { ProviderUnavailableError } = await import('./types.js');

const SITE = 'yourteam.atlassian.net';
const CREDENTIAL = { site: SITE, email: 'me@example.com', apiToken: 'token' };

const ISSUE = {
  key: 'ENG-4',
  fields: {
    summary: 'Login times out',
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Repro on staging' }] }] },
    status: { id: '10001', name: 'In Code Review', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'Highest' },
    duedate: '2026-09-01',
    assignee: { accountId: 'acc-1', displayName: 'Priya Raman' },
    reporter: { displayName: 'Sam Okafor' },
    project: { key: 'ENG', name: 'Engineering' },
    issuetype: { name: 'Bug' },
    labels: ['regression'],
    created: '2026-08-01T00:00:00.000Z',
    updated: '2026-08-20T00:00:00.000Z',
  },
};

const REF_ROW = {
  id: 'tref-abc1234',
  provider: 'jira',
  externalId: 'ENG-4',
  externalSite: SITE,
  cachedIdentifier: 'ENG-4',
  cachedTitle: 'Login times out',
  cachedUrl: `https://${SITE}/browse/ENG-4`,
  lastSeenAt: new Date('2026-08-20T00:00:00.000Z'),
};

const ok = <T>(value: T) => ({ ok: true as const, value });
const fail = (reason: string, message = 'boom') => ({ ok: false as const, reason, message });

async function provider() {
  const instance = await getJiraProvider();
  if (!instance) throw new Error('expected a provider');
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(jiraConnection.getCredential).mockResolvedValue(CREDENTIAL);
  vi.mocked(ticketRefs.remember).mockResolvedValue(REF_ROW);
  vi.mocked(ticketRefs.findById).mockResolvedValue(REF_ROW);
  vi.mocked(ticketRefs.rememberMany).mockResolvedValue(new Map([['ENG-4', REF_ROW]]));
});

describe('getJiraProvider', () => {
  it('is null when Jira is not connected, so callers can tell "off" from "found nothing"', async () => {
    vi.mocked(jiraConnection.getCredential).mockResolvedValue(null);
    expect(await getJiraProvider()).toBeNull();
  });
});

describe('isExternalRef', () => {
  it('separates external refs from native ticket ids by prefix alone', () => {
    // This is what makes provider dispatch possible on a bare id, with no
    // lookup and no extra tool argument.
    expect(isExternalRef('tref-abc1234')).toBe(true);
    expect(isExternalRef('wi-abc1234')).toBe(false);
    expect(isExternalRef('ENG-4')).toBe(false);
  });
});

describe('jiraProvider.getByIdentifier', () => {
  it('does one live point-lookup for the exact key and normalizes the issue', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok(ISSUE));

    const result = await (await provider()).getByIdentifier('ENG-4');

    expect(jiraGet).toHaveBeenCalledTimes(1);
    expect(jiraGet).toHaveBeenCalledWith(CREDENTIAL, '/rest/api/3/issue/ENG-4', expect.anything());
    expect(result).toMatchObject({
      provider: 'jira',
      // The local handle, NOT the issue key — an issue key is ambiguous with
      // a native identifier by construction.
      ref: 'tref-abc1234',
      identifier: 'ENG-4',
      title: 'Login times out',
      projectId: 'ENG',
      stateName: 'In Code Review',
      // Mapped from the status CATEGORY, the only fixed vocabulary in a
      // per-site-configurable workflow.
      stateGroup: 'started',
      priority: 'urgent',
      dueDate: '2026-09-01',
      assigneeIds: ['acc-1'],
      assigneeNames: ['Priya Raman'],
      url: `https://${SITE}/browse/ENG-4`,
    });
  });

  it('flattens the ADF description into the detail record', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok(ISSUE));

    const result = await (await provider()).getByIdentifier('ENG-4');

    expect(result?.detail).toMatchObject({
      description: 'Repro on staging',
      priorityName: 'Highest',
      reporterName: 'Sam Okafor',
      issueType: 'Bug',
      labels: ['regression'],
    });
  });

  it('records a ref on success, so a follow-up get_ticket has an id to use', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok(ISSUE));

    await (await provider()).getByIdentifier('ENG-4');

    expect(ticketRefs.remember).toHaveBeenCalledWith({
      provider: 'jira',
      site: SITE,
      externalId: 'ENG-4',
      identifier: 'ENG-4',
      title: 'Login times out',
      url: `https://${SITE}/browse/ENG-4`,
    });
  });

  it('returns null on a real 404 — Jira answered, and its answer is usable', async () => {
    vi.mocked(jiraGet).mockResolvedValue(fail('not_found'));
    expect(await (await provider()).getByIdentifier('ENG-999')).toBeNull();
    expect(ticketRefs.remember).not.toHaveBeenCalled();
  });

  it('THROWS rather than returning null when Jira fails to answer', async () => {
    // The distinction the whole resolution algorithm rests on: a null would
    // let the caller conclude an identifier is native-only on the strength of
    // a lookup that never happened.
    for (const reason of ['network', 'rate_limited', 'invalid_credentials', 'forbidden', 'jira_error']) {
      vi.mocked(jiraGet).mockResolvedValue(fail(reason, `${reason} happened`));
      await expect((await provider()).getByIdentifier('ENG-4')).rejects.toThrow(ProviderUnavailableError);
    }
  });

  it('never asks Jira about something that cannot be an issue key', async () => {
    // The resolution algorithm asks Jira even when native already matched, so
    // this shape check is what stops that meaning "every lookup hits the
    // network".
    expect(await (await provider()).getByIdentifier('not a key')).toBeNull();
    expect(await (await provider()).getByIdentifier('')).toBeNull();
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it('still asks about an identifier that could be either provider’s', async () => {
    // "WI-42" is a valid Jira key shape AND this app's own identifier format.
    // Skipping the lookup here is exactly the bug the ambiguity check exists
    // to prevent.
    vi.mocked(jiraGet).mockResolvedValue(fail('not_found'));
    await (await provider()).getByIdentifier('WI-42');
    expect(jiraGet).toHaveBeenCalledWith(CREDENTIAL, '/rest/api/3/issue/WI-42', expect.anything());
  });
});

describe('jiraProvider.getByRef', () => {
  it('resolves the ref to an issue key and fetches it', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok(ISSUE));

    const result = await (await provider()).getByRef('tref-abc1234');

    expect(ticketRefs.findById).toHaveBeenCalledWith('tref-abc1234');
    expect(jiraGet).toHaveBeenCalledWith(CREDENTIAL, '/rest/api/3/issue/ENG-4', expect.anything());
    expect(result?.detail).toMatchObject({ identifier: 'ENG-4' });
  });

  it('returns null for an unknown ref without calling Jira', async () => {
    vi.mocked(ticketRefs.findById).mockResolvedValue(undefined);
    expect(await (await provider()).getByRef('tref-nope')).toBeNull();
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it('refuses a ref belonging to a different site', async () => {
    // Survives a reconnect against another Jira: old handles stay readable in
    // the table but must not resolve against a site that never issued them.
    vi.mocked(ticketRefs.findById).mockResolvedValue({ ...REF_ROW, externalSite: 'other.atlassian.net' });
    expect(await (await provider()).getByRef('tref-abc1234')).toBeNull();
    expect(jiraGet).not.toHaveBeenCalled();
  });
});

describe('jiraProvider.search', () => {
  it('searches summaries, matching what search_tickets already means natively', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [ISSUE] }));

    await (await provider()).search('login', { limit: 51 });

    expect(jiraGet).toHaveBeenCalledWith(
      CREDENTIAL,
      '/rest/api/3/search/jql',
      expect.objectContaining({ jql: 'summary ~ "login" ORDER BY updated DESC', maxResults: '51' }),
    );
  });

  it('scopes by project key when given one', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [] }));

    await (await provider()).search('login', { projectId: 'ENG', limit: 51 });

    expect(jiraGet).toHaveBeenCalledWith(
      CREDENTIAL,
      '/rest/api/3/search/jql',
      expect.objectContaining({ jql: 'summary ~ "login" AND project = "ENG" ORDER BY updated DESC' }),
    );
  });

  it('quotes a query that would otherwise break out of its JQL string literal', async () => {
    // The security boundary: `query` is model-supplied and JQL is a query
    // language. A term must not be able to become a clause.
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [] }));

    await (await provider()).search('" OR project = "SECRET', { limit: 51 });

    const jql = vi.mocked(jiraGet).mock.calls[0][2]?.jql ?? '';
    expect(jql).toBe('summary ~ "\\" OR project = \\"SECRET" ORDER BY updated DESC');
  });

  it('escapes a backslash before the quotes it would otherwise escape', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [] }));

    await (await provider()).search('a\\"b', { limit: 51 });

    // The backslash is doubled first, so the user's own backslash cannot
    // consume the escape this function adds for the quote.
    expect(vi.mocked(jiraGet).mock.calls[0][2]?.jql).toBe('summary ~ "a\\\\\\"b" ORDER BY updated DESC');
  });

  it('records refs for every hit in ONE batched upsert', async () => {
    // Without refs the results are unusable: a model that searched and then
    // called get_ticket on a result would have nothing to pass. Batched
    // because a page can be 200 rows.
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [ISSUE] }));

    const results = await (await provider()).search('login', { limit: 51 });

    expect(ticketRefs.rememberMany).toHaveBeenCalledTimes(1);
    expect(results[0].ref).toBe('tref-abc1234');
  });

  it('omits detail from search results, keeping descriptions out of list-time context', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [ISSUE] }));
    const [result] = await (await provider()).search('login', { limit: 51 });
    expect(result.detail).toBeUndefined();
  });

  it('throws when the search itself fails', async () => {
    vi.mocked(jiraGet).mockResolvedValue(fail('rate_limited'));
    await expect((await provider()).search('login', { limit: 51 })).rejects.toThrow(ProviderUnavailableError);
  });

  it('skips malformed issues rather than failing the whole search', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [null, { noKey: true }, ISSUE] }));
    const results = await (await provider()).search('login', { limit: 51 });
    expect(results).toHaveLength(1);
  });
});

describe('jiraProvider.listComments', () => {
  const COMMENT = {
    id: '10100',
    author: { accountId: 'acc-2', displayName: 'Sam Okafor' },
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Still failing' }] }] },
    created: '2026-08-21T09:00:00.000Z',
  };

  it('fetches newest-first and returns oldest-first, matching the native contract', async () => {
    const older = { ...COMMENT, id: '10099', created: '2026-08-20T09:00:00.000Z' };
    vi.mocked(jiraGet).mockResolvedValue(ok({ comments: [COMMENT, older] }));

    const results = await (await provider()).listComments('tref-abc1234', 51);

    // Newest-first at the API, because a cap applied to ascending order
    // returns the OLDEST N — a thread whose recent activity is invisible.
    expect(jiraGet).toHaveBeenCalledWith(
      CREDENTIAL,
      '/rest/api/3/issue/ENG-4/comment',
      expect.objectContaining({ orderBy: '-created', maxResults: '51' }),
    );
    expect(results.map((c) => c.id)).toEqual(['10099', '10100']);
  });

  it('flattens the ADF body to plain text and says so', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ comments: [COMMENT] }));

    const [comment] = await (await provider()).listComments('tref-abc1234', 51);

    expect(comment).toEqual({
      id: '10100',
      // The ref the caller passed, echoed back — not a Jira-internal id the
      // model has never seen.
      ticketId: 'tref-abc1234',
      authorId: 'acc-2',
      authorName: 'Sam Okafor',
      body: 'Still failing',
      // Not bodyHtml: calling flattened ADF "html" would be a lie the model
      // could act on.
      bodyFormat: 'text',
      createdAt: '2026-08-21T09:00:00.000Z',
    });
  });

  it('returns nothing for an unknown ref without calling Jira', async () => {
    vi.mocked(ticketRefs.findById).mockResolvedValue(undefined);
    expect(await (await provider()).listComments('tref-nope', 51)).toEqual([]);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it('throws when Jira fails to answer', async () => {
    vi.mocked(jiraGet).mockResolvedValue(fail('network'));
    await expect((await provider()).listComments('tref-abc1234', 51)).rejects.toThrow(ProviderUnavailableError);
  });
});

describe('field mapping', () => {
  it.each([
    ['Highest', 'urgent'],
    ['High', 'high'],
    ['Medium', 'medium'],
    ['Low', 'low'],
    // Lossy on purpose: this app has no "lowest". The raw name survives in
    // the detail record.
    ['Lowest', 'low'],
    // A renamed or replaced scheme becomes 'none' rather than a guess —
    // 'none' already means "no priority information".
    ['Blocker-ish', 'none'],
  ])('maps the Jira priority %s to %s', async (name, expected) => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ ...ISSUE, fields: { ...ISSUE.fields, priority: { name } } }));
    const result = await (await provider()).getByIdentifier('ENG-4');
    expect(result?.priority).toBe(expected);
  });

  it.each([
    ['new', 'unstarted'],
    ['indeterminate', 'started'],
    // Never 'cancelled': Jira does not distinguish shipped from abandoned at
    // the category level, and guessing would assert what the source does not.
    ['done', 'completed'],
  ])('maps the Jira status category %s to the state group %s', async (key, expected) => {
    vi.mocked(jiraGet).mockResolvedValue(
      ok({ ...ISSUE, fields: { ...ISSUE.fields, status: { id: '1', name: 'X', statusCategory: { key } } } }),
    );
    const result = await (await provider()).getByIdentifier('ENG-4');
    expect(result?.stateGroup).toBe(expected);
  });

  it('survives an issue with every optional field absent', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ key: 'ENG-4', fields: {} }));

    const result = await (await provider()).getByIdentifier('ENG-4');

    expect(result).toMatchObject({
      identifier: 'ENG-4',
      title: '',
      priority: 'none',
      stateGroup: undefined,
      dueDate: null,
      assigneeIds: [],
      assigneeNames: [],
    });
  });
});
