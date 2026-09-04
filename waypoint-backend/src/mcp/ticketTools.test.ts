import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks the service layer, the same pattern copilot.routes.test.ts uses for
// a thin adapter over services — these tests verify the MCP tool handlers'
// own logic (which service function they call, with what args, how a result
// is shaped), not tickets.service.ts's own behavior (covered separately in
// tickets.service.test.ts) or the MCP protocol plumbing (covered in
// mcp.routes.test.ts).
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/tickets.service.js');
vi.mock('../services/comments.service.js');
vi.mock('../services/activity.service.js');
vi.mock('../services/states.service.js');
vi.mock('../services/members.service.js');
vi.mock('../lib/actorNames.js');

const ticketsService = await import('../services/tickets.service.js');
const commentsService = await import('../services/comments.service.js');
const activityService = await import('../services/activity.service.js');
const statesService = await import('../services/states.service.js');
const membersService = await import('../services/members.service.js');
const { resolveActorNames } = await import('../lib/actorNames.js');
const { resolveStateNames } = statesService;
const {
  listTicketsHandler,
  getTicketHandler,
  getTicketByIdentifierHandler,
  searchTicketsHandler,
  listCommentsHandler,
  listActivityHandler,
  listStatesHandler,
  listMembersHandler,
} = await import('./ticketTools.js');

// DEFAULT_LIST_LIMIT + 1 — every list-style handler asks the service for one
// row past its effective limit so it can tell a truncated result apart from
// one that just happened to end exactly at the limit (see ticketTools.ts's
// page() helper).
const DEFAULT_LIMIT_PLUS_ONE = 51;

const FULL_ITEM = {
  id: 'wi-1',
  identifier: 'WI-1',
  title: 'Fix login bug',
  projectId: 'proj-1',
  stateId: 'state-1',
  priority: 'high' as const,
  dueDate: '2026-08-27',
  assigneeIds: ['mem-4'],
  labelIds: [],
  links: [],
  isDraft: false,
  description: 'a very long description that should not appear in list results',
};

const DRAFT_ITEM = { ...FULL_ITEM, id: 'wi-draft', identifier: 'WI-99', isDraft: true };

function parseJsonContent(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no names resolvable — individual tests override to assert the
  // resolved-name path. Falls back to the raw id, matching the handlers'
  // own "unresolvable id" behavior.
  vi.mocked(resolveActorNames).mockResolvedValue(new Map());
  vi.mocked(resolveStateNames).mockResolvedValue(new Map());
});

