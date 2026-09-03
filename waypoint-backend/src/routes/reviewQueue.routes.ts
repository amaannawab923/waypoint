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

// W4.5 (architecture §4.2/§4.4, decision 10) — the Analytics tile's data
// source. Deliberately its own lightweight endpoint, same pattern as
// /proposals/counts above: the tile polls this alone rather than paging
// through proposals to compute it client-side.
reviewQueueRouter.get(
  '/proposals/stats/approved-per-day',
  asyncHandler(async (_req, res) => {
    res.json(await proposalsService.getApprovedPerActiveDayStats());
  }),
);

// W4.3 (architecture §4.4/§4.5) — the review screen's health-strip data
// source. Same lightweight-endpoint pattern as /proposals/counts and
// /proposals/stats/approved-per-day above: its own poll, not derived from a
// page of /proposals results client-side.
reviewQueueRouter.get(
  '/proposals/stats/health',
  asyncHandler(async (_req, res) => {
    res.json(await proposalsService.getReviewHealthStats());
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
