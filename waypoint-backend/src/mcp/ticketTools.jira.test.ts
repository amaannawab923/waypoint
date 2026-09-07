import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The cross-provider behavior of the read tools: identifier resolution, id
 * prefix dispatch, and what happens when Jira cannot answer.
 *
 * Separate from ticketTools.test.ts, which pins the native-only behavior with
 * Jira deliberately disconnected. Keeping them apart means the native tests
 * cannot be quietly satisfied by a Jira code path, and these cannot be
 * satisfied by a native one.
 */

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/tickets.service.js');
vi.mock('../services/activity.service.js');
vi.mock('../services/states.service.js');
vi.mock('../services/members.service.js');
vi.mock('../lib/actorNames.js');
vi.mock('../providers/native.js');
// Only getJiraProvider is replaced. isExternalRef stays REAL, because the id
// prefix rule it encodes is one of the things under test — a mocked version
// would let a broken rule pass.
vi.mock('../providers/jira.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/jira.js')>()),
  getJiraProvider: vi.fn(),
}));

const ticketsService = await import('../services/tickets.service.js');
const { nativeProvider } = await import('../providers/native.js');
const { getJiraProvider } = await import('../providers/jira.js');
const { ProviderUnavailableError } = await import('../providers/types.js');
const {
  getTicketHandler,
  getTicketByIdentifierHandler,
  searchTicketsHandler,
  listCommentsHandler,
  listActivityHandler,
} = await import('./ticketTools.js');

const NATIVE_TICKET = {
  provider: 'native' as const,
  ref: 'wi-1',
  identifier: 'ENG-4',
  title: 'Native login bug',
  projectId: 'proj-1',
  stateId: 'state-1',
  stateName: 'In Progress',
  stateGroup: 'started',
  priority: 'high',
  dueDate: null,
  assigneeIds: [],
  assigneeNames: [],
  url: null,
  detail: { id: 'wi-1', identifier: 'ENG-4', title: 'Native login bug' },
};

const JIRA_TICKET = {
  provider: 'jira' as const,
  ref: 'tref-abc1234',
  identifier: 'ENG-4',
  title: 'Jira login bug',
  projectId: 'ENG',
  stateId: '10001',
  stateName: 'In Code Review',
  stateGroup: 'started',
  priority: 'urgent',
  dueDate: '2026-09-01',
  assigneeIds: ['acc-1'],
  assigneeNames: ['Priya Raman'],
  url: 'https://yourteam.atlassian.net/browse/ENG-4',
  detail: { provider: 'jira', id: 'tref-abc1234', identifier: 'ENG-4', title: 'Jira login bug' },
};

function jiraStub() {
  return {
    kind: 'jira' as const,
    getByRef: vi.fn(async () => null),
    getByIdentifier: vi.fn(async () => null),
    search: vi.fn(async () => []),
    listComments: vi.fn(async () => []),
  };
}

let jira: ReturnType<typeof jiraStub>;

function parse(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

/** Connects Jira for the test. Nothing is connected by default. */
function connectJira() {
  jira = jiraStub();
  vi.mocked(getJiraProvider).mockResolvedValue(jira);
  return jira;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getJiraProvider).mockResolvedValue(null);
  vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(null);
  vi.mocked(nativeProvider.getByRef).mockResolvedValue(null);
  vi.mocked(nativeProvider.search).mockResolvedValue([]);
  vi.mocked(nativeProvider.listComments).mockResolvedValue([]);
  vi.mocked(ticketsService.isTicketDraftOrMissing).mockResolvedValue(false);
});

