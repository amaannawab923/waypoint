import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as labelsService from '../services/labels.service.js';
import { createLabelSchema, updateLabelSchema } from '../validation/projects.schema.js';

export const labelsRouter = Router();

labelsRouter.get(
  '/labels',
  asyncHandler(async (req, res) => {
    res.json(await labelsService.listLabels(String(req.query.projectId ?? '')));
  }),
);

labelsRouter.post(
  '/projects/:projectId/labels',
  asyncHandler(async (req, res) => {
    const input = createLabelSchema.parse(req.body);
    res.status(201).json(await labelsService.createLabel(req.params.projectId, input));
  }),
);

labelsRouter.patch(
  '/labels/:id',
  asyncHandler(async (req, res) => {
    const patch = updateLabelSchema.parse(req.body);
    res.json(await labelsService.updateLabel(req.params.id, patch));
  }),
);

labelsRouter.delete(
  '/labels/:id',
  asyncHandler(async (req, res) => {
    await labelsService.deleteLabel(req.params.id);
    res.status(204).end();
  }),
);
