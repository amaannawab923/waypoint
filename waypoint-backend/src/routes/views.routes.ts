import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as viewsService from '../services/views.service.js';
import { createViewSchema, updateViewSchema } from '../validation/views.schema.js';

export const viewsRouter = Router();

viewsRouter.get(
  '/projects/:projectId/views',
  asyncHandler(async (req, res) => {
    res.json(await viewsService.listViews(req.params.projectId));
  }),
);

viewsRouter.post(
  '/projects/:projectId/views',
  asyncHandler(async (req, res) => {
    const { name, filters } = createViewSchema.parse(req.body);
    res.status(201).json(await viewsService.createView(req.params.projectId, name, filters));
  }),
);

viewsRouter.patch(
  '/views/:id',
  asyncHandler(async (req, res) => {
    const patch = updateViewSchema.parse(req.body);
    res.json(await viewsService.updateView(req.params.id, patch));
  }),
);

viewsRouter.delete(
  '/views/:id',
  asyncHandler(async (req, res) => {
    await viewsService.deleteView(req.params.id);
    res.status(204).end();
  }),
);