describe('get_ticket_by_identifier resolution', () => {
  it('returns the native ticket when only native matches', async () => {
    connectJira();
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(NATIVE_TICKET);

    const result = await getTicketByIdentifierHandler({ identifier: 'ENG-4' });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ id: 'wi-1', title: 'Native login bug' });
  });

  it('returns the Jira issue when only Jira matches', async () => {
    connectJira().getByIdentifier.mockResolvedValue(JIRA_TICKET);

    const result = await getTicketByIdentifierHandler({ identifier: 'ENG-4' });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ provider: 'jira', id: 'tref-abc1234' });
  });

  it('ALWAYS asks Jira, even when native already matched', async () => {
    // The core ordering guarantee. Checking native first and returning early
    // is the natural way to write this handler and it is wrong: it resolves
    // an ambiguous identifier to whichever provider was checked first and
    // nobody ever learns there was a second ticket by that name.
    connectJira();
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(NATIVE_TICKET);

    await getTicketByIdentifierHandler({ identifier: 'ENG-4' });

    expect(jira.getByIdentifier).toHaveBeenCalledWith('ENG-4');
  });

  it('refuses to guess when both match, and names both plus their ids', async () => {
    connectJira().getByIdentifier.mockResolvedValue(JIRA_TICKET);
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(NATIVE_TICKET);

    const result = await getTicketByIdentifierHandler({ identifier: 'ENG-4' });

    expect(result.isError).toBe(true);
    const message = result.content[0].text;
    // Specific enough for the model to correct itself without another
    // exploratory call — both titles, both unambiguous ids, and the exact
    // argument to retry with.
    expect(message).toContain('ambiguous');
    expect(message).toContain('Native login bug');
    expect(message).toContain('Jira login bug');
    expect(message).toContain('wi-1');
    expect(message).toContain('tref-abc1234');
    expect(message).toContain('provider="native"');
    expect(message).toContain('provider="jira"');
  });

  it('reports a real miss when neither matches', async () => {
    connectJira();

    const result = await getTicketByIdentifierHandler({ identifier: 'ENG-999' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  it('asks only native when Jira is not connected, and does not error about it', async () => {
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(NATIVE_TICKET);

    const result = await getTicketByIdentifierHandler({ identifier: 'ENG-4' });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ id: 'wi-1' });
  });
});

