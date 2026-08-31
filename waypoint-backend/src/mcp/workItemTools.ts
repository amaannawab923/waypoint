import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as workItemsService from '../services/workItems.service.js';
import * as commentsService from '../services/comments.service.js';
import * as activityService from '../services/activity.service.js';
import * as statesService from '../services/states.service.js';
import * as membersService from '../services/members.service.js';
import { resolveActorNames } from '../lib/actorNames.js';

const PRIORITY = z.enum(['urgent', 'high', 'medium', 'low', 'none']);

// ISO date (YYYY-MM-DD) — enforced at the zod layer so a malformed value
// fails clean validation here instead of reaching Postgres raw (via
// lte(workItems.dueDate, ...) in workItems.service.ts) and leaking a raw DB
// error string back into the chat. The regex alone only checks the SHAPE,
// not that the date is real — "2026-13-99" or "2026-02-31" match it fine —
// so a .refine() below actually parses the string and confirms it
// round-trips: this repo pins zod@^3.24.1 (see package.json), which has no
// z.iso.date() (that's a zod v4 API), so real validation has to be done by
// hand instead of relying on a built-in. `new Date(value + 'T00:00:00Z')`
// against a calendar-invalid date either produces an Invalid Date (rejected
// via the NaN check) or, for JS Date's own overflow semantics, a DIFFERENT
// valid date (e.g. Feb 31 rolling into March) — re-serializing and
// comparing back to the original string catches that case too. Manually
// verified against 2026-13-99, 2026-02-31, 2026-04-31 (April has 30 days),
// 2023-02-29 (not a leap year) — all correctly rejected — and 2026-08-31,
// 2026-12-31, 2024-02-29 (a real leap day) — all correctly accepted.
const ISO_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'must be a real calendar date (YYYY-MM-DD)');

// Every list-style tool (list_work_items, search_work_items, list_comments,
// list_activity) is capped here — an unscoped call can otherwise walk every
// work item / every comment in the app (there's no workspaceId concept, see
// currentUser.ts) and blow the model's context. The cap is applied at the
// service-layer query itself (see the `limit` passed to workItemsService/
// commentsService/activityService below), not sliced off after fetching
// everything — a post-fetch slice would still pay the cost (and the
// context-window risk of ever materializing) the limit exists to avoid.
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const LIMIT_SCHEMA = z
  .number()
  .int()
  .positive()
  .max(MAX_LIST_LIMIT)
  .optional()
  .describe(`Max rows to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}). If the result is truncated, narrow the query (e.g. add a filter) rather than raising this.`);

function resolveLimit(limit: number | undefined): number {
  return Math.min(limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
}

// Fetches one row past the effective limit (via the `limit` arg passed to
// the service call above each use of this) so a genuinely full page can be
// told apart from a truncated one without a separate count query — if more
// than `effectiveLimit` rows came back, there was more to find.
function page<T>(rows: T[], effectiveLimit: number): { items: T[]; truncated: boolean } {
  const truncated = rows.length > effectiveLimit;
  return { items: truncated ? rows.slice(0, effectiveLimit) : rows, truncated };
}

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
async function toSummaries(items: workItemsService.Enriched[]) {
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

// The list/search summary path (toSummaries above) already drops
// `description` entirely — it's not needed at list time and would bloat
// context for every row. The single-item detail path (get_work_item(_by_
// identifier)) legitimately wants the full description, but had no size
// guard at all: one pathologically long ticket could still blow out the
// model's context on a single lookup. A plain length cap with a marker is
// enough here — this is JSON text handed to the model, not markup rendered
// anywhere, so there's no HTML-aware truncation to get right.
const DESCRIPTION_MAX_LENGTH = 20_000;
function truncateDescription<T extends { description?: string | null }>(item: T): T {
  const { description } = item;
  if (typeof description !== 'string' || description.length <= DESCRIPTION_MAX_LENGTH) return item;
  return { ...item, description: `${description.slice(0, DESCRIPTION_MAX_LENGTH)}… (truncated)` };
}

// Ticket titles/descriptions/comments are user-authored, semi-trusted
// content that flows straight into the model's context once a tool result
// below is serialized — a ticket could contain text crafted to look like an
// instruction to the model (prompt injection), or a link designed to
// exfiltrate data the model has seen once the renderer makes it clickable
// (see markdown.ts's SAFE_URL scheme allowlist and lack of image-syntax
// support, both of which already narrow this). This is a known, accepted
// risk given those existing mitigations and the read-only, no-tool-side-
// effects posture of this V1 tool set (see copilotRunner.ts's own comments
// on why write tools don't exist yet) — not something this file attempts to
// further sanitize against, since there's no reliable way to distinguish
// "ticket content that happens to look like an instruction" from prose
// without breaking legitimate ticket content.
function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function notFoundResult(what: string) {
  return { content: [{ type: 'text' as const, text: `${what} not found` }], isError: true };
}

const INTERNAL_ERROR_MESSAGE = 'An internal error occurred while processing this request.';

// Safety net around every registered tool handler below (see
// registerWorkItemTools), not specific to dueBefore/ISO_DATE — any
// service-layer throw (a DB constraint, a timeout, a bug in a future
// change) would otherwise reach the MCP SDK's own error serialization with
// its raw `error.message`, exactly the class of leak ISO_DATE's own
// validation exists to close for one particular case (see errorHandler.ts's
// pgErrorCode()/isServerFaultSqlState() for the REST-side equivalent of
// this concern — raw driver text reaching an untrusted surface). The error
// is still logged server-side via console.error (matching errorHandler.ts's
// own convention for genuinely-unexpected failures) — only what reaches the
// model's context is scrubbed to a generic message.
function withErrorSafetyNet<Args extends Record<string, unknown>>(
  toolName: string,
  handler: (args: Args) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>,
) {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      console.error(`MCP tool "${toolName}" failed:`, error);
      return { content: [{ type: 'text' as const, text: INTERNAL_ERROR_MESSAGE }], isError: true };
    }
  };
}

