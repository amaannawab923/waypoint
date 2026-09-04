import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as sprintsService from '../services/sprints.service.js';
import * as ticketsService from '../services/tickets.service.js';
import * as statesService from '../services/states.service.js';
import { resolveActorNames } from '../lib/actorNames.js';
import { jsonResult, notFoundResult, withErrorSafetyNet } from './ticketTools.js';

// Sprints had no MCP read tool at all before this file, which is why
// Copilot would confidently claim "this workspace doesn't use a sprint/
// cycle concept" when asked about a real sprint — it had no way to check,
// so it guessed, and guessed wrong. This mirrors ticketTools.ts's own
// list/get pattern (list_states, get_ticket) so Copilot can answer
// truthfully instead.

// A sprint row on its own (name, start/endDate) doesn't say anything about
// how it's going — the exact question the bug report's example ("what's
// the current state of Sprint 12") is actually asking. done/ticketCount are
// computed the same way waypoint-frontend/src/renderer/pages/Home.tsx's
// findActiveSprint already does for the Home "active sprint" card: fetch
// the sprint's tickets via the typed filter query (sprintIds is only
// supported there, not by ticketsService.TicketFilters/list_tickets' own
// simpler filter set — see that file's withFilters), then count how many
// sit in a "completed"-group state. Kept local to this file rather than
// extracted to a shared helper: the two call sites (Home.tsx, here) are on
// opposite sides of the frontend/backend boundary and can't share code.
async function toSprintSummary(sprint: Awaited<ReturnType<typeof sprintsService.listAllSprints>>[number]) {
  const [tickets, leadNames] = await Promise.all([
    ticketsService.listTicketsByFilter({ sprintIds: [sprint.id] }),
    resolveActorNames(sprint.leadId ? [sprint.leadId] : []),
  ]);
  const stateNames = await statesService.resolveStateNames(tickets.map((t) => t.stateId));
  const doneCount = tickets.filter((t) => stateNames.get(t.stateId)?.group === 'completed').length;
  return {
    id: sprint.id,
    name: sprint.name,
    description: sprint.description,
    projectId: sprint.projectId,
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    leadId: sprint.leadId,
    leadName: sprint.leadId ? (leadNames.get(sprint.leadId) ?? sprint.leadId) : null,
    memberIds: sprint.memberIds,
    ticketCount: tickets.length,
    doneCount,
  };
}

export async function listSprintsHandler({ projectId }: { projectId?: string }) {
  const rows = projectId ? await sprintsService.listSprints(projectId) : await sprintsService.listAllSprints();
  return jsonResult(await Promise.all(rows.map(toSprintSummary)));
}

export async function getSprintHandler({ id }: { id: string }) {
  const sprint = await sprintsService.getSprint(id);
  if (!sprint) return notFoundResult('sprint');
  return jsonResult(await toSprintSummary(sprint));
}

export function registerSprintTools(server: McpServer): void {
  server.registerTool(
    'list_sprints',
    {
      description:
        'List sprints (a.k.a. cycles), optionally scoped to one project. Returns each sprint\'s name, date range, lead, and a ticketCount/doneCount progress summary. Use this before answering any question that names a specific sprint (e.g. "Sprint 12") — do not assume sprints are unsupported without checking here first.',
      inputSchema: {
        projectId: z.string().optional().describe('If given, only list sprints in this project.'),
      },
    },
    withErrorSafetyNet('list_sprints', listSprintsHandler),
  );

  server.registerTool(
    'get_sprint',
    {
      description: 'Get one sprint by its internal id, with the same progress summary as list_sprints.',
      inputSchema: { id: z.string() },
    },
    withErrorSafetyNet('get_sprint', getSprintHandler),
  );
}
