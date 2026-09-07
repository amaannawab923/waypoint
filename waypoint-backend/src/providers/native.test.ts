import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same service-layer mocking as mcp/ticketTools.test.ts: these tests are
// about what the provider does with a service's answer, not about the
// services themselves (covered in tickets.service.test.ts).
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/tickets.service.js');
vi.mock('../services/comments.service.js');
vi.mock('../services/states.service.js');
vi.mock('../lib/actorNames.js');

const ticketsService = await import('../services/tickets.service.js');
const commentsService = await import('../services/comments.service.js');
const statesService = await import('../services/states.service.js');
const { resolveActorNames } = await import('../lib/actorNames.js');
const { nativeProvider, normalizeNativeTickets } = await import('./native.js');

/**
 * The zero-behavior-change contract.
 *
 * mcp/ticketTools.ts used to call ticketsService/commentsService directly and
 * build its own projections. That code now lives behind nativeProvider, and
 * the point of these tests is to pin the claim that moving it changed
 * nothing — because "nothing changed" is not something a reader can verify by
 * looking at a diff that moves fifty lines between files.
 *
 * Three separate things have to hold, and only the first is obvious:
 *
 *   1. The same service functions get called with the same arguments.
 *   2. The emitted JSON has the same keys with the same values.
 *   3. Name resolution stays BATCHED — one query pair per call regardless of
 *      how many rows came back. This is the one a purely value-based test
 *      would miss entirely: normalizing row-by-row returns identical data
 *      while turning a 50-row search into 100 extra queries.
 *
 * The projections below are transcribed from the pre-provider implementation
 * rather than derived from the new one, deliberately: a test that computed
 * its expectation the same way the code does would agree with any future
 * change to both.
 */

// A full enriched ticket, matching what ticketsService.getTicket returns.
const ENRICHED = {
  id: 'wi-1',
  projectId: 'proj-1',
  identifier: 'WI-1',
  sequenceId: 1,
  title: 'Fix login bug',
  description: 'the description',
  stateId: 'state-1',
  priority: 'high' as const,
  source: 'manual' as const,
  workstreamId: null,
  sprintId: 'sp-1',
  parentId: null,
  estimatePoints: '3',
  estimateValue: null,
  startDate: null,
  dueDate: '2026-08-27',
  createdById: 'mem-1',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-20T00:00:00.000Z'),
  attachmentCount: 0,
  linkCount: 1,
  isDraft: false,
  sortOrder: '0',
  assigneeIds: ['mem-4'],
  labelIds: ['lab-1'],
  links: [{ id: 'ln-1', ticketId: 'wi-1', url: 'https://example.com', label: 'spec', createdAt: new Date(0) }],
};

const STATE_NAMES = new Map([['state-1', { name: 'In Progress', group: 'started' }]]);
const ASSIGNEE_NAMES = new Map([['mem-4', 'Lena']]);

/** The exact object get_ticket emitted before providers existed:
 *  `{ ...enriched, assigneeNames, stateName, stateGroup }`. */
const EXPECTED_DETAIL = {
  ...ENRICHED,
  assigneeNames: ['Lena'],
  stateName: 'In Progress',
  stateGroup: 'started',
};

/** The exact eleven fields list_tickets/search_tickets emitted, in order. */
const EXPECTED_SUMMARY_FIELDS = [
  'id',
  'identifier',
  'title',
  'projectId',
  'stateId',
  'stateName',
  'stateGroup',
  'priority',
  'dueDate',
  'assigneeIds',
  'assigneeNames',
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveActorNames).mockResolvedValue(ASSIGNEE_NAMES);
  vi.mocked(statesService.resolveStateNames).mockResolvedValue(STATE_NAMES);
});

