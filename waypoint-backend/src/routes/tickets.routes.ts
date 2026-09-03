import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { NotFoundError, ValidationError } from '../middleware/errors.js';
import * as ticketsService from '../services/tickets.service.js';
import * as commentsService from '../services/comments.service.js';
import * as activityService from '../services/activity.service.js';
import {
  createTicketSchema,
  updateTicketSchema,
  reorderTicketSchema,
  addTicketLinkSchema,
  addCommentSchema,
} from '../validation/tickets.schema.js';
import { ticketFilterSchema } from '../validation/ticketFilter.schema.js';
import type { TicketFilterQuery } from '../services/tickets.service.js';

export const ticketsRouter = Router();

// GET /tickets and GET /projects/:projectId/tickets both accept an
// optional `?filter=<base64url-encoded-JSON>` query param — the single
// typed-filter read path (docs/design/waypoint-revamp-architecture.md
// §4.6). Absent, both routes keep their original unfiltered behavior so no
// existing caller (MCP tools, etc.) is forced to pass one. The base64url
// encoding matches the convention already used for proposal list cursors
// (services/proposals.service.ts).
function decodeTicketFilterParam(raw: string): TicketFilterQuery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('invalid filter parameter');
  }
  const { v: _v, ...query } = ticketFilterSchema.parse(parsed);
  return query;
}

ticketsRouter.get(
  '/projects/:projectId/tickets',
  asyncHandler(async (req, res) => {
    const { filter } = req.query;
    if (typeof filter === 'string') {
      const query = decodeTicketFilterParam(filter);
      // Project-scoped route always wins over whatever projectIds the
      // filter itself carried — the path param is the source of truth here.
      res.json(await ticketsService.listTicketsByFilter({ ...query, projectIds: [req.params.projectId] }));
      return;
    }
    res.json(await ticketsService.listTickets(req.params.projectId));
  }),
);

ticketsRouter.get(
  '/tickets',
  asyncHandler(async (req, res) => {
    const { filter } = req.query;
    if (typeof filter === 'string') {
      res.json(await ticketsService.listTicketsByFilter(decodeTicketFilterParam(filter)));
      return;
    }
    res.json(await ticketsService.listAllTickets());
  }),
);

ticketsRouter.get(
  '/tickets/drafts',
  asyncHandler(async (_req, res) => {
    res.json(await ticketsService.listDraftTickets());
  }),
);

ticketsRouter.get(
  '/tickets/by-identifier/:identifier',
  asyncHandler(async (req, res) => {
    const item = await ticketsService.getTicketByIdentifier(req.params.identifier);
    if (!item) throw new NotFoundError('ticket');
    res.json(item);
  }),
);

ticketsRouter.get(
  '/tickets/:id',
  asyncHandler(async (req, res) => {
    const item = await ticketsService.getTicket(req.params.id);
    if (!item) throw new NotFoundError('ticket');
    res.json(item);
  }),
);

ticketsRouter.post(
  '/tickets',
  asyncHandler(async (req, res) => {
    const input = createTicketSchema.parse(req.body);
    res.status(201).json(await ticketsService.createTicket(input));
  }),
);

ticketsRouter.patch(
  '/tickets/:id',
  asyncHandler(async (req, res) => {
    const patch = updateTicketSchema.parse(req.body);
    res.json(await ticketsService.updateTicket(req.params.id, patch));
  }),
);

ticketsRouter.post(
  '/tickets/:id/assignees/:memberId/toggle',
  asyncHandler(async (req, res) => {
    res.json(await ticketsService.toggleTicketAssignee(req.params.id, req.params.memberId));
  }),
);

ticketsRouter.post(
  '/tickets/:id/labels/:labelId/toggle',
  asyncHandler(async (req, res) => {
    res.json(await ticketsService.toggleTicketLabel(req.params.id, req.params.labelId));
  }),
);

ticketsRouter.post(
  '/tickets/:id/reorder',
  asyncHandler(async (req, res) => {
    const { targetId, position } = reorderTicketSchema.parse(req.body);
    res.json(await ticketsService.reorderTicket(req.params.id, targetId, position));
  }),
);

ticketsRouter.delete(
  '/tickets/:id',
  asyncHandler(async (req, res) => {
    await ticketsService.deleteTicket(req.params.id);
    res.status(204).end();
  }),
);

ticketsRouter.get(
  '/tickets/:id/sub-items',
  asyncHandler(async (req, res) => {
    res.json(await ticketsService.listSubItems(req.params.id));
  }),
);

ticketsRouter.post(
  '/tickets/:id/links',
  asyncHandler(async (req, res) => {
    const input = addTicketLinkSchema.parse(req.body);
    res.status(201).json(await ticketsService.addTicketLink(req.params.id, input));
  }),
);

ticketsRouter.delete(
  '/tickets/:id/links/:linkId',
  asyncHandler(async (req, res) => {
    res.json(await ticketsService.removeTicketLink(req.params.id, req.params.linkId));
  }),
);

ticketsRouter.get(
  '/tickets/:id/comments',
  asyncHandler(async (req, res) => {
    res.json(await commentsService.listComments(req.params.id));
  }),
);

ticketsRouter.post(
  '/tickets/:id/comments',
  asyncHandler(async (req, res) => {
    const { bodyHtml } = addCommentSchema.parse(req.body);
    res.status(201).json(await commentsService.addComment(req.params.id, bodyHtml));
  }),
);

ticketsRouter.get(
  '/tickets/:id/activity',
  asyncHandler(async (req, res) => {
    res.json(await activityService.listActivity(req.params.id));
  }),
);
