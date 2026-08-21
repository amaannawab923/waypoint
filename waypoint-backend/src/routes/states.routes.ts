import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as statesService from '../services/states.service.js';
import { createStateSchema, updateStateSchema } from '../validation/projects.schema.js';

export const statesRouter = Router();

statesRouter.get(
  '/states',
  asyncHandler(async (req, res) => {
    res.json(await statesService.listStates(String(req.query.projectId ?? '')));
  }),
);

statesRouter.post(
  '/projects/:projectId/states',
  asyncHandler(async (req, res) => {
    const input = createStateSchema.parse(req.body);
    res.status(201).json(await statesService.createState(req.params.projectId, input));
  }),
);

statesRouter.patch(
  '/states/:id',
  asyncHandler(async (req, res) => {
    const patch = updateStateSchema.parse(req.body);
    res.json(await statesService.updateState(req.params.id, patch));
  }),
);

statesRouter.get(
  '/states/:id/work-item-count',
  asyncHandler(async (req, res) => {
    res.json({ count: await statesService.countWorkItemsInState(req.params.id) });
  }),
);

statesRouter.delete(
  '/states/:id',
  asyncHandler(async (req, res) => {
    await statesService.deleteState(req.params.id);
    res.status(204).end();
  }),
);