describe('nativeProvider.getByRef', () => {
  it('calls ticketsService.getTicket with the ref and carries the full pre-provider detail record', async () => {
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ENRICHED);

    const result = await nativeProvider.getByRef('wi-1');

    expect(ticketsService.getTicket).toHaveBeenCalledWith('wi-1');
    expect(result?.detail).toEqual(EXPECTED_DETAIL);
  });

  it('keeps every column of the enriched row in the detail record', async () => {
    // The regression this guards: rebuilding detail field-by-field from the
    // normalized fields would silently drop sprintId, estimatePoints, links,
    // labelIds and the rest — a real loss of information that no normalized
    // field would reveal.
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ENRICHED);

    const result = await nativeProvider.getByRef('wi-1');

    for (const key of Object.keys(ENRICHED)) {
      expect(result?.detail).toHaveProperty(key);
    }
  });

  it('exposes the normalized fields the summary projection is built from', async () => {
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ENRICHED);

    const result = await nativeProvider.getByRef('wi-1');

    expect(result).toMatchObject({
      provider: 'native',
      ref: 'wi-1',
      identifier: 'WI-1',
      title: 'Fix login bug',
      projectId: 'proj-1',
      stateId: 'state-1',
      stateName: 'In Progress',
      stateGroup: 'started',
      priority: 'high',
      dueDate: '2026-08-27',
      assigneeIds: ['mem-4'],
      assigneeNames: ['Lena'],
      // Null, not a guessed link: this process does not know what origin the
      // desktop app is being viewed under.
      url: null,
    });
  });

  it('returns null for a draft, without leaking that the ticket exists', async () => {
    vi.mocked(ticketsService.getTicket).mockResolvedValue({ ...ENRICHED, isDraft: true });
    expect(await nativeProvider.getByRef('wi-1')).toBeNull();
  });

  it('returns null for a missing ticket', async () => {
    vi.mocked(ticketsService.getTicket).mockResolvedValue(undefined);
    expect(await nativeProvider.getByRef('nope')).toBeNull();
  });
});

describe('nativeProvider.getByIdentifier', () => {
  it('calls ticketsService.getTicketByIdentifier and produces the same detail record', async () => {
    vi.mocked(ticketsService.getTicketByIdentifier).mockResolvedValue(ENRICHED);

    const result = await nativeProvider.getByIdentifier('WI-1');

    expect(ticketsService.getTicketByIdentifier).toHaveBeenCalledWith('WI-1');
    expect(result?.detail).toEqual(EXPECTED_DETAIL);
  });

  it('returns null for a draft', async () => {
    vi.mocked(ticketsService.getTicketByIdentifier).mockResolvedValue({ ...ENRICHED, isDraft: true });
    expect(await nativeProvider.getByIdentifier('WI-99')).toBeNull();
  });
});

describe('nativeProvider.search', () => {
  it('passes query, projectId and limit through to ticketsService.searchTickets untouched', async () => {
    // The limit is the tool layer's already-incremented "limit + 1" used to
    // detect truncation. A provider that clamped it would break truncation
    // detection while still returning plausible rows.
    vi.mocked(ticketsService.searchTickets).mockResolvedValue([ENRICHED]);

    await nativeProvider.search('login', { projectId: 'proj-1', limit: 51 });

    expect(ticketsService.searchTickets).toHaveBeenCalledWith('login', 'proj-1', 51);
  });

  it('omits detail from search results, keeping description out of list-time context', async () => {
    vi.mocked(ticketsService.searchTickets).mockResolvedValue([ENRICHED]);

    const [result] = await nativeProvider.search('login', { limit: 51 });

    expect(result.detail).toBeUndefined();
  });

  it('resolves names in ONE batched pair of calls across the whole result set', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      ...ENRICHED,
      id: `wi-${i}`,
      identifier: `WI-${i}`,
      assigneeIds: [`mem-${i}`],
      stateId: `state-${i}`,
    }));
    vi.mocked(ticketsService.searchTickets).mockResolvedValue(rows);

    await nativeProvider.search('anything', { limit: 51 });

    expect(resolveActorNames).toHaveBeenCalledTimes(1);
    expect(statesService.resolveStateNames).toHaveBeenCalledTimes(1);
    // Every id, flattened, in one call — the pre-provider batching contract.
    expect(resolveActorNames).toHaveBeenCalledWith(rows.flatMap((r) => r.assigneeIds));
    expect(statesService.resolveStateNames).toHaveBeenCalledWith(rows.map((r) => r.stateId));
  });

  it('falls back to raw ids when a name cannot be resolved, rather than dropping or throwing', async () => {
    vi.mocked(ticketsService.searchTickets).mockResolvedValue([ENRICHED]);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map());
    vi.mocked(statesService.resolveStateNames).mockResolvedValue(new Map());

    const [result] = await nativeProvider.search('login', { limit: 51 });

    expect(result.assigneeNames).toEqual(['mem-4']);
    expect(result.stateName).toBe('state-1');
    // undefined, not null — a Map miss used to yield undefined, which
    // JSON.stringify drops from the emitted result entirely. Emitting null
    // instead would add a key that was never there.
    expect(result.stateGroup).toBeUndefined();
  });
});

