import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as sprintsService from '../services/sprints.service.js';
import * as ticketsService from '../services/tickets.service.js';
import type { SprintTicketCounts } from '../services/tickets.service.js';
import { resolveActorNames } from '../lib/actorNames.js';
import {
  jsonResult,
  notFoundResult,
  withErrorSafetyNet,
  LIMIT_SCHEMA,
  resolveLimit,
  page,
} from './ticketTools.js';

// Sprints had no MCP read tool at all before this file, which is why
// Copilot would confidently claim "this workspace doesn't use a sprint/
// cycle concept" when asked about a real sprint — it had no way to check,
// so it guessed, and guessed wrong. This mirrors ticketTools.ts's own
// list/get pattern (list_states, get_ticket) so Copilot can answer
// truthfully instead.

// A sprint row on its own (name, start/endDate) doesn't say anything about
// how it's going — the exact question the bug report's example ("what's
// the current state of Sprint 12") is actually asking. done/ticketCount used
// to be computed the same way waypoint-frontend/src/renderer/pages/Home.tsx's
// findActiveSprint does for the Home "active sprint" card: fetch the
// sprint's tickets via the typed filter query, then count how many sit in a
// "completed"-group state. That's still true for Home.tsx (a single sprint,
// already materializing tickets for other reasons), but this file summarizes
// every sprint in a workspace at once — walking every ticket in every sprint
// just to run `.length` on the result doesn't scale, so here the two counts
// come from a real COUNT(*) instead (ticketsService.countTicketsBySprintIds).
// LLM date arithmetic is unreliable (no live clock, easy off-by-one/off-by-
// timezone errors) — a real repro: Copilot told a user "6 days remaining"
// for a sprint the Home dashboard correctly showed 8 days left for, on the
// same day. Rather than handing the model raw start/endDate and trusting
// it to subtract "today" itself, compute the answer server-side — the
// exact same formula Home.tsx's findActiveSprint already uses — and hand
// the model an already-correct number to just repeat.
function daysLeft(endDate: string, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((new Date(endDate).getTime() - now.getTime()) / 86_400_000));
}

// ticketCounts/leadNames are resolved ONCE, batched across every sprint in
// the page being summarized (see listSprintsHandler/getSprintHandler below)
// — not per sprint — so this function itself does no I/O and needs no
// Promise/await. A sprint missing from ticketCounts (zero matching tickets)
// reads as 0/0, which is correct: "no tickets" and "not summarized" look the
// same from here.
function toSprintSummary(
  sprint: Awaited<ReturnType<typeof sprintsService.listAllSprints>>[number],
  ticketCounts: Map<string, SprintTicketCounts>,
  leadNames: Map<string, string>,
) {
  const counts = ticketCounts.get(sprint.id) ?? { total: 0, done: 0 };
  return {
    id: sprint.id,
    name: sprint.name,
    description: sprint.description,
    projectId: sprint.projectId,
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    // Pre-computed so the model never has to do its own "today minus
    // endDate" arithmetic — see the daysLeft() comment above.
    daysLeft: daysLeft(sprint.endDate),
    leadId: sprint.leadId,
    leadName: sprint.leadId ? (leadNames.get(sprint.leadId) ?? sprint.leadId) : null,
    memberIds: sprint.memberIds,
    ticketCount: counts.total,
    doneCount: counts.done,
  };
}

export async function listSprintsHandler({ projectId, limit }: { projectId?: string; limit?: number }) {
  const effectiveLimit = resolveLimit(limit);
  const fetchLimit = effectiveLimit + 1;
  const rows = projectId
    ? await sprintsService.listSprints(projectId, fetchLimit)
    : await sprintsService.listAllSprints(fetchLimit);
  const { items: pageItems, truncated } = page(rows, effectiveLimit);

  const [ticketCounts, leadNames] = await Promise.all([
    ticketsService.countTicketsBySprintIds(pageItems.map((s) => s.id)),
    resolveActorNames(pageItems.flatMap((s) => (s.leadId ? [s.leadId] : []))),
  ]);
  return jsonResult({
    items: pageItems.map((sprint) => toSprintSummary(sprint, ticketCounts, leadNames)),
    truncated,
  });
}

export async function getSprintHandler({ id }: { id: string }) {
  const sprint = await sprintsService.getSprint(id);
  if (!sprint) return notFoundResult('sprint');
  const [ticketCounts, leadNames] = await Promise.all([
    ticketsService.countTicketsBySprintIds([sprint.id]),
    resolveActorNames(sprint.leadId ? [sprint.leadId] : []),
  ]);
  return jsonResult(toSprintSummary(sprint, ticketCounts, leadNames));
}

export function registerSprintTools(server: McpServer): void {
  server.registerTool(
    'list_sprints',
    {
      description:
        'List sprints (a.k.a. cycles), optionally scoped to one project. Returns each sprint\'s name, date range, lead, and a ticketCount/doneCount progress summary. Use this before answering any question that names a specific sprint (e.g. "Sprint 12") — do not assume sprints are unsupported without checking here first. When reporting how much time is left on a sprint, always use the returned `daysLeft` number as-is — never compute it yourself from startDate/endDate, since you do not reliably know today\'s date. Results are capped (see limit) — check the truncated flag and narrow the query (e.g. add projectId) if it comes back true.',
      inputSchema: {
        projectId: z.string().optional().describe('If given, only list sprints in this project.'),
        limit: LIMIT_SCHEMA,
      },
    },
    withErrorSafetyNet('list_sprints', listSprintsHandler),
  );

  server.registerTool(
    'get_sprint',
    {
      description:
        'Get one sprint by its internal id, with the same progress summary as list_sprints. When reporting how much time is left, always use the returned `daysLeft` number as-is — never compute it yourself.',
      inputSchema: { id: z.string() },
    },
    withErrorSafetyNet('get_sprint', getSprintHandler),
  );
}
