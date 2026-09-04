import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as sprintsService from '../services/sprints.service.js';
import { createSprintSchema, updateSprintSchema } from '../validation/workstreamsSprints.schema.js';

export const sprintsRouter = Router();

sprintsRouter.get(
  '/projects/:projectId/sprints',
  asyncHandler(async (req, res) => {
    res.json(await sprintsService.listSprints(req.params.projectId));
  }),
);

sprintsRouter.get(
  '/sprints',
  asyncHandler(async (_req, res) => {
    res.json(await sprintsService.listAllSprints());
  }),
);

sprintsRouter.post(
  '/projects/:projectId/sprints',
  asyncHandler(async (req, res) => {
    const input = createSprintSchema.parse(req.body);
    res.status(201).json(await sprintsService.createSprint(req.params.projectId, input));
  }),
);

sprintsRouter.patch(
  '/sprints/:id',
  asyncHandler(async (req, res) => {
    const patch = updateSprintSchema.parse(req.body);
    res.json(await sprintsService.updateSprint(req.params.id, patch));
  }),
);

sprintsRouter.delete(
  '/sprints/:id',
  asyncHandler(async (req, res) => {
    await sprintsService.deleteSprint(req.params.id);
    res.status(204).end();
  }),
);
