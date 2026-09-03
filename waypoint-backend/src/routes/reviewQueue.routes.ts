import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as proposalsService from '../services/proposals.service.js';
import {
  listReviewQueueQuerySchema,
  bulkProposalIdsSchema,
  ticketProposalsQuerySchema,
} from '../validation/proposals.schema.js';

// The workspace-scoped aggregate surface (P3 W3.2 — architecture §4.4).
// proposals.routes.ts keeps every existing conversation-scoped Copilot-panel
// endpoint working exactly as today (all mounted under /copilot/...); this
// router adds the review queue on top of the SAME table, reusing the
// existing single-row approveProposal/rejectProposal for every write — it
// never reimplements the state machine those already own.
//
// No path collision with proposals.routes.ts: that router's paths are all
// prefixed /copilot/... (conversation-scoped), while this router's paths
// are bare /proposals... and /tickets/:id/proposals — Express matches both
// routers' distinct static/param segments with no overlap.
export const reviewQueueRouter = Router();

reviewQueueRouter.get(
  '/proposals',
  asyncHandler(async (req, res) => {
    const query = listReviewQueueQuerySchema.parse(req.query);
    res.json(await proposalsService.listReviewQueue(query));
  }),
);

// Polled by the sidebar badge — deliberately its own lightweight endpoint
// rather than making every badge refresh pull a full page of proposals.
reviewQueueRouter.get(
  '/proposals/counts',
  asyncHandler(async (_req, res) => {
    res.json(await proposalsService.getProposalCounts());
  }),
);

reviewQueueRouter.post(
  '/proposals/bulk-approve',
  asyncHandler(async (req, res) => {
    const { ids } = bulkProposalIdsSchema.parse(req.body ?? {});
    res.json({ results: await proposalsService.bulkApproveProposals(ids) });
  }),
);

reviewQueueRouter.post(
  '/proposals/bulk-reject',
  asyncHandler(async (req, res) => {
    const { ids } = bulkProposalIdsSchema.parse(req.body ?? {});
    res.json({ results: await proposalsService.bulkRejectProposals(ids) });
  }),
);

// Ticket-detail's inline "pending proposals" section.
reviewQueueRouter.get(
  '/tickets/:id/proposals',
  asyncHandler(async (req, res) => {
    const { status } = ticketProposalsQuerySchema.parse(req.query);
    res.json({ proposals: await proposalsService.listProposalsForTicket(req.params.id, status) });
  }),
);
