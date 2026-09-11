import { z } from 'zod';
import { AGENT_RUN_STATUSES } from '../services/runStatusMachine.js';
import { boundedJson, requireAtLeastOneField } from './shared.js';

// Request shapes for the agent-runs ledger — ROAD-54. `.strict()`
// throughout, matching proposals.schema.ts: a stray field on a ledger
// write is a caller bug worth a 400, not something to silently drop.

const runStatusSchema = z.enum(AGENT_RUN_STATUSES);
const id = z.string().min(1).max(128);
// Same bound the review queue uses; the panel pages, it never wants 1000.
const MAX_PAGE = 100;

export const createAgentRunSchema = z
  .object({
    projectId: id,
    ticketId: id.nullable().optional(),
    ownerMemberId: id,
    agentId: id.nullable().optional(),
    entry: z.enum(['independent', 'dispatched']),
    providerId: z.string().min(1).max(64),
    baseRef: z.string().min(1).max(256).optional(),
    retryOfRunId: id.optional(),
  })
  .strict();
export type CreateAgentRunInput = z.infer<typeof createAgentRunSchema>;

// `status` arrives as `?status=running,blocked` — one query param, split
// here, each part checked against the enum so a typo is a 400 rather than
// an empty list that looks like "no runs".
const statusList = z
  .string()
  .min(1)
  .transform((raw) => raw.split(',').map((s) => s.trim()))
  .pipe(z.array(runStatusSchema).min(1).max(AGENT_RUN_STATUSES.length));

export const listAgentRunsQuerySchema = z
  .object({
    projectId: id.optional(),
    ownerMemberId: id.optional(),
    ticketId: id.optional(),
    status: statusList.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type ListAgentRunsQuery = z.infer<typeof listAgentRunsQuerySchema>;

export const listAgentRunEventsQuerySchema = z
  .object({
    afterSeq: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

// The kinds a client may append. `created` and `status_changed` are
// deliberately absent: the service writes those itself, inside the same
// transaction as the row change they describe, and a client writing them
// directly could make the trail say something the ledger does not.
export const CLIENT_EVENT_KINDS = [
  'worktree_created',
  'worktree_removed',
  'session_started',
  'session_resumed',
  'session_ended',
  'prompt_sent',
  'turn_completed',
  'permission_requested',
  'permission_answered',
  'proposal_created',
  'pushed',
  'pr_opened',
  'error',
  'note',
] as const;

export const appendAgentRunEventSchema = z
  .object({
    kind: z.enum(CLIENT_EVENT_KINDS),
    // Bounded like SavedView.filters — the one other arbitrary-JSON field —
    // plus a byte cap: an event is a line in an audit log, not a transcript.
    payload: boundedJson(z.record(z.string(), z.unknown()))
      .refine((v) => JSON.stringify(v).length <= 16_384, {
        message: 'payload exceeds 16 KiB',
      })
      .optional(),
  })
  .strict();
export type AppendAgentRunEventInput = z.infer<typeof appendAgentRunEventSchema>;

// Everything a run's owner-side process may write back as it learns things:
// the daemon's handles once provisioning has them, the branch and PR, the
// outcome, the counters — and `status`, whose legality runStatusMachine.ts
// decides, not this schema. `reason` rides along into the status_changed
// event's payload ("user clicked Stop", "daemon session vanished at boot")
// and is not a column.
export const updateAgentRunSchema = requireAtLeastOneField(
  z
    .object({
      status: runStatusSchema.optional(),
      reason: z.string().max(2000).optional(),
      blockedReason: z.string().max(2000).nullable().optional(),
      errorKind: z.string().max(64).nullable().optional(),
      errorMessage: z.string().max(4000).nullable().optional(),
      // Bounded for memory only; the service keeps the first 20,000
      // characters with a marker rather than refusing a long final message.
      summary: z.string().max(200_000).nullable().optional(),
      daemonWorkspaceId: z.string().max(256).nullable().optional(),
      daemonSessionId: z.string().max(256).nullable().optional(),
      worktreePath: z.string().max(4096).nullable().optional(),
      branch: z.string().max(256).nullable().optional(),
      baseRef: z.string().max(256).nullable().optional(),
      prUrl: z.string().url().max(2048).nullable().optional(),
      turnCount: z.number().int().min(0).optional(),
      inputTokens: z.number().int().min(0).optional(),
      outputTokens: z.number().int().min(0).optional(),
      costUsd: z.number().min(0).nullable().optional(),
    })
    .strict(),
);
export type UpdateAgentRunInput = z.infer<typeof updateAgentRunSchema>;
