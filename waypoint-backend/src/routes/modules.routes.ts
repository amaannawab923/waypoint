import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as modulesService from '../services/modules.service.js';
import { createModuleSchema, updateModuleSchema } from '../validation/modulesCycles.schema.js';

export const modulesRouter = Router();

modulesRouter.get(
  '/projects/:projectId/modules',
  asyncHandler(async (req, res) => {
    res.json(await modulesService.listModules(req.params.projectId));
  }),
);

modulesRouter.get(
  '/modules',
  asyncHandler(async (_req, res) => {
    res.json(await modulesService.listAllModules());
  }),
);

modulesRouter.post(
  '/projects/:projectId/modules',
  asyncHandler(async (req, res) => {
    const input = createModuleSchema.parse(req.body);
    res.status(201).json(await modulesService.createModule(req.params.projectId, input));
  }),
);

modulesRouter.patch(
  '/modules/:id',
  asyncHandler(async (req, res) => {
    const patch = updateModuleSchema.parse(req.body);
    res.json(await modulesService.updateModule(req.params.id, patch));
  }),
);
