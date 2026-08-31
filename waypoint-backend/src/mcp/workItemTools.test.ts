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
  description: 'a very long description that should not appear in list results',
};

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
  it('calls listAllWorkItems with the given filters when no projectId is given, and returns a summary projection including dueDate', async () => {
    vi.mocked(workItemsService.listAllWorkItems).mockResolvedValue([FULL_ITEM]);

    const result = await listWorkItemsHandler({ priority: 'high' });

    expect(workItemsService.listAllWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'high' }),
    );
    expect(workItemsService.listWorkItems).not.toHaveBeenCalled();
    const parsed = parseJsonContent(result);
    expect(parsed).toEqual([
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
    ]);
    expect(parsed[0]).not.toHaveProperty('description');
  });

  it('calls listWorkItems(projectId, filters) when a projectId is given', async () => {
    vi.mocked(workItemsService.listWorkItems).mockResolvedValue([FULL_ITEM]);

    await listWorkItemsHandler({ projectId: 'proj-1', assigneeId: 'mem-4', stateId: 'st-1', dueBefore: '2026-09-01' });

    expect(workItemsService.listWorkItems).toHaveBeenCalledWith('proj-1', {
      assigneeId: 'mem-4',
      stateId: 'st-1',
      priority: undefined,
      dueBefore: '2026-09-01',
    });
    expect(workItemsService.listAllWorkItems).not.toHaveBeenCalled();
  });

  it('resolves assigneeIds to real names via resolveActorNames, batched across the whole result set', async () => {
    vi.mocked(workItemsService.listAllWorkItems).mockResolvedValue([FULL_ITEM]);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-4', 'Lena']]));

    const result = await listWorkItemsHandler({});

    expect(resolveActorNames).toHaveBeenCalledWith(['mem-4']);
    expect(parseJsonContent(result)[0].assigneeNames).toEqual(['Lena']);
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
});

describe('searchWorkItemsHandler', () => {
  it('calls searchWorkItems with the query and optional projectId, returns a summary projection', async () => {
    vi.mocked(workItemsService.searchWorkItems).mockResolvedValue([FULL_ITEM]);

    const result = await searchWorkItemsHandler({ query: 'login', projectId: 'proj-1' });

    expect(workItemsService.searchWorkItems).toHaveBeenCalledWith('login', 'proj-1');
    const parsed = parseJsonContent(result);
    expect(parsed[0]).not.toHaveProperty('description');
    expect(parsed[0]).toHaveProperty('dueDate');
  });
});

describe('listCommentsHandler', () => {
  it('calls commentsService.listComments and attaches each comment\'s resolved authorName', async () => {
    const comments = [{ id: 'cm-1', workItemId: 'wi-1', authorId: 'mem-4', bodyHtml: '<p>hi</p>' }];
    vi.mocked(commentsService.listComments).mockResolvedValue(comments);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-4', 'Lena']]));

    const result = await listCommentsHandler({ workItemId: 'wi-1' });

    expect(commentsService.listComments).toHaveBeenCalledWith('wi-1');
    expect(resolveActorNames).toHaveBeenCalledWith(['mem-4']);
    expect(parseJsonContent(result)).toEqual([{ ...comments[0], authorName: 'Lena' }]);
  });

  it('falls back to the raw authorId when the name cannot be resolved', async () => {
    const comments = [{ id: 'cm-1', workItemId: 'wi-1', authorId: 'mem-ghost', bodyHtml: '<p>hi</p>' }];
    vi.mocked(commentsService.listComments).mockResolvedValue(comments);

    const result = await listCommentsHandler({ workItemId: 'wi-1' });

    expect(parseJsonContent(result)[0].authorName).toBe('mem-ghost');
  });
});

describe('listActivityHandler', () => {
  it('calls activityService.listActivity and attaches each entry\'s resolved actorName', async () => {
    const activity = [{ id: 'act-1', workItemId: 'wi-1', actorId: 'mem-4', verb: 'created', detail: 'created the work item' }];
    vi.mocked(activityService.listActivity).mockResolvedValue(activity);
    vi.mocked(resolveActorNames).mockResolvedValue(new Map([['mem-4', 'Lena']]));

    const result = await listActivityHandler({ workItemId: 'wi-1' });

    expect(activityService.listActivity).toHaveBeenCalledWith('wi-1');
    expect(parseJsonContent(result)).toEqual([{ ...activity[0], actorName: 'Lena' }]);
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
  it('calls membersService.listMembers and returns a public-safe projection (no auth fields)', async () => {
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
    expect(parseJsonContent(result)).toEqual([
      { id: 'mem-4', displayName: 'Lena', email: 'lena@example.com', role: 'member' },
    ]);
  });
});