export async function listWorkItemsHandler({
  projectId,
  assigneeId,
  stateId,
  priority,
  dueBefore,
  limit,
}: {
  projectId?: string;
  assigneeId?: string;
  stateId?: string;
  priority?: z.infer<typeof PRIORITY>;
  dueBefore?: string;
  limit?: number;
}) {
  const effectiveLimit = resolveLimit(limit);
  const filters = { assigneeId, stateId, priority, dueBefore, limit: effectiveLimit + 1 };
  const items = projectId
    ? await workItemsService.listWorkItems(projectId, filters)
    : await workItemsService.listAllWorkItems(filters);
  const { items: pageItems, truncated } = page(items, effectiveLimit);
  return jsonResult({ items: await toSummaries(pageItems), truncated });
}

// Drafts are excluded from listWorkItems/listAllWorkItems/searchWorkItems
// at the service layer (isDraft filter), but getWorkItem(_ByIdentifier)
// have no such filter — they're the REST detail-view fetch, which is
// reached only via a draft's own owner navigating to it directly. Sequential
// identifiers (WI-42, WI-43, ...) are guessable, so without this check a
// draft (including its full description) would otherwise be retrievable
// through this tool despite being invisible to every list/search tool —
// treated as a real miss here, same as get_work_item on an id that doesn't
// exist at all, rather than changing the underlying service functions'
// REST-facing behavior (which other, non-MCP callers may depend on
// including drafts).
export async function getWorkItemHandler({ id }: { id: string }) {
  const item = await workItemsService.getWorkItem(id);
  if (!item || item.isDraft) return notFoundResult('work item');
  return jsonResult(truncateDescription(await withAssigneeNames(item)));
}

export async function getWorkItemByIdentifierHandler({ identifier }: { identifier: string }) {
  const item = await workItemsService.getWorkItemByIdentifier(identifier);
  if (!item || item.isDraft) return notFoundResult('work item');
  return jsonResult(truncateDescription(await withAssigneeNames(item)));
}

export async function searchWorkItemsHandler({
  query,
  projectId,
  limit,
}: {
  query: string;
  projectId?: string;
  limit?: number;
}) {
  const effectiveLimit = resolveLimit(limit);
  const items = await workItemsService.searchWorkItems(query, projectId, effectiveLimit + 1);
  const { items: pageItems, truncated } = page(items, effectiveLimit);
  return jsonResult({ items: await toSummaries(pageItems), truncated });
}

// Same draft-hiding requirement as getWorkItemHandler/getWorkItemByIdentifierHandler
// above, reached a different way: a draft is invisible to every list/search
// tool, but its comments and activity history (including the unconditional
// "created the work item" entry every item gets — see workItems.service.ts's
// createWorkItem) were still fully retrievable via the draft's own internal
// id, since neither of these handlers checked isDraft before fetching. One
// extra query per call is the accepted cost of closing that.
export async function listCommentsHandler({ workItemId, limit }: { workItemId: string; limit?: number }) {
  const workItem = await workItemsService.getWorkItem(workItemId);
  if (!workItem || workItem.isDraft) return notFoundResult('work item');
  const effectiveLimit = resolveLimit(limit);
  const comments = await commentsService.listComments(workItemId, effectiveLimit + 1);
  const { items: pageItems, truncated } = page(comments, effectiveLimit);
  const names = await resolveActorNames(pageItems.map((c) => c.authorId));
  return jsonResult({
    items: pageItems.map((c) => ({ ...c, authorName: names.get(c.authorId) ?? c.authorId })),
    truncated,
  });
}

