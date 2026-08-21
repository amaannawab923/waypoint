import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { NotFoundError } from '../middleware/errors.js';
import * as workItemsService from '../services/workItems.service.js';
import * as commentsService from '../services/comments.service.js';
import * as activityService from '../services/activity.service.js';
import {
  createWorkItemSchema,
  updateWorkItemSchema,
  reorderWorkItemSchema,
  addWorkItemLinkSchema,
  addCommentSchema,
} from '../validation/workItems.schema.js';

export const workItemsRouter = Router();

workItemsRouter.get(
  '/projects/:projectId/work-items',
  asyncHandler(async (req, res) => {
    res.json(await workItemsService.listWorkItems(req.params.projectId));
  }),
);

workItemsRouter.get(
  '/work-items',
  asyncHandler(async (_req, res) => {
    res.json(await workItemsService.listAllWorkItems());
  }),
);

workItemsRouter.get(
  '/work-items/drafts',
  asyncHandler(async (_req, res) => {
    res.json(await workItemsService.listDraftWorkItems());
  }),
);

workItemsRouter.get(
  '/work-items/by-identifier/:identifier',
  asyncHandler(async (req, res) => {
    const item = await workItemsService.getWorkItemByIdentifier(req.params.identifier);
    if (!item) throw new NotFoundError('work item');
    res.json(item);
  }),
);

workItemsRouter.get(
  '/work-items/:id',
  asyncHandler(async (req, res) => {
    const item = await workItemsService.getWorkItem(req.params.id);
    if (!item) throw new NotFoundError('work item');
    res.json(item);
  }),
);

workItemsRouter.post(
  '/work-items',
  asyncHandler(async (req, res) => {
    const input = createWorkItemSchema.parse(req.body);
    res.status(201).json(await workItemsService.createWorkItem(input));
  }),
);

workItemsRouter.patch(
  '/work-items/:id',
  asyncHandler(async (req, res) => {
    const patch = updateWorkItemSchema.parse(req.body);
    res.json(await workItemsService.updateWorkItem(req.params.id, patch));
  }),
);

workItemsRouter.post(
  '/work-items/:id/assignees/:memberId/toggle',
  asyncHandler(async (req, res) => {
    res.json(await workItemsService.toggleWorkItemAssignee(req.params.id, req.params.memberId));
  }),
);

workItemsRouter.post(
  '/work-items/:id/labels/:labelId/toggle',
  asyncHandler(async (req, res) => {
    res.json(await workItemsService.toggleWorkItemLabel(req.params.id, req.params.labelId));
  }),
);

workItemsRouter.post(
  '/work-items/:id/reorder',
  asyncHandler(async (req, res) => {
    const { targetId, position } = reorderWorkItemSchema.parse(req.body);
    res.json(await workItemsService.reorderWorkItem(req.params.id, targetId, position));
  }),
);

workItemsRouter.delete(
  '/work-items/:id',
  asyncHandler(async (req, res) => {
    await workItemsService.deleteWorkItem(req.params.id);
    res.status(204).end();
  }),
);

workItemsRouter.get(
  '/work-items/:id/sub-items',
  asyncHandler(async (req, res) => {
    res.json(await workItemsService.listSubItems(req.params.id));
  }),
);

workItemsRouter.post(
  '/work-items/:id/links',
  asyncHandler(async (req, res) => {
    const input = addWorkItemLinkSchema.parse(req.body);
    res.status(201).json(await workItemsService.addWorkItemLink(req.params.id, input));
  }),
);

workItemsRouter.delete(
  '/work-items/:id/links/:linkId',
  asyncHandler(async (req, res) => {
    res.json(await workItemsService.removeWorkItemLink(req.params.id, req.params.linkId));
  }),
);

workItemsRouter.get(
  '/work-items/:id/comments',
  asyncHandler(async (req, res) => {
    res.json(await commentsService.listComments(req.params.id));
  }),
);

workItemsRouter.post(
  '/work-items/:id/comments',
  asyncHandler(async (req, res) => {
    const { bodyHtml } = addCommentSchema.parse(req.body);
    res.status(201).json(await commentsService.addComment(req.params.id, bodyHtml));
  }),
);

workItemsRouter.get(
  '/work-items/:id/activity',
  asyncHandler(async (req, res) => {
    res.json(await activityService.listActivity(req.params.id));
  }),
);
