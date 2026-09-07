import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../lib/jira/client.js', async (importOriginal) => ({
  // Only the transport is mocked. The failure classification is the real
  // one, so a test cannot pass by disagreeing with how the client actually
  // reports a 404.
  ...(await importOriginal<typeof import('../lib/jira/client.js')>()),
  jiraGet: vi.fn(),
  jiraPost: vi.fn(),
}));
vi.mock('../services/ticketRefs.service.js');

const { jiraGet, jiraPost } = await import('../lib/jira/client.js');
const ticketRefs = await import('../services/ticketRefs.service.js');
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

// The credential is handed in, never looked up: it belongs to the request
// that borrowed it from the desktop app, and this process stores none.
function provider() {
  const instance = getJiraProvider(CREDENTIAL);
  if (!instance) throw new Error('expected a provider');
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ticketRefs.remember).mockResolvedValue(REF_ROW);
  vi.mocked(ticketRefs.findById).mockResolvedValue(REF_ROW);
  vi.mocked(ticketRefs.rememberMany).mockResolvedValue(new Map([['ENG-4', REF_ROW]]));
});

describe('getJiraProvider', () => {
  it('is null when the request carried no credential, so callers can tell "off" from "found nothing"', () => {
    expect(getJiraProvider(null)).toBeNull();
  });

  it('reads with the credential it was handed, not one it went looking for', async () => {
    // The whole point of the per-request shape: two requests carrying
    // different credentials must reach different sites in the same process,
    // which is impossible if the provider resolves a stored singleton.
    vi.mocked(jiraGet).mockResolvedValue(ok(ISSUE));
    const other = { site: 'other.atlassian.net', email: 'them@example.com', apiToken: 'other-token' };

    await getJiraProvider(CREDENTIAL)!.getByIdentifier('ENG-4');
    await getJiraProvider(other)!.getByIdentifier('ENG-4');

    expect(vi.mocked(jiraGet).mock.calls[0][0]).toEqual(CREDENTIAL);
    expect(vi.mocked(jiraGet).mock.calls[1][0]).toEqual(other);
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

    const result = await provider().getByIdentifier('ENG-4');

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

    const result = await provider().getByIdentifier('ENG-4');

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

    await provider().getByIdentifier('ENG-4');

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
    expect(await provider().getByIdentifier('ENG-999')).toBeNull();
    expect(ticketRefs.remember).not.toHaveBeenCalled();
  });

  it('THROWS rather than returning null when Jira fails to answer', async () => {
    // The distinction the whole resolution algorithm rests on: a null would
    // let the caller conclude an identifier is native-only on the strength of
    // a lookup that never happened.
    for (const reason of ['network', 'rate_limited', 'invalid_credentials', 'forbidden', 'jira_error']) {
      vi.mocked(jiraGet).mockResolvedValue(fail(reason, `${reason} happened`));
      await expect(provider().getByIdentifier('ENG-4')).rejects.toThrow(ProviderUnavailableError);
    }
  });

  it('never asks Jira about something that cannot be an issue key', async () => {
    // The resolution algorithm asks Jira even when native already matched, so
    // this shape check is what stops that meaning "every lookup hits the
    // network".
    expect(await provider().getByIdentifier('not a key')).toBeNull();
    expect(await provider().getByIdentifier('')).toBeNull();
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it('still asks about an identifier that could be either provider’s', async () => {
    // "WI-42" is a valid Jira key shape AND this app's own identifier format.
    // Skipping the lookup here is exactly the bug the ambiguity check exists
    // to prevent.
    vi.mocked(jiraGet).mockResolvedValue(fail('not_found'));
    await provider().getByIdentifier('WI-42');
    expect(jiraGet).toHaveBeenCalledWith(CREDENTIAL, '/rest/api/3/issue/WI-42', expect.anything());
  });
});

describe('jiraProvider.getByRef', () => {
  it('resolves the ref to an issue key and fetches it', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok(ISSUE));

    const result = await provider().getByRef('tref-abc1234');

    expect(ticketRefs.findById).toHaveBeenCalledWith('tref-abc1234');
    expect(jiraGet).toHaveBeenCalledWith(CREDENTIAL, '/rest/api/3/issue/ENG-4', expect.anything());
    expect(result?.detail).toMatchObject({ identifier: 'ENG-4' });
  });

  it('returns null for an unknown ref without calling Jira', async () => {
    vi.mocked(ticketRefs.findById).mockResolvedValue(undefined);
    expect(await provider().getByRef('tref-nope')).toBeNull();
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it('refuses a ref belonging to a different site', async () => {
    // Survives a reconnect against another Jira: old handles stay readable in
    // the table but must not resolve against a site that never issued them.
    vi.mocked(ticketRefs.findById).mockResolvedValue({ ...REF_ROW, externalSite: 'other.atlassian.net' });
    expect(await provider().getByRef('tref-abc1234')).toBeNull();
    expect(jiraGet).not.toHaveBeenCalled();
  });
});

describe('jiraProvider.search', () => {
  it('searches summaries, matching what search_tickets already means natively', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [ISSUE] }));

    await provider().search('login', { limit: 51 });

    expect(jiraGet).toHaveBeenCalledWith(
      CREDENTIAL,
      '/rest/api/3/search/jql',
      expect.objectContaining({ jql: 'summary ~ "login" ORDER BY updated DESC', maxResults: '51' }),
    );
  });

  it('scopes by project key when given one', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [] }));

    await provider().search('login', { projectId: 'ENG', limit: 51 });

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

    await provider().search('" OR project = "SECRET', { limit: 51 });

    const jql = vi.mocked(jiraGet).mock.calls[0][2]?.jql ?? '';
    expect(jql).toBe('summary ~ "\\" OR project = \\"SECRET" ORDER BY updated DESC');
  });

  it('escapes a backslash before the quotes it would otherwise escape', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [] }));

    await provider().search('a\\"b', { limit: 51 });

    // The backslash is doubled first, so the user's own backslash cannot
    // consume the escape this function adds for the quote.
    expect(vi.mocked(jiraGet).mock.calls[0][2]?.jql).toBe('summary ~ "a\\\\\\"b" ORDER BY updated DESC');
  });

  it('records refs for every hit in ONE batched upsert', async () => {
    // Without refs the results are unusable: a model that searched and then
    // called get_ticket on a result would have nothing to pass. Batched
    // because a page can be 200 rows.
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [ISSUE] }));

    const results = await provider().search('login', { limit: 51 });

    expect(ticketRefs.rememberMany).toHaveBeenCalledTimes(1);
    expect(results[0].ref).toBe('tref-abc1234');
  });

  it('omits detail from search results, keeping descriptions out of list-time context', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [ISSUE] }));
    const [result] = await provider().search('login', { limit: 51 });
    expect(result.detail).toBeUndefined();
  });

  it('throws when the search itself fails', async () => {
    vi.mocked(jiraGet).mockResolvedValue(fail('rate_limited'));
    await expect(provider().search('login', { limit: 51 })).rejects.toThrow(ProviderUnavailableError);
  });

  it('skips malformed issues rather than failing the whole search', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ issues: [null, { noKey: true }, ISSUE] }));
    const results = await provider().search('login', { limit: 51 });
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

    const results = await provider().listComments('tref-abc1234', 51);

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

    const [comment] = await provider().listComments('tref-abc1234', 51);

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
    expect(await provider().listComments('tref-nope', 51)).toEqual([]);
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it('throws when Jira fails to answer', async () => {
    vi.mocked(jiraGet).mockResolvedValue(fail('network'));
    await expect(provider().listComments('tref-abc1234', 51)).rejects.toThrow(ProviderUnavailableError);
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
    const result = await provider().getByIdentifier('ENG-4');
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
    const result = await provider().getByIdentifier('ENG-4');
    expect(result?.stateGroup).toBe(expected);
  });

  it('survives an issue with every optional field absent', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ key: 'ENG-4', fields: {} }));

    const result = await provider().getByIdentifier('ENG-4');

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

