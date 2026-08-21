import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as cyclesService from '../services/cycles.service.js';
import { createCycleSchema, updateCycleSchema } from '../validation/modulesCycles.schema.js';

export const cyclesRouter = Router();

cyclesRouter.get(
  '/projects/:projectId/cycles',
  asyncHandler(async (req, res) => {
    res.json(await cyclesService.listCycles(req.params.projectId));
  }),
);

cyclesRouter.get(
  '/cycles',
  asyncHandler(async (_req, res) => {
    res.json(await cyclesService.listAllCycles());
  }),
);

cyclesRouter.post(
  '/projects/:projectId/cycles',
  asyncHandler(async (req, res) => {
    const input = createCycleSchema.parse(req.body);
    res.status(201).json(await cyclesService.createCycle(req.params.projectId, input));
  }),
);

cyclesRouter.patch(
  '/cycles/:id',
  asyncHandler(async (req, res) => {
    const patch = updateCycleSchema.parse(req.body);
    res.json(await cyclesService.updateCycle(req.params.id, patch));
  }),
);

cyclesRouter.delete(
  '/cycles/:id',
  asyncHandler(async (req, res) => {
    await cyclesService.deleteCycle(req.params.id);
    res.status(204).end();
  }),
);