export async function listActivityHandler({ workItemId, limit }: { workItemId: string; limit?: number }) {
  const workItem = await workItemsService.getWorkItem(workItemId);
  if (!workItem || workItem.isDraft) return notFoundResult('work item');
  const effectiveLimit = resolveLimit(limit);
  const activity = await activityService.listActivity(workItemId, effectiveLimit + 1);
  const { items: pageItems, truncated } = page(activity, effectiveLimit);
  const names = await resolveActorNames(pageItems.map((a) => a.actorId));
  return jsonResult({
    items: pageItems.map((a) => ({ ...a, actorName: names.get(a.actorId) ?? a.actorId })),
    truncated,
  });
}

export async function listStatesHandler({ projectId }: { projectId: string }) {
  return jsonResult(await statesService.listStates(projectId));
}

export async function listMembersHandler() {
  const members = await membersService.listMembers();
  // email is deliberately dropped: this tool exists to resolve an assignee
  // id to a display name, or to find a member's id to filter
  // list_work_items by — neither use needs a member's email address, so it
  // isn't put in front of the model.
  return jsonResult(members.map(({ id, displayName, role }) => ({ id, displayName, role })));
}

export function registerWorkItemTools(server: McpServer): void {
  server.registerTool(
    'list_work_items',
    {
      description:
        'List work items (tickets), optionally scoped to one project and/or filtered by assignee, state, priority, or a due-by date. Returns a summary per item (including dueDate and resolved assignee names), not full detail. Results are capped (see limit) — check the truncated flag and narrow the query if it comes back true.',
      inputSchema: {
        projectId: z.string().optional().describe('If given, only list work items in this project.'),
        assigneeId: z.string().optional().describe('If given, only items with this member/agent id as an assignee.'),
        stateId: z.string().optional().describe('If given, only items in this state — get state ids via list_states.'),
        priority: PRIORITY.optional().describe('If given, only items with this priority.'),
        dueBefore: ISO_DATE.optional().describe(
          "ISO date (YYYY-MM-DD). If given, only items due on or before this date — e.g. pass today's date to find overdue items.",
        ),
        limit: LIMIT_SCHEMA,
      },
    },
    withErrorSafetyNet('list_work_items', listWorkItemsHandler),
  );

  server.registerTool(
    'get_work_item',
    {
      description: 'Get the full details of one work item (ticket) by its internal id.',
      inputSchema: { id: z.string() },
    },
    withErrorSafetyNet('get_work_item', getWorkItemHandler),
  );

  server.registerTool(
    'get_work_item_by_identifier',
    {
      description:
        'Get the full details of one work item (ticket) by its human-readable identifier, e.g. "WI-42".',
      inputSchema: { identifier: z.string() },
    },
    withErrorSafetyNet('get_work_item_by_identifier', getWorkItemByIdentifierHandler),
  );

  server.registerTool(
    'search_work_items',
    {
      description:
        'Search work items (tickets) by a title keyword, optionally scoped to one project. Returns a summary per match. Results are capped (see limit) — check the truncated flag and narrow the query if it comes back true.',
      inputSchema: {
        // .min(1) — an empty query otherwise matches every work item's
        // title (an unscoped `ilike(title, '%%')` in workItems.service.ts),
        // effectively turning "search" into "list everything" by accident.
        query: z.string().min(1),
        projectId: z.string().optional(),
        limit: LIMIT_SCHEMA,
      },
    },
    withErrorSafetyNet('search_work_items', searchWorkItemsHandler),
  );

  server.registerTool(
    'list_comments',
    {
      description:
        'List the comments on one work item (ticket), with each comment\'s author name resolved. Results are capped (see limit) — check the truncated flag and narrow the query if it comes back true.',
      inputSchema: { workItemId: z.string(), limit: LIMIT_SCHEMA },
    },
    withErrorSafetyNet('list_comments', listCommentsHandler),
  );

  server.registerTool(
    'list_activity',
    {
      description:
        'List the activity history (state/assignee/label/etc. changes) on one work item (ticket), with each entry\'s actor name resolved. Results are capped (see limit) — check the truncated flag and narrow the query if it comes back true.',
      inputSchema: { workItemId: z.string(), limit: LIMIT_SCHEMA },
    },
    withErrorSafetyNet('list_activity', listActivityHandler),
  );

  server.registerTool(
    'list_states',
    {
      description:
        'List the workflow states (e.g. Backlog, In Progress, Done) configured for a project, in board order. Use this to resolve a work item\'s stateId to a real name, or to find a stateId to filter list_work_items by.',
      inputSchema: { projectId: z.string() },
    },
    withErrorSafetyNet('list_states', listStatesHandler),
  );

  server.registerTool(
    'list_members',
    {
      description:
        "List the workspace's members (id, display name, role). Use this to resolve an assignee id to a name, or to find a member's id to filter list_work_items by.",
      inputSchema: {},
    },
    withErrorSafetyNet('list_members', listMembersHandler),
  );
}
