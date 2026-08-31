import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks the service layer, the same pattern copilot.routes.test.ts uses for
// a thin adapter over services — these tests verify the MCP tool handlers'
// own logic (which service function they call, with what args, how a result
// is shaped), not workItems.service.ts's own behavior (covered separately in
// workItems.service.test.ts) or the MCP protocol plumbing (covered in
// mcp.routes.test.ts).
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/workItems.service.js');
vi.mock('../services/comments.service.js');
vi.mock('../services/activity.service.js');
vi.mock('../services/states.service.js');
vi.mock('../services/members.service.js');
vi.mock('../lib/actorNames.js');

const workItemsService = await import('../services/workItems.service.js');
const commentsService = await import('../services/comments.service.js');
const activityService = await import('../services/activity.service.js');
const statesService = await import('../services/states.service.js');
const membersService = await import('../services/members.service.js');
const { resolveActorNames } = await import('../lib/actorNames.js');
const {
  listWorkItemsHandler,
  getWorkItemHandler,
  getWorkItemByIdentifierHandler,
  searchWorkItemsHandler,
  listCommentsHandler,
  listActivityHandler,
  listStatesHandler,
  listMembersHandler,
} = await import('./workItemTools.js');

// DEFAULT_LIST_LIMIT + 1 — every list-style handler asks the service for one
// row past its effective limit so it can tell a truncated result apart from
// one that just happened to end exactly at the limit (see workItemTools.ts's
// page() helper).
const DEFAULT_LIMIT_PLUS_ONE = 51;

const FULL_ITEM = {
  id: 'wi-1',
  identifier: 'WI-1',
  title: 'Fix login bug',
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
});

describe('listWorkItemsHandler', () => {
  it('calls listAllWorkItems with the given filters (plus the default limit+1) when no projectId is given, and returns a summary projection including dueDate', async () => {
    vi.mocked(workItemsService.listAllWorkItems).mockResolvedValue([FULL_ITEM]);

    const result = await listWorkItemsHandler({ priority: 'high' });

    expect(workItemsService.listAllWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'high', limit: DEFAULT_LIMIT_PLUS_ONE }),
    );
    expect(workItemsService.listWorkItems).not.toHaveBeenCalled();
    const parsed = parseJsonContent(result);
    expect(parsed).toEqual({
      items: [
        {
          id: 'wi-1',
          identifier: 'WI-1',
          title: 'Fix login bug',
          stateId: 'state-1',
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

  it('calls listWorkItems(projectId, filters) when a projectId is given', async () => {
    vi.mocked(workItemsService.listWorkItems).mockResolvedValue([FULL_ITEM]);

    await listWorkItemsHandler({ projectId: 'proj-1', assigneeId: 'mem-4', stateId: 'st-1', dueBefore: '2026-09-01' });

    expect(workItemsService.listWorkItems).toHaveBeenCalledWith('proj-1', {
      assigneeId: 'mem-4',
      stateId: 'st-1',
      priority: undefined,
      dueBefore: '2026-09-01',
      limit: DEFAULT_LIMIT_PLUS_ONE,
    });
    expect(workItemsService.listAllWorkItems).not.toHaveBeenCalled();
  });

  it('resolves assigneeIds to real names via resolveActorNames, batched across the whole result set', async () => {
    vi.mocked(workItemsService.listAllWorkItems).mockResolvedValue([FULL_ITEM]);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-4', 'Lena']]));

    const result = await listWorkItemsHandler({});

    expect(resolveActorNames).toHaveBeenCalledWith(['mem-4']);
    expect(parseJsonContent(result).items[0].assigneeNames).toEqual(['Lena']);
  });

  it('passes a caller-given limit (plus one) through to the service, capped at the max', async () => {
    vi.mocked(workItemsService.listAllWorkItems).mockResolvedValue([]);

    await listWorkItemsHandler({ limit: 10 });
    expect(workItemsService.listAllWorkItems).toHaveBeenCalledWith(expect.objectContaining({ limit: 11 }));

    vi.mocked(workItemsService.listAllWorkItems).mockClear();
    await listWorkItemsHandler({ limit: 10_000 });
    expect(workItemsService.listAllWorkItems).toHaveBeenCalledWith(expect.objectContaining({ limit: 201 }));
  });

  it('marks the result truncated and slices back to the effective limit when the service returns one extra row', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ ...FULL_ITEM, id: `wi-${i}`, identifier: `WI-${i}` }));
    vi.mocked(workItemsService.listAllWorkItems).mockResolvedValue(items);

    const result = await listWorkItemsHandler({ limit: 2 });

    const parsed = parseJsonContent(result);
    expect(parsed.truncated).toBe(true);
    expect(parsed.items).toHaveLength(2);
  });

  it('marks the result not truncated when the service returns exactly the effective limit (not one more)', async () => {
    const items = Array.from({ length: 2 }, (_, i) => ({ ...FULL_ITEM, id: `wi-${i}`, identifier: `WI-${i}` }));
    vi.mocked(workItemsService.listAllWorkItems).mockResolvedValue(items);

    const result = await listWorkItemsHandler({ limit: 2 });

    const parsed = parseJsonContent(result);
    expect(parsed.truncated).toBe(false);
    expect(parsed.items).toHaveLength(2);
  });
});

