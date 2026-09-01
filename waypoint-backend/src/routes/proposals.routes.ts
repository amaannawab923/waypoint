import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as proposalsService from '../services/proposals.service.js';
import * as copilotService from '../services/copilot.service.js';
import {
  approveProposalSchema,
  rejectProposalSchema,
  rejectAllProposalsSchema,
  markProposalsNotifiedSchema,
} from '../validation/proposals.schema.js';

export const proposalsRouter = Router();

proposalsRouter.get(
  '/copilot/conversations/:id/proposals',
  asyncHandler(async (req, res) => {
    // getConversation is the 404 gate — listProposals itself would happily
    // return [] for a bogus conversation id, which the panel couldn't tell
    // apart from a real conversation with no proposals yet.
    const conversation = await copilotService.getConversation(req.params.id);
    res.json(await proposalsService.listProposals(conversation.id));
  }),
);

// Approve returns 200 even when the outcome is stale/expired — the
// response's `status` field IS the result, and the card renders whatever
// came back. It's also idempotent: re-approving an already-resolved
// proposal echoes the row with zero re-execution (see approveProposal).
proposalsRouter.post(
  '/copilot/proposals/:id/approve',
  asyncHandler(async (req, res) => {
    approveProposalSchema.parse(req.body ?? {});
    // Audit line for every approve attempt (QA finding: one observed
    // approve with no known click — code audit found no renderer path that
    // can fire this without a real click, but a write-approval endpoint
    // deserves a server-side trail regardless, so any future unexplained
    // execution has a timestamped record to correlate against).
    console.log(`[copilot-proposals] approve requested: ${req.params.id}`);
    res.json(await proposalsService.approveProposal(req.params.id));
  }),
);

proposalsRouter.post(
  '/copilot/proposals/:id/reject',
  asyncHandler(async (req, res) => {
    rejectProposalSchema.parse(req.body ?? {});
    res.json(await proposalsService.rejectProposal(req.params.id));
  }),
);

proposalsRouter.post(
  '/copilot/conversations/:id/proposals/reject-all',
  asyncHandler(async (req, res) => {
    rejectAllProposalsSchema.parse(req.body ?? {});
    const conversation = await copilotService.getConversation(req.params.id);
    res.json(await proposalsService.rejectAllPending(conversation.id));
  }),
);

proposalsRouter.post(
  '/copilot/conversations/:id/proposals/notified',
  asyncHandler(async (req, res) => {
    const { ids } = markProposalsNotifiedSchema.parse(req.body);
    const conversation = await copilotService.getConversation(req.params.id);
    res.json(await proposalsService.markProposalsNotified(conversation.id, ids));
  }),
);