describe('get_ticket_by_identifier with an explicit provider', () => {
  it('looks only in native when told native', async () => {
    connectJira();
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(NATIVE_TICKET);

    const result = await getTicketByIdentifierHandler({ identifier: 'ENG-4', provider: 'native' });

    expect(parse(result)).toMatchObject({ id: 'wi-1' });
    // An explicit provider is an instruction, not a hint: no second lookup,
    // and therefore no ambiguity error for an identifier already disambiguated.
    expect(jira.getByIdentifier).not.toHaveBeenCalled();
  });

  it('looks only in Jira when told jira', async () => {
    connectJira().getByIdentifier.mockResolvedValue(JIRA_TICKET);
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(NATIVE_TICKET);

    const result = await getTicketByIdentifierHandler({ identifier: 'ENG-4', provider: 'jira' });

    expect(parse(result)).toMatchObject({ id: 'tref-abc1234' });
    expect(nativeProvider.getByIdentifier).not.toHaveBeenCalled();
  });

  it('explains that Jira is not connected rather than reporting a miss', async () => {
    const result = await getTicketByIdentifierHandler({ identifier: 'ENG-4', provider: 'jira' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not connected');
    // "not found" would send the model looking for a ticket, when the real
    // problem is configuration and nothing about the ticket is known.
    expect(result.content[0].text).not.toMatch(/^ticket not found/i);
  });
});

describe('get_ticket_by_identifier when Jira cannot answer', () => {
  it('still returns the native ticket, so an optional integration cannot break the native path', async () => {
    connectJira().getByIdentifier.mockRejectedValue(new ProviderUnavailableError('Jira took too long to respond.'));
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(NATIVE_TICKET);

    const result = await getTicketByIdentifierHandler({ identifier: 'ENG-4' });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ id: 'wi-1' });
  });

  it('refuses to report "not found" when the Jira lookup never happened', async () => {
    // The one branch worth being strict about: "not found" is a positive
    // claim, and here it would rest on a lookup that failed. The model would
    // act on it and tell the user the ticket does not exist.
    connectJira().getByIdentifier.mockRejectedValue(new ProviderUnavailableError('Jira took too long to respond.'));

    const result = await getTicketByIdentifierHandler({ identifier: 'ENG-4' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('could not be reached');
    expect(result.content[0].text).not.toMatch(/not found/i);
  });

  it('lets a genuine bug through to the safety net instead of dressing it as a Jira outage', async () => {
    connectJira().getByIdentifier.mockRejectedValue(new TypeError('undefined is not a function'));

    await expect(getTicketByIdentifierHandler({ identifier: 'ENG-4' })).rejects.toThrow(TypeError);
  });
});

describe('id prefix dispatch', () => {
  it('routes a tref id to Jira and a wi id to native, with no provider argument', async () => {
    connectJira().getByRef.mockResolvedValue(JIRA_TICKET);
    vi.mocked(nativeProvider.getByRef).mockResolvedValue(NATIVE_TICKET);

    expect(parse(await getTicketHandler({ id: 'tref-abc1234' }))).toMatchObject({ id: 'tref-abc1234' });
    expect(jira.getByRef).toHaveBeenCalledWith('tref-abc1234');
    expect(nativeProvider.getByRef).not.toHaveBeenCalled();

    expect(parse(await getTicketHandler({ id: 'wi-1' }))).toMatchObject({ id: 'wi-1' });
    expect(nativeProvider.getByRef).toHaveBeenCalledWith('wi-1');
  });

  it('routes list_comments the same way', async () => {
    connectJira().listComments.mockResolvedValue([
      {
        id: '10100',
        ticketId: 'tref-abc1234',
        authorId: 'acc-2',
        authorName: 'Sam Okafor',
        body: 'Still failing',
        bodyFormat: 'text',
        createdAt: '2026-08-21T09:00:00.000Z',
      },
    ]);

    const result = parse(await listCommentsHandler({ ticketId: 'tref-abc1234' }));

    expect(jira.listComments).toHaveBeenCalledWith('tref-abc1234', 51);
    // A Jira comment is flattened ADF, so it carries body + bodyFormat rather
    // than bodyHtml. Calling it bodyHtml would be a lie the model could act on.
    expect(result.items[0]).toMatchObject({ body: 'Still failing', bodyFormat: 'text' });
    expect(result.items[0].bodyHtml).toBeUndefined();
  });

  it('never runs the native draft check for an external ref', async () => {
    // Drafts are this app's concept. Running the check would look up a
    // ticket_refs id in the tickets table, miss, and report "not found" for a
    // Jira issue that is perfectly readable.
    connectJira();
    await listCommentsHandler({ ticketId: 'tref-abc1234' });
    expect(ticketsService.isTicketDraftOrMissing).not.toHaveBeenCalled();
  });

  it('says activity history is unavailable for a Jira issue rather than reporting a miss', async () => {
    connectJira();

    const result = await listActivityHandler({ ticketId: 'tref-abc1234' });

    expect(result.isError).toBe(true);
    // "not found" would have the model conclude the Jira issue has no
    // history, which is a claim about the ticket rather than about this tool.
    expect(result.content[0].text).not.toMatch(/not found/i);
    expect(result.content[0].text).toContain('list_comments');
  });
});

describe('search_tickets across providers', () => {
  it('merges native and Jira results, tagging the Jira ones', async () => {
    connectJira().search.mockResolvedValue([JIRA_TICKET]);
    vi.mocked(nativeProvider.search).mockResolvedValue([NATIVE_TICKET]);

    const result = parse(await searchTicketsHandler({ query: 'login' }));

    expect(result.items).toHaveLength(2);
    // Native results keep exactly the shape they always had, with no
    // provider key added.
    expect(result.items[0]).not.toHaveProperty('provider');
    expect(result.items[0]).toMatchObject({ id: 'wi-1', title: 'Native login bug' });
    expect(result.items[1]).toMatchObject({
      provider: 'jira',
      id: 'tref-abc1234',
      url: 'https://yourteam.atlassian.net/browse/ENG-4',
    });
  });

  it('asks each provider for limit + 1, so truncation is detected per source', async () => {
    connectJira();
    await searchTicketsHandler({ query: 'login', limit: 2 });
    expect(nativeProvider.search).toHaveBeenCalledWith('login', { projectId: undefined, limit: 3 });
    expect(jira.search).toHaveBeenCalledWith('login', { projectId: undefined, limit: 3 });
  });

  it('marks the result truncated when either source had more', async () => {
    // A full page of native hits must not mask that Jira had more to give.
    connectJira().search.mockResolvedValue([JIRA_TICKET, JIRA_TICKET, JIRA_TICKET]);
    vi.mocked(nativeProvider.search).mockResolvedValue([NATIVE_TICKET]);

    const result = parse(await searchTicketsHandler({ query: 'login', limit: 2 }));

    expect(result.truncated).toBe(true);
  });

  it('degrades to native results with an explicit flag when Jira search fails', async () => {
    connectJira().search.mockRejectedValue(new ProviderUnavailableError('Jira is rate-limiting this account.'));
    vi.mocked(nativeProvider.search).mockResolvedValue([NATIVE_TICKET]);

    const result = parse(await searchTicketsHandler({ query: 'login' }));

    // Half an answer beats none: a Jira outage must not break searching this
    // app's own tickets.
    expect(result.items).toHaveLength(1);
    // Flagged rather than silent, so the model can say "I could not check
    // Jira" instead of implying Jira had no matches.
    expect(result.jiraUnavailable).toBe(true);
  });

  it('does not set the unavailable flag when Jira is merely not connected', async () => {
    vi.mocked(nativeProvider.search).mockResolvedValue([NATIVE_TICKET]);

    const result = parse(await searchTicketsHandler({ query: 'login' }));

    expect(result.jiraUnavailable).toBeUndefined();
  });

  it('restricts to one provider when asked', async () => {
    connectJira().search.mockResolvedValue([JIRA_TICKET]);
    vi.mocked(nativeProvider.search).mockResolvedValue([NATIVE_TICKET]);

    const nativeOnly = parse(await searchTicketsHandler({ query: 'login', provider: 'native' }));
    expect(nativeOnly.items).toHaveLength(1);
    expect(jira.search).not.toHaveBeenCalled();

    const jiraOnly = parse(await searchTicketsHandler({ query: 'login', provider: 'jira' }));
    expect(jiraOnly.items).toEqual([expect.objectContaining({ provider: 'jira' })]);
  });
});

describe('the safety net and unreachable providers', () => {
  it('reports a Jira outage on a single-provider path instead of scrubbing it to an internal error', async () => {
    // withErrorSafetyNet exists to keep raw internals out of the model's
    // context, but an unreachable integration is not an internal detail —
    // scrubbing it discards the only part the model can act on, which is
    // whether a retry is worth anything.
    const { withErrorSafetyNet, INTERNAL_ERROR_MESSAGE } = await import('./ticketTools.js');
    connectJira().getByRef.mockRejectedValue(new ProviderUnavailableError('Jira took too long to respond.'));

    const wrapped = withErrorSafetyNet('get_ticket', getTicketHandler);
    const result = await wrapped({ id: 'tref-abc1234' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('could not be reached');
    expect(result.content[0].text).not.toBe(INTERNAL_ERROR_MESSAGE);
  });

  it('still scrubs a genuine internal error', async () => {
    const { withErrorSafetyNet, INTERNAL_ERROR_MESSAGE } = await import('./ticketTools.js');
    connectJira().getByRef.mockRejectedValue(new TypeError('undefined is not a function'));

    const result = await withErrorSafetyNet('get_ticket', getTicketHandler)({ id: 'tref-abc1234' });

    expect(result.content[0].text).toBe(INTERNAL_ERROR_MESSAGE);
  });
});