describe('getWorkItemHandler', () => {
  it('returns the full record (not a summary) plus resolved assigneeNames on a hit', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(FULL_ITEM);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-4', 'Lena']]));

    const result = await getWorkItemHandler({ id: 'wi-1' });

    expect(workItemsService.getWorkItem).toHaveBeenCalledWith('wi-1');
    expect(parseJsonContent(result)).toEqual({ ...FULL_ITEM, assigneeNames: ['Lena'] });
  });

  it('returns an MCP error result, not a thrown exception, on a miss', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(undefined);

    const result = await getWorkItemHandler({ id: 'missing' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  // Regression test: get_work_item had no isDraft filter while
  // list/search do, so a draft ticket (including its full description) was
  // fully retrievable by id despite being invisible to every listing tool.
  it('treats a draft item as not found, even though the service returned it', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(DRAFT_ITEM);

    const result = await getWorkItemHandler({ id: 'wi-draft' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});

describe('getWorkItemByIdentifierHandler', () => {
  it('looks up by identifier and returns the full record plus assigneeNames on a hit', async () => {
    vi.mocked(workItemsService.getWorkItemByIdentifier).mockResolvedValue(FULL_ITEM);

    const result = await getWorkItemByIdentifierHandler({ identifier: 'WI-1' });

    expect(workItemsService.getWorkItemByIdentifier).toHaveBeenCalledWith('WI-1');
    expect(parseJsonContent(result)).toEqual({ ...FULL_ITEM, assigneeNames: ['mem-4'] });
  });

  it('returns an MCP error result on a miss', async () => {
    vi.mocked(workItemsService.getWorkItemByIdentifier).mockResolvedValue(undefined);

    const result = await getWorkItemByIdentifierHandler({ identifier: 'WI-999' });

    expect(result.isError).toBe(true);
  });

  // Same regression as getWorkItemHandler above, via the identifier lookup
  // path — identifiers are sequential/guessable (WI-42, WI-43, ...), which
  // is exactly what makes this reachable in practice.
  it('treats a draft item as not found via identifier lookup too', async () => {
    vi.mocked(workItemsService.getWorkItemByIdentifier).mockResolvedValue(DRAFT_ITEM);

    const result = await getWorkItemByIdentifierHandler({ identifier: 'WI-99' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});

describe('searchWorkItemsHandler', () => {
  it('calls searchWorkItems with the query, optional projectId, and default limit+1, returns a summary projection', async () => {
    vi.mocked(workItemsService.searchWorkItems).mockResolvedValue([FULL_ITEM]);

    const result = await searchWorkItemsHandler({ query: 'login', projectId: 'proj-1' });

    expect(workItemsService.searchWorkItems).toHaveBeenCalledWith('login', 'proj-1', DEFAULT_LIMIT_PLUS_ONE);
    const parsed = parseJsonContent(result);
    expect(parsed.truncated).toBe(false);
    expect(parsed.items[0]).not.toHaveProperty('description');
    expect(parsed.items[0]).toHaveProperty('dueDate');
  });

  it('marks the result truncated when the service returns one extra row past the effective limit', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ ...FULL_ITEM, id: `wi-${i}`, identifier: `WI-${i}` }));
    vi.mocked(workItemsService.searchWorkItems).mockResolvedValue(items);

    const result = await searchWorkItemsHandler({ query: 'login', limit: 2 });

    const parsed = parseJsonContent(result);
    expect(parsed.truncated).toBe(true);
    expect(parsed.items).toHaveLength(2);
  });
});

describe('listCommentsHandler', () => {
  // list_comments/list_activity fetch the work item first now (see MAJOR 1
  // regression tests below) — default every test here to a real, non-draft
  // item so existing tests exercising the comment-listing logic don't have
  // to know about that check; the draft/missing tests below override it.
  beforeEach(() => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(FULL_ITEM);
  });

  it('calls commentsService.listComments with the default limit+1 and attaches each comment\'s resolved authorName', async () => {
    const comments = [{ id: 'cm-1', workItemId: 'wi-1', authorId: 'mem-4', bodyHtml: '<p>hi</p>' }];
    vi.mocked(commentsService.listComments).mockResolvedValue(comments);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-4', 'Lena']]));

    const result = await listCommentsHandler({ workItemId: 'wi-1' });

    expect(workItemsService.getWorkItem).toHaveBeenCalledWith('wi-1');
    expect(commentsService.listComments).toHaveBeenCalledWith('wi-1', DEFAULT_LIMIT_PLUS_ONE);
    expect(resolveActorNames).toHaveBeenCalledWith(['mem-4']);
    expect(parseJsonContent(result)).toEqual({ items: [{ ...comments[0], authorName: 'Lena' }], truncated: false });
  });

  it('falls back to the raw authorId when the name cannot be resolved', async () => {
    const comments = [{ id: 'cm-1', workItemId: 'wi-1', authorId: 'mem-ghost', bodyHtml: '<p>hi</p>' }];
    vi.mocked(commentsService.listComments).mockResolvedValue(comments);

    const result = await listCommentsHandler({ workItemId: 'wi-1' });

    expect(parseJsonContent(result).items[0].authorName).toBe('mem-ghost');
  });

  it('passes a caller-given limit (plus one) through and marks truncated when exceeded', async () => {
    const comments = Array.from({ length: 3 }, (_, i) => ({
      id: `cm-${i}`,
      workItemId: 'wi-1',
      authorId: 'mem-4',
      bodyHtml: '<p>hi</p>',
    }));
    vi.mocked(commentsService.listComments).mockResolvedValue(comments);

    const result = await listCommentsHandler({ workItemId: 'wi-1', limit: 2 });

    expect(commentsService.listComments).toHaveBeenCalledWith('wi-1', 3);
    const parsed = parseJsonContent(result);
    expect(parsed.truncated).toBe(true);
    expect(parsed.items).toHaveLength(2);
  });

  // MAJOR regression test: a draft's comments (and its unconditional
  // "created the work item" activity entry — see listActivityHandler below)
  // were fully retrievable via the draft's own internal id even though the
  // draft itself is correctly hidden from every get/list/search tool.
  it('treats a draft item as not found and never calls commentsService, even though the work item exists', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(DRAFT_ITEM);

    const result = await listCommentsHandler({ workItemId: 'wi-draft' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
    expect(commentsService.listComments).not.toHaveBeenCalled();
  });

  it('treats a missing work item as not found and never calls commentsService', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(undefined);

    const result = await listCommentsHandler({ workItemId: 'missing' });

    expect(result.isError).toBe(true);
    expect(commentsService.listComments).not.toHaveBeenCalled();
  });
});

describe('listActivityHandler', () => {
  beforeEach(() => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(FULL_ITEM);
  });

  it('calls activityService.listActivity with the default limit+1 and attaches each entry\'s resolved actorName', async () => {
    const activity = [{ id: 'act-1', workItemId: 'wi-1', actorId: 'mem-4', verb: 'created', detail: 'created the work item' }];
    vi.mocked(activityService.listActivity).mockResolvedValue(activity);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-4', 'Lena']]));

    const result = await listActivityHandler({ workItemId: 'wi-1' });

    expect(workItemsService.getWorkItem).toHaveBeenCalledWith('wi-1');
    expect(activityService.listActivity).toHaveBeenCalledWith('wi-1', DEFAULT_LIMIT_PLUS_ONE);
    expect(parseJsonContent(result)).toEqual({ items: [{ ...activity[0], actorName: 'Lena' }], truncated: false });
  });

  it('marks the result truncated when the service returns one extra row past the effective limit', async () => {
    const activity = Array.from({ length: 3 }, (_, i) => ({
      id: `act-${i}`,
      workItemId: 'wi-1',
      actorId: 'mem-4',
      verb: 'created',
      detail: 'created the work item',
    }));
    vi.mocked(activityService.listActivity).mockResolvedValue(activity);

    const result = await listActivityHandler({ workItemId: 'wi-1', limit: 2 });

    const parsed = parseJsonContent(result);
    expect(parsed.truncated).toBe(true);
    expect(parsed.items).toHaveLength(2);
  });

  // Same MAJOR regression as listCommentsHandler above — a draft's activity
  // history (including the unconditional "created the work item" entry
  // every work item gets, see workItems.service.ts's createWorkItem) was
  // fully retrievable via the draft's own internal id.
  it('treats a draft item as not found and never calls activityService, even though the work item exists', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(DRAFT_ITEM);

    const result = await listActivityHandler({ workItemId: 'wi-draft' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
    expect(activityService.listActivity).not.toHaveBeenCalled();
  });

  it('treats a missing work item as not found and never calls activityService', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(undefined);

    const result = await listActivityHandler({ workItemId: 'missing' });

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