describe('listTicketsHandler', () => {
  it('calls listAllTickets with the given filters (plus the default limit+1) when no projectId is given, and returns a summary projection including dueDate', async () => {
    vi.mocked(ticketsService.listAllTickets).mockResolvedValue([FULL_ITEM]);

    const result = await listTicketsHandler({ priority: 'high' });

    expect(ticketsService.listAllTickets).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'high', limit: DEFAULT_LIMIT_PLUS_ONE }),
    );
    expect(ticketsService.listTickets).not.toHaveBeenCalled();
    const parsed = parseJsonContent(result);
    expect(parsed).toEqual({
      items: [
        {
          id: 'wi-1',
          identifier: 'WI-1',
          title: 'Fix login bug',
          projectId: 'proj-1',
          stateId: 'state-1',
          stateName: 'state-1',
          stateGroup: undefined,
          priority: 'high',
          dueDate: '2026-08-27',
          assigneeIds: ['mem-4'],
          assigneeNames: ['mem-4'],
        },
      ],
      truncated: false,
    });
    expect(parsed.items[0]).not.toHaveProperty('description');
  });

  it('resolves stateId to a real name and group via resolveStateNames, batched across the whole result set', async () => {
    vi.mocked(ticketsService.listAllTickets).mockResolvedValue([FULL_ITEM]);
    vi.mocked(resolveStateNames).mockResolvedValue(new Map([['state-1', { name: 'In Progress', group: 'started' }]]));

    const result = await listTicketsHandler({});

    expect(resolveStateNames).toHaveBeenCalledWith(['state-1']);
    const item = parseJsonContent(result).items[0];
    expect(item.stateName).toBe('In Progress');
    expect(item.stateGroup).toBe('started');
  });

  it('calls listTickets(projectId, filters) when a projectId is given', async () => {
    vi.mocked(ticketsService.listTickets).mockResolvedValue([FULL_ITEM]);

    await listTicketsHandler({ projectId: 'proj-1', assigneeId: 'mem-4', stateId: 'st-1', dueBefore: '2026-09-01' });

    expect(ticketsService.listTickets).toHaveBeenCalledWith('proj-1', {
      assigneeId: 'mem-4',
      stateId: 'st-1',
      priority: undefined,
      dueBefore: '2026-09-01',
      limit: DEFAULT_LIMIT_PLUS_ONE,
    });
    expect(ticketsService.listAllTickets).not.toHaveBeenCalled();
  });

  it('resolves assigneeIds to real names via resolveActorNames, batched across the whole result set', async () => {
    vi.mocked(ticketsService.listAllTickets).mockResolvedValue([FULL_ITEM]);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-4', 'Lena']]));

    const result = await listTicketsHandler({});

    expect(resolveActorNames).toHaveBeenCalledWith(['mem-4']);
    expect(parseJsonContent(result).items[0].assigneeNames).toEqual(['Lena']);
  });

  it('passes a caller-given limit (plus one) through to the service, capped at the max', async () => {
    vi.mocked(ticketsService.listAllTickets).mockResolvedValue([]);

    await listTicketsHandler({ limit: 10 });
    expect(ticketsService.listAllTickets).toHaveBeenCalledWith(expect.objectContaining({ limit: 11 }));

    vi.mocked(ticketsService.listAllTickets).mockClear();
    await listTicketsHandler({ limit: 10_000 });
    expect(ticketsService.listAllTickets).toHaveBeenCalledWith(expect.objectContaining({ limit: 201 }));
  });

  it('marks the result truncated and slices back to the effective limit when the service returns one extra row', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ ...FULL_ITEM, id: `wi-${i}`, identifier: `WI-${i}` }));
    vi.mocked(ticketsService.listAllTickets).mockResolvedValue(items);

    const result = await listTicketsHandler({ limit: 2 });

    const parsed = parseJsonContent(result);
    expect(parsed.truncated).toBe(true);
    expect(parsed.items).toHaveLength(2);
  });

  it('marks the result not truncated when the service returns exactly the effective limit (not one more)', async () => {
    const items = Array.from({ length: 2 }, (_, i) => ({ ...FULL_ITEM, id: `wi-${i}`, identifier: `WI-${i}` }));
    vi.mocked(ticketsService.listAllTickets).mockResolvedValue(items);

    const result = await listTicketsHandler({ limit: 2 });

    const parsed = parseJsonContent(result);
    expect(parsed.truncated).toBe(false);
    expect(parsed.items).toHaveLength(2);
  });
});

