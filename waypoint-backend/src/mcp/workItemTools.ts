import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as workItemsService from '../services/workItems.service.js';
import * as commentsService from '../services/comments.service.js';
import * as activityService from '../services/activity.service.js';
import * as statesService from '../services/states.service.js';
import * as membersService from '../services/members.service.js';
import { resolveActorNames } from '../lib/actorNames.js';

const PRIORITY = z.enum(['urgent', 'high', 'medium', 'low', 'none']);

// Work items returned from list/search are projected down to this summary
// shape — an unscoped list_work_items call walks every work item in the
// app (there's no workspaceId concept, see currentUser.ts), and returning
// full `description` HTML for every row would bloat the model's context for
// no benefit at list time. get_work_item(_by_identifier) return the full
// enriched record, since a single-item lookup is exactly where the detail
// is wanted. dueDate is included here (unlike description) specifically
// because "what's overdue" needs it at list time, not just on drill-down.
//
// assigneeIds are resolved to assigneeNames in one batched pair of queries
// across the whole result set (resolveActorNames), not per-item — a raw id
// like "mem-4" is meaningless to a user reading Copilot's answer. Both the
// id and the resolved name are kept: the id is what a follow-up tool call
// (e.g. a future assignee filter) would need, the name is what's fit to
// show. A name that fails to resolve falls back to the raw id rather than
// dropping the assignee or throwing.
type WorkItemSummaryInput = NonNullable<Awaited<ReturnType<typeof workItemsService.listAllWorkItems>>[number]>;

async function toSummaries(items: WorkItemSummaryInput[]) {
  const names = await resolveActorNames(items.flatMap((item) => item.assigneeIds));
  return items.map(({ id, identifier, title, stateId, priority, dueDate, assigneeIds }) => ({
    id,
    identifier,
    title,
    stateId,
    priority,
    dueDate,
    assigneeIds,
    assigneeNames: assigneeIds.map((assigneeId) => names.get(assigneeId) ?? assigneeId),
  }));
}

async function withAssigneeNames<T extends { assigneeIds: string[] }>(item: T) {
  const names = await resolveActorNames(item.assigneeIds);
  return { ...item, assigneeNames: item.assigneeIds.map((assigneeId) => names.get(assigneeId) ?? assigneeId) };
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function notFoundResult(what: string) {
  return { content: [{ type: 'text' as const, text: `${what} not found` }], isError: true };
}

export async function listWorkItemsHandler({
  projectId,
  assigneeId,
  stateId,
  priority,
  dueBefore,
}: {
  projectId?: string;
  assigneeId?: string;
  stateId?: string;
  priority?: z.infer<typeof PRIORITY>;
  dueBefore?: string;
}) {
  const filters = { assigneeId, stateId, priority, dueBefore };
  const items = projectId
    ? await workItemsService.listWorkItems(projectId, filters)
    : await workItemsService.listAllWorkItems(filters);
  return jsonResult(await toSummaries(items));
}

export async function getWorkItemHandler({ id }: { id: string }) {
  const item = await workItemsService.getWorkItem(id);
  return item ? jsonResult(await withAssigneeNames(item)) : notFoundResult('work item');
}

export async function getWorkItemByIdentifierHandler({ identifier }: { identifier: string }) {
  const item = await workItemsService.getWorkItemByIdentifier(identifier);
  return item ? jsonResult(await withAssigneeNames(item)) : notFoundResult('work item');
}

export async function searchWorkItemsHandler({ query, projectId }: { query: string; projectId?: string }) {
  const items = await workItemsService.searchWorkItems(query, projectId);
  return jsonResult(await toSummaries(items));
}

export async function listCommentsHandler({ workItemId }: { workItemId: string }) {
  const comments = await commentsService.listComments(workItemId);
  const names = await resolveActorNames(comments.map((c) => c.authorId));
  return jsonResult(comments.map((c) => ({ ...c, authorName: names.get(c.authorId) ?? c.authorId })));
}

export async function listActivityHandler({ workItemId }: { workItemId: string }) {
  const activity = await activityService.listActivity(workItemId);
  const names = await resolveActorNames(activity.map((a) => a.actorId));
  return jsonResult(activity.map((a) => ({ ...a, actorName: names.get(a.actorId) ?? a.actorId })));
}

export async function listStatesHandler({ projectId }: { projectId: string }) {
  return jsonResult(await statesService.listStates(projectId));
}

export async function listMembersHandler() {
  const members = await membersService.listMembers();
  return jsonResult(members.map(({ id, displayName, email, role }) => ({ id, displayName, email, role })));
}

export function registerWorkItemTools(server: McpServer): void {
  server.registerTool(
    'list_work_items',
    {
      description:
        'List work items (tickets), optionally scoped to one project and/or filtered by assignee, state, priority, or a due-by date. Returns a summary per item (including dueDate and resolved assignee names), not full detail.',
      inputSchema: {
        projectId: z.string().optional().describe('If given, only list work items in this project.'),
        assigneeId: z.string().optional().describe('If given, only items with this member/agent id as an assignee.'),
        stateId: z.string().optional().describe('If given, only items in this state — get state ids via list_states.'),
        priority: PRIORITY.optional().describe('If given, only items with this priority.'),
        dueBefore: z
          .string()
          .optional()
          .describe('ISO date (YYYY-MM-DD). If given, only items due on or before this date — e.g. pass today\'s date to find overdue items.'),
      },
    },
    listWorkItemsHandler,
  );

  server.registerTool(
    'get_work_item',
    {
      description: 'Get the full details of one work item (ticket) by its internal id.',
      inputSchema: { id: z.string() },
    },
    getWorkItemHandler,
  );

  server.registerTool(
    'get_work_item_by_identifier',
    {
      description:
        'Get the full details of one work item (ticket) by its human-readable identifier, e.g. "WI-42".',
      inputSchema: { identifier: z.string() },
    },
    getWorkItemByIdentifierHandler,
  );

  server.registerTool(
    'search_work_items',
    {
      description:
        'Search work items (tickets) by a title keyword, optionally scoped to one project. Returns a summary per match.',
      inputSchema: {
        query: z.string(),
        projectId: z.string().optional(),
      },
    },
    searchWorkItemsHandler,
  );

  server.registerTool(
    'list_comments',
    {
      description: 'List the comments on one work item (ticket), with each comment\'s author name resolved.',
      inputSchema: { workItemId: z.string() },
    },
    listCommentsHandler,
  );

  server.registerTool(
    'list_activity',
    {
      description:
        'List the activity history (state/assignee/label/etc. changes) on one work item (ticket), with each entry\'s actor name resolved.',
      inputSchema: { workItemId: z.string() },
    },
    listActivityHandler,
  );

  server.registerTool(
    'list_states',
    {
      description:
        'List the workflow states (e.g. Backlog, In Progress, Done) configured for a project, in board order. Use this to resolve a work item\'s stateId to a real name, or to find a stateId to filter list_work_items by.',
      inputSchema: { projectId: z.string() },
    },
    listStatesHandler,
  );

  server.registerTool(
    'list_members',
    {
      description:
        'List the workspace\'s members (id, display name, email, role). Use this to resolve an assignee id to a name, or to find a member\'s id to filter list_work_items by.',
      inputSchema: {},
    },
    listMembersHandler,
  );
}
