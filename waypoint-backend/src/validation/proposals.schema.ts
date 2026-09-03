import { z } from 'zod';

// .strict() empty objects, matching createCopilotConversationSchema's
// convention: approve/reject genuinely take nothing (the proposal row
// already holds everything — payload, snapshot, target), so a stray body
// field is a caller bug worth a 400, not something to silently ignore.
export const approveProposalSchema = z.object({}).strict();
export const rejectProposalSchema = z.object({}).strict();
export const rejectAllProposalsSchema = z.object({}).strict();

// Bounded ids array: the renderer only ever marks the handful of proposals
// whose outcomes it just delivered in one preamble, so 100 is generous —
// an unbounded array here would let one request update arbitrarily many
// rows in a single statement.
export const markProposalsNotifiedSchema = z.object({
  ids: z.array(z.string()).min(1).max(100),
});

// ---------------------------------------------------------------------------
// Review queue (W3.2, architecture §4.4) — the workspace-scoped aggregate
// surface's request validation.
// ---------------------------------------------------------------------------

const proposalKindQuerySchema = z.enum([
  'comment',
  'state_change',
  'assignee_change',
  'priority_change',
  'create_ticket',
  'add_label',
]);

const proposalStatusQuerySchema = z.enum([
  'proposed',
  'executing',
  'executed',
  'rejected',
  'stale',
  'expired',
  'superseded',
  'reverted',
]);

export const listReviewQueueQuerySchema = z
  .object({
    status: z.enum(['proposed', 'blocked', 'recent']),
    agentId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    kind: proposalKindQuerySchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

// Cap at 50 (architecture §4.4): "Cap the batch at 50 ids (reject the whole
// request with a 400 above that, don't silently truncate)" — zod's .max(50)
// is exactly that: an over-cap array fails validation before the route
// handler (and the service loop underneath it) ever sees the request.
export const bulkProposalIdsSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(50),
  })
  .strict();

export const ticketProposalsQuerySchema = z
  .object({
    status: proposalStatusQuerySchema.optional(),
  })
  .strict();