describe('normalizeNativeTickets', () => {
  it('produces exactly the eleven summary source fields the pre-provider projection used', async () => {
    const [normalized] = await normalizeNativeTickets([ENRICHED]);

    // Transcribed from the old toSummaries, keyed off `ref` where it used
    // `id`. If a field were added, removed or renamed here, the emitted
    // summary would change shape without any test of the tool layer noticing.
    const summary = {
      id: normalized.ref,
      identifier: normalized.identifier,
      title: normalized.title,
      projectId: normalized.projectId,
      stateId: normalized.stateId,
      stateName: normalized.stateName,
      stateGroup: normalized.stateGroup,
      priority: normalized.priority,
      dueDate: normalized.dueDate,
      assigneeIds: normalized.assigneeIds,
      assigneeNames: normalized.assigneeNames,
    };
    expect(Object.keys(summary)).toEqual(EXPECTED_SUMMARY_FIELDS);
    expect(summary).toEqual({
      id: 'wi-1',
      identifier: 'WI-1',
      title: 'Fix login bug',
      projectId: 'proj-1',
      stateId: 'state-1',
      stateName: 'In Progress',
      stateGroup: 'started',
      priority: 'high',
      dueDate: '2026-08-27',
      assigneeIds: ['mem-4'],
      assigneeNames: ['Lena'],
    });
  });
});

describe('nativeProvider.listComments', () => {
  const CREATED_AT = new Date('2026-08-27T10:00:00.000Z');
  const ROW = {
    id: 'cm-1',
    ticketId: 'wi-1',
    authorId: 'mem-4',
    bodyHtml: '<p>hi</p>',
    createdAt: CREATED_AT,
  };

  it('gates on the cheap draft check and passes the limit through', async () => {
    vi.mocked(ticketsService.isTicketDraftOrMissing).mockResolvedValue(false);
    vi.mocked(commentsService.listComments).mockResolvedValue([ROW]);

    await nativeProvider.listComments('wi-1', 51);

    expect(ticketsService.isTicketDraftOrMissing).toHaveBeenCalledWith('wi-1');
    // Not getTicket: the full enriched fetch joins labels/assignees/links
    // that this path never uses. Pre-existing behavior, preserved.
    expect(ticketsService.getTicket).not.toHaveBeenCalled();
    expect(commentsService.listComments).toHaveBeenCalledWith('wi-1', 51);
  });

  it('marks the body as html and serializes createdAt exactly as JSON.stringify did', async () => {
    vi.mocked(ticketsService.isTicketDraftOrMissing).mockResolvedValue(false);
    vi.mocked(commentsService.listComments).mockResolvedValue([ROW]);

    const [comment] = await nativeProvider.listComments('wi-1', 51);

    expect(comment).toEqual({
      id: 'cm-1',
      ticketId: 'wi-1',
      authorId: 'mem-4',
      authorName: 'Lena',
      body: '<p>hi</p>',
      bodyFormat: 'html',
      // Date#toJSON is toISOString, so this is the identical string the old
      // pass-the-Date-through implementation emitted.
      createdAt: CREATED_AT.toISOString(),
    });
  });

  it('never reads comments for a draft or missing ticket', async () => {
    vi.mocked(ticketsService.isTicketDraftOrMissing).mockResolvedValue(true);

    expect(await nativeProvider.listComments('wi-draft', 51)).toEqual([]);
    expect(commentsService.listComments).not.toHaveBeenCalled();
  });
});