// -----------------------------------------------------------------------
// Writes. Unreachable from a tool call — an approved proposal is the only
// caller (services/proposals.service.ts) — but the transport contract is
// worth pinning here, where the failure classification is the real one.
// -----------------------------------------------------------------------

const TRANSITIONS = {
  transitions: [
    { id: '11', name: 'Start progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    { id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } },
  ],
};

const ADF = {
  type: 'doc' as const,
  version: 1 as const,
  content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
};

describe('JiraProvider.listTransitions', () => {
  it('returns transition ids — not status ids — with the destination status group', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok(TRANSITIONS));

    const result = await provider().listTransitions('tref-abc1234');

    expect(vi.mocked(jiraGet).mock.calls[0][1]).toBe('/rest/api/3/issue/ENG-4/transitions');
    expect(result).toEqual([
      { id: '11', name: 'Start progress', group: 'started' },
      { id: '31', name: 'Done', group: 'completed' },
    ]);
  });

  it('normalizes a numeric id to a string, so comparing against a stored one is total', async () => {
    vi.mocked(jiraGet).mockResolvedValue(ok({ transitions: [{ id: 11, name: 'Start progress' }] }));

    const result = await provider().listTransitions('tref-abc1234');

    expect(result).toEqual([{ id: '11', name: 'Start progress', group: undefined }]);
  });

  it('is null for a ref minted against a different site, so a reconnect cannot cross the streams', async () => {
    vi.mocked(ticketRefs.findById).mockResolvedValue({ ...REF_ROW, externalSite: 'other.atlassian.net' });

    expect(await provider().listTransitions('tref-abc1234')).toBeNull();
    expect(jiraGet).not.toHaveBeenCalled();
  });

  it('throws rather than returning null when Jira could not answer at all', async () => {
    vi.mocked(jiraGet).mockResolvedValue(fail('network', "Couldn't reach Jira."));

    await expect(provider().listTransitions('tref-abc1234')).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});

describe('JiraProvider.applyTransition', () => {
  it('POSTs the transition id in the shape Jira expects', async () => {
    vi.mocked(jiraPost).mockResolvedValue(ok(undefined));

    const result = await provider().applyTransition('tref-abc1234', '31');

    expect(jiraPost).toHaveBeenCalledWith(CREDENTIAL, '/rest/api/3/issue/ENG-4/transitions', {
      transition: { id: '31' },
    });
    expect(result).toEqual({ ok: true });
  });

  // The three outcomes that are ABOUT this issue: they never get better by
  // retrying, so they must not escape as an error that reverts the proposal
  // to a card inviting the same failing click forever.
  it.each([
    ['not_found', 'Issue does not exist.'],
    ['forbidden', "The connected Jira account isn't allowed to do that."],
    ['jira_error', 'Transition id 31 is not valid for issue ENG-4.'],
  ])('reports a %s as a user-actionable refusal carrying Jira’s own words', async (reason, message) => {
    vi.mocked(jiraPost).mockResolvedValue(fail(reason, message));

    expect(await provider().applyTransition('tref-abc1234', '31')).toEqual({ ok: false, message });
  });

  it.each(['invalid_credentials', 'rate_limited', 'network', 'site_not_found'])(
    'throws on a %s, because that one IS worth retrying',
    async (reason) => {
      vi.mocked(jiraPost).mockResolvedValue(fail(reason));

      await expect(provider().applyTransition('tref-abc1234', '31')).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    },
  );

  it('refuses without a network call when the ref no longer resolves', async () => {
    vi.mocked(ticketRefs.findById).mockResolvedValue(undefined);

    expect(await provider().applyTransition('tref-abc1234', '31')).toEqual({
      ok: false,
      message: 'That Jira issue is no longer reachable from this workspace.',
    });
    expect(jiraPost).not.toHaveBeenCalled();
  });
});

describe('JiraProvider.postComment', () => {
  it('posts the caller-built ADF under a body key and returns the new comment id', async () => {
    vi.mocked(jiraPost).mockResolvedValue(ok({ id: '10501' }));

    const result = await provider().postComment('tref-abc1234', ADF);

    expect(jiraPost).toHaveBeenCalledWith(CREDENTIAL, '/rest/api/3/issue/ENG-4/comment', {
      body: ADF,
    });
    expect(result).toEqual({ ok: true, commentId: '10501' });
  });

  it('is null on a real 404 — the issue is gone', async () => {
    vi.mocked(jiraPost).mockResolvedValue(fail('not_found'));
    expect(await provider().postComment('tref-abc1234', ADF)).toBeNull();
  });

  // Mirrors applyTransition's own split exactly: 'forbidden' and 'jira_error'
  // are about THIS comment (no comment permission on the project, Jira
  // rejected the body) and never get better by retrying, so they must come
  // back as a user-actionable refusal rather than escape as an error that
  // reverts the proposal to a card inviting the same failing click forever.
  it.each([
    ['forbidden', "The connected Jira account isn't allowed to do that."],
    ['jira_error', 'Comment body failed validation.'],
  ])('reports a %s as a user-actionable refusal carrying Jira’s own words', async (reason, message) => {
    vi.mocked(jiraPost).mockResolvedValue(fail(reason, message));

    expect(await provider().postComment('tref-abc1234', ADF)).toEqual({ ok: false, message });
  });

  it.each(['invalid_credentials', 'rate_limited', 'network', 'site_not_found'])(
    'throws on a %s, because that one IS worth retrying',
    async (reason) => {
      vi.mocked(jiraPost).mockResolvedValue(fail(reason));

      await expect(provider().postComment('tref-abc1234', ADF)).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    },
  );
});
