import { z } from 'zod';
import { prioritySchema } from './tickets.schema.js';

// Mirrors db/schema/projects.ts's stateGroupEnum values exactly — kept as a
// separate zod literal set (rather than derived from the Drizzle enum,
// which lives in the db layer) because validation/ has no dependency on
// db/schema/ anywhere else in this codebase; tickets.service.ts is the
// place that keeps the two in sync (its query-building uses the same
// literals via the Drizzle-inferred column type).
export const stateGroupSchema = z.enum(['backlog', 'unstarted', 'started', 'completed', 'cancelled']);

// Mirrors db/schema/tickets.ts's ticketSourceEnum (line 24) exactly, same
// reasoning as stateGroupSchema above.
export const ticketSourceSchema = z.enum(['manual', 'request', 'agent', 'import']);

// Absolute ISO date (anything Date.parse() accepts) or a relative day
// token like '-30d' (30 days before now). Only day granularity is
// supported — the architecture doc's own example never asks for more.
const RELATIVE_DAY_TOKEN_RE = /^-\d+d$/;
function isValidFilterDateToken(value: string): boolean {
  return RELATIVE_DAY_TOKEN_RE.test(value) || !Number.isNaN(Date.parse(value));
}
const filterDate = z.string().refine(isValidFilterDateToken, {
  message: "must be an absolute ISO date or a relative token like '-30d'",
});

// The one typed shape for "what tickets match" — shared by the ticket list
// read path (GET /tickets?filter=<base64url>, both the global and
// project-scoped variants) and saved views (saved_views.filters), per
// docs/design/waypoint-revamp-architecture.md §4.6. `v` is versioned from
// day one so a future breaking change to this shape has somewhere to hang
// a migration off of.
export const ticketFilterSchema = z
  .object({
    v: z.literal(1),
    projectIds: z.array(z.string()).optional(),
    stateIds: z.array(z.string()).optional(),
    stateGroups: z.array(stateGroupSchema).optional(),
    priorities: z.array(prioritySchema).optional(),
    // '@me' and '@unassigned' are resolved server-side at query time (see
    // tickets.service.ts's buildAssigneeCondition), so a saved view means
    // "my open tickets" for whoever opens it, and "no assignee" is a real
    // filterable condition rather than a client-side post-filter.
    assigneeIds: z.array(z.string()).optional(),
    labelIds: z.array(z.string()).optional(),
    sprintIds: z.array(z.string()).optional(),
    workstreamIds: z.array(z.string()).optional(),
    sources: z.array(ticketSourceSchema).optional(),
    updatedBefore: filterDate.optional(),
    createdAfter: filterDate.optional(),
    text: z.string().max(200).optional(),
    includeDrafts: z.boolean().optional(),
  })
  .strict();

export type TicketFilterQuery = z.infer<typeof ticketFilterSchema>;
