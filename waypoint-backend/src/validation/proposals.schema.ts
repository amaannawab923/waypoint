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
