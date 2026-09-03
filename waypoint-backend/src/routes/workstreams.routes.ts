import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as workstreamsService from '../services/workstreams.service.js';
import { createWorkstreamSchema, updateWorkstreamSchema } from '../validation/workstreamsSprints.schema.js';

export const workstreamsRouter = Router();

workstreamsRouter.get(
  '/projects/:projectId/workstreams',
  asyncHandler(async (req, res) => {
    res.json(await workstreamsService.listWorkstreams(req.params.projectId));
  }),
);

workstreamsRouter.get(
  '/workstreams',
  asyncHandler(async (_req, res) => {
    res.json(await workstreamsService.listAllWorkstreams());
  }),
);

workstreamsRouter.post(
  '/projects/:projectId/workstreams',
  asyncHandler(async (req, res) => {
    const input = createWorkstreamSchema.parse(req.body);
    res.status(201).json(await workstreamsService.createWorkstream(req.params.projectId, input));
  }),
);

workstreamsRouter.patch(
  '/workstreams/:id',
  asyncHandler(async (req, res) => {
    const patch = updateWorkstreamSchema.parse(req.body);
    res.json(await workstreamsService.updateWorkstream(req.params.id, patch));
  }),
);
