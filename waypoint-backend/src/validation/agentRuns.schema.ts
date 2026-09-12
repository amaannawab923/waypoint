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

// A git ref name as this app is willing to pass to `git worktree add`:
// no leading `-` (git would read it as an option — found in review), and
// none of the characters check-ref-format refuses. The daemon uses argv
// arrays, so this is about honest failures, not injection.
export const gitRefSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !v.startsWith('-') && !/[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|\.lock$|^\/|\/$|^\.|\/\./.test(v), {
    message: 'not a valid git ref name',
  });

// One line, as the panel's row shows it. Nullable on update so a title can
// be removed; on create, absent and null mean the same thing.
const titleSchema = z
  .string()
  .max(120)
  .transform((v) => v.trim())
  .transform((v) => (v.length === 0 ? null : v))
  .nullable();

export const runIsolationSchema = z.enum(['worktree', 'directory']);
export const runIntentSchema = z.enum(['investigate', 'fix', 'custom']);

export const createAgentRunSchema = z
  .object({
    // Nullable since W4b: an independent run on a folder that is no
    // project's repository has no project. A dispatched run always has one.
    projectId: id.nullable().optional(),
    ticketId: id.nullable().optional(),
    ownerMemberId: id,
    agentId: id.nullable().optional(),
    entry: z.enum(['independent', 'dispatched']),
    providerId: z.string().min(1).max(64),
    baseRef: gitRefSchema.optional(),
    // What the user typed in the New session dialog (W4). Trimmed; an
    // empty title is no title, not a row named "".
    title: titleSchema.optional(),
    isolation: runIsolationSchema.optional(),
    autoApprove: z.boolean().optional(),
    // W5a: what a dispatched run was asked to do; the Copilot
    // conversation it came from, for the notes going back.
    intent: runIntentSchema.optional(),
    modeId: z.string().max(64).nullable().optional(),
    copilotConversationId: id.nullable().optional(),
    retryOfRunId: id.optional(),
  })
  .strict()
  // A dispatched run is one started from a ticket (schema/agentRuns.ts);
  // a dispatched run with no ticket is a contradiction, not a row.
  .refine((v) => v.entry !== 'dispatched' || (typeof v.ticketId === 'string' && v.ticketId.length > 0), {
    message: 'a dispatched run needs a ticketId',
    path: ['ticketId'],
  })
  // A ticket lives in a project; a run about it does too (W4b: only an
  // independent run may have none).
  .refine((v) => !v.ticketId || (typeof v.projectId === 'string' && v.projectId.length > 0), {
    message: 'a run with a ticketId needs its projectId',
    path: ['projectId'],
  })
  // A dispatched run is always a fresh worktree of the project's repo.
  .refine((v) => v.entry !== 'dispatched' || (v.isolation ?? 'worktree') === 'worktree', {
    message: 'a dispatched run always works in a worktree',
    path: ['isolation'],
  });
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

// W5a: a proposal filed by Waypoint main on a dispatched run's behalf —
// the agent's closing message as a comment, or the state change Fix
// asks for. Only these two kinds; a run never creates tickets or
// reassigns people.
export const createRunProposalSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('comment'), body: z.string().min(1).max(20_000) }).strict(),
    z.object({ kind: z.literal('state_change'), stateId: id }).strict(),
  ]);
export type CreateRunProposalInput = z.infer<typeof createRunProposalSchema>;

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
      providerSessionId: z.string().max(256).nullable().optional(),
      title: titleSchema.optional(),
      intent: runIntentSchema.nullable().optional(),
      modeId: z.string().max(64).nullable().optional(),
      copilotConversationId: id.nullable().optional(),
      worktreePath: z.string().max(4096).nullable().optional(),
      cwd: z.string().max(4096).nullable().optional(),
      branch: gitRefSchema.nullable().optional(),
      baseRef: gitRefSchema.nullable().optional(),
      prUrl: z.string().url().max(2048).nullable().optional(),
      turnCount: z.number().int().min(0).optional(),
      inputTokens: z.number().int().min(0).optional(),
      outputTokens: z.number().int().min(0).optional(),
      costUsd: z.number().min(0).nullable().optional(),
    })
    .strict(),
);
export type UpdateAgentRunInput = z.infer<typeof updateAgentRunSchema>;