describe('getTicketHandler', () => {
  it('returns the full record (not a summary) plus resolved assigneeNames and stateName on a hit', async () => {
    vi.mocked(ticketsService.getTicket).mockResolvedValue(FULL_ITEM);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-4', 'Lena']]));
    vi.mocked(resolveStateNames).mockResolvedValue(new Map([['state-1', { name: 'In Progress', group: 'started' }]]));

    const result = await getTicketHandler({ id: 'wi-1' });

    expect(ticketsService.getTicket).toHaveBeenCalledWith('wi-1');
    expect(resolveStateNames).toHaveBeenCalledWith(['state-1']);
    expect(parseJsonContent(result)).toEqual({
      ...FULL_ITEM,
      assigneeNames: ['Lena'],
      stateName: 'In Progress',
      stateGroup: 'started',
    });
  });

  it('returns an MCP error result, not a thrown exception, on a miss', async () => {
    vi.mocked(ticketsService.getTicket).mockResolvedValue(undefined);

    const result = await getTicketHandler({ id: 'missing' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  // Regression test: get_ticket had no isDraft filter while
  // list/search do, so a draft ticket (including its full description) was
  // fully retrievable by id despite being invisible to every listing tool.
  it('treats a draft item as not found, even though the service returned it', async () => {
    vi.mocked(ticketsService.getTicket).mockResolvedValue(DRAFT_ITEM);

    const result = await getTicketHandler({ id: 'wi-draft' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});

describe('getTicketByIdentifierHandler', () => {
  it('looks up by identifier and returns the full record plus assigneeNames and stateName on a hit', async () => {
    vi.mocked(ticketsService.getTicketByIdentifier).mockResolvedValue(FULL_ITEM);

    const result = await getTicketByIdentifierHandler({ identifier: 'WI-1' });

    expect(ticketsService.getTicketByIdentifier).toHaveBeenCalledWith('WI-1');
    // No name/state resolved in this test (default empty maps from the top
    // beforeEach) — both fall back to their raw id, matching the handlers'
    // own "unresolvable" behavior.
    expect(parseJsonContent(result)).toEqual({ ...FULL_ITEM, assigneeNames: ['mem-4'], stateName: 'state-1' });
  });

  it('returns an MCP error result on a miss', async () => {
    vi.mocked(ticketsService.getTicketByIdentifier).mockResolvedValue(undefined);

    const result = await getTicketByIdentifierHandler({ identifier: 'WI-999' });

    expect(result.isError).toBe(true);
  });

  // Same regression as getTicketHandler above, via the identifier lookup
  // path — identifiers are sequential/guessable (WI-42, WI-43, ...), which
  // is exactly what makes this reachable in practice.
  it('treats a draft item as not found via identifier lookup too', async () => {
    vi.mocked(ticketsService.getTicketByIdentifier).mockResolvedValue(DRAFT_ITEM);

    const result = await getTicketByIdentifierHandler({ identifier: 'WI-99' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});

describe('searchTicketsHandler', () => {
  it('calls searchTickets with the query, optional projectId, and default limit+1, returns a summary projection', async () => {
    vi.mocked(ticketsService.searchTickets).mockResolvedValue([FULL_ITEM]);

    const result = await searchTicketsHandler({ query: 'login', projectId: 'proj-1' });

    expect(ticketsService.searchTickets).toHaveBeenCalledWith('login', 'proj-1', DEFAULT_LIMIT_PLUS_ONE);
    const parsed = parseJsonContent(result);
    expect(parsed.truncated).toBe(false);
    expect(parsed.items[0]).not.toHaveProperty('description');
    expect(parsed.items[0]).toHaveProperty('dueDate');
  });

  it('marks the result truncated when the service returns one extra row past the effective limit', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ ...FULL_ITEM, id: `wi-${i}`, identifier: `WI-${i}` }));
    vi.mocked(ticketsService.searchTickets).mockResolvedValue(items);

    const result = await searchTicketsHandler({ query: 'login', limit: 2 });

    const parsed = parseJsonContent(result);
    expect(parsed.truncated).toBe(true);
    expect(parsed.items).toHaveLength(2);
  });
});

describe('listCommentsHandler', () => {
  // list_comments/list_activity check the ticket's draft/existence status
  // first now (see MAJOR 1 regression tests below) — default every test here
  // to a real, non-draft item so existing tests exercising the
  // comment-listing logic don't have to know about that check; the
  // draft/missing tests below override it. isTicketDraftOrMissing() (a
  // cheap isDraft-only check), not getTicket() (the full enriched fetch
  // with label/assignee/link joins), is what these handlers actually call —
  // see MINOR 4's fix in tickets.service.ts.
  beforeEach(() => {
    vi.mocked(ticketsService.isTicketDraftOrMissing).mockResolvedValue(false);
  });

  it('calls commentsService.listComments with the default limit+1 and attaches each comment\'s resolved authorName', async () => {
    const comments = [{ id: 'cm-1', ticketId: 'wi-1', authorId: 'mem-4', bodyHtml: '<p>hi</p>' }];
    vi.mocked(commentsService.listComments).mockResolvedValue(comments);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-4', 'Lena']]));

    const result = await listCommentsHandler({ ticketId: 'wi-1' });

    expect(ticketsService.isTicketDraftOrMissing).toHaveBeenCalledWith('wi-1');
    expect(ticketsService.getTicket).not.toHaveBeenCalled();
    expect(commentsService.listComments).toHaveBeenCalledWith('wi-1', DEFAULT_LIMIT_PLUS_ONE);
    expect(resolveActorNames).toHaveBeenCalledWith(['mem-4']);
    expect(parseJsonContent(result)).toEqual({ items: [{ ...comments[0], authorName: 'Lena' }], truncated: false });
  });

  it('falls back to the raw authorId when the name cannot be resolved', async () => {
    const comments = [{ id: 'cm-1', ticketId: 'wi-1', authorId: 'mem-ghost', bodyHtml: '<p>hi</p>' }];
    vi.mocked(commentsService.listComments).mockResolvedValue(comments);

    const result = await listCommentsHandler({ ticketId: 'wi-1' });

    expect(parseJsonContent(result).items[0].authorName).toBe('mem-ghost');
  });

  it('passes a caller-given limit (plus one) through and marks truncated when exceeded', async () => {
    const comments = Array.from({ length: 3 }, (_, i) => ({
      id: `cm-${i}`,
      ticketId: 'wi-1',
      authorId: 'mem-4',
      bodyHtml: '<p>hi</p>',
    }));
    vi.mocked(commentsService.listComments).mockResolvedValue(comments);

    const result = await listCommentsHandler({ ticketId: 'wi-1', limit: 2 });

    expect(commentsService.listComments).toHaveBeenCalledWith('wi-1', 3);
    const parsed = parseJsonContent(result);
    expect(parsed.truncated).toBe(true);
    expect(parsed.items).toHaveLength(2);
  });

  // MAJOR regression test: a draft's comments (and its unconditional
  // "created the ticket" activity entry — see listActivityHandler below)
  // were fully retrievable via the draft's own internal id even though the
  // draft itself is correctly hidden from every get/list/search tool.
  it('treats a draft item as not found and never calls commentsService, even though the ticket exists', async () => {
    vi.mocked(ticketsService.isTicketDraftOrMissing).mockResolvedValue(true);

    const result = await listCommentsHandler({ ticketId: 'wi-draft' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
    expect(commentsService.listComments).not.toHaveBeenCalled();
  });

  it('treats a missing ticket as not found and never calls commentsService', async () => {
    vi.mocked(ticketsService.isTicketDraftOrMissing).mockResolvedValue(true);

    const result = await listCommentsHandler({ ticketId: 'missing' });

    expect(result.isError).toBe(true);
    expect(commentsService.listComments).not.toHaveBeenCalled();
  });
});

describe('listActivityHandler', () => {
  beforeEach(() => {
    vi.mocked(ticketsService.isTicketDraftOrMissing).mockResolvedValue(false);
  });

  it('calls activityService.listActivity with the default limit+1 and attaches each entry\'s resolved actorName', async () => {
    const activity = [{ id: 'act-1', ticketId: 'wi-1', actorId: 'mem-4', verb: 'created', detail: 'created the ticket' }];
    vi.mocked(activityService.listActivity).mockResolvedValue(activity);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-4', 'Lena']]));

    const result = await listActivityHandler({ ticketId: 'wi-1' });

    expect(ticketsService.isTicketDraftOrMissing).toHaveBeenCalledWith('wi-1');
    expect(ticketsService.getTicket).not.toHaveBeenCalled();
    expect(activityService.listActivity).toHaveBeenCalledWith('wi-1', DEFAULT_LIMIT_PLUS_ONE);
    expect(parseJsonContent(result)).toEqual({ items: [{ ...activity[0], actorName: 'Lena' }], truncated: false });
  });

  it('marks the result truncated when the service returns one extra row past the effective limit', async () => {
    const activity = Array.from({ length: 3 }, (_, i) => ({
      id: `act-${i}`,
      ticketId: 'wi-1',
      actorId: 'mem-4',
      verb: 'created',
      detail: 'created the ticket',
    }));
    vi.mocked(activityService.listActivity).mockResolvedValue(activity);

    const result = await listActivityHandler({ ticketId: 'wi-1', limit: 2 });

    const parsed = parseJsonContent(result);
    expect(parsed.truncated).toBe(true);
    expect(parsed.items).toHaveLength(2);
  });

  // Same MAJOR regression as listCommentsHandler above — a draft's activity
  // history (including the unconditional "created the ticket" entry
  // every ticket gets, see tickets.service.ts's createTicket) was
  // fully retrievable via the draft's own internal id.
  it('treats a draft item as not found and never calls activityService, even though the ticket exists', async () => {
    vi.mocked(ticketsService.isTicketDraftOrMissing).mockResolvedValue(true);

    const result = await listActivityHandler({ ticketId: 'wi-draft' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
    expect(activityService.listActivity).not.toHaveBeenCalled();
  });

  it('treats a missing ticket as not found and never calls activityService', async () => {
    vi.mocked(ticketsService.isTicketDraftOrMissing).mockResolvedValue(true);

    const result = await listActivityHandler({ ticketId: 'missing' });

    expect(result.isError).toBe(true);
    expect(activityService.listActivity).not.toHaveBeenCalled();
  });
});

describe('listStatesHandler', () => {
  it('calls statesService.listStates for the given project', async () => {
    const states = [{ id: 'st-1', projectId: 'proj-1', name: 'In Progress', group: 'started' as const, color: '#000', isDefault: false, sortOrder: 0 }];
    vi.mocked(statesService.listStates).mockResolvedValue(states);

    const result = await listStatesHandler({ projectId: 'proj-1' });

    expect(statesService.listStates).toHaveBeenCalledWith('proj-1');
    expect(parseJsonContent(result)).toEqual(states);
  });
});

describe('listMembersHandler', () => {
  it('calls membersService.listMembers and returns a public-safe projection (no email, no auth fields)', async () => {
    vi.mocked(membersService.listMembers).mockResolvedValue([
      {
        id: 'mem-4',
        workspaceId: 'ws-1',
        fullName: 'Lena Ortiz',
        displayName: 'Lena',
        email: 'lena@example.com',
        avatarColor: '#abc',
        role: 'member' as const,
        authMethod: 'email' as const,
      },
    ]);

    const result = await listMembersHandler();

    expect(membersService.listMembers).toHaveBeenCalled();
    const parsed = parseJsonContent(result);
    expect(parsed).toEqual([{ id: 'mem-4', displayName: 'Lena', role: 'member' }]);
    expect(parsed[0]).not.toHaveProperty('email');
  });
});
