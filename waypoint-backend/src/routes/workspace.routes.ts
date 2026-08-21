import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as workspaceService from '../services/workspace.service.js';
import { updateWorkspaceSchema } from '../validation/workspace.schema.js';

export const workspaceRouter = Router();

workspaceRouter.get(
  '/workspace',
  asyncHandler(async (_req, res) => {
    res.json(await workspaceService.getWorkspace());
  }),
);

workspaceRouter.patch(
  '/workspace',
  asyncHandler(async (req, res) => {
    const patch = updateWorkspaceSchema.parse(req.body);
    res.json(await workspaceService.updateWorkspace(patch));
  }),
);
