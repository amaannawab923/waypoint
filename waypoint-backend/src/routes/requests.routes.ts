import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as requestsService from '../services/requests.service.js';
import { createRequestSchema, updateRequestStatusSchema, convertRequestSchema } from '../validation/requests.schema.js';

export const requestsRouter = Router();

requestsRouter.get(
  '/projects/:projectId/requests',
  asyncHandler(async (req, res) => {
    res.json(await requestsService.listRequests(req.params.projectId));
  }),
);

requestsRouter.post(
  '/requests',
  asyncHandler(async (req, res) => {
    const input = createRequestSchema.parse(req.body);
    res.status(201).json(await requestsService.createRequest(input));
  }),
);

requestsRouter.patch(
  '/requests/:id/status',
  asyncHandler(async (req, res) => {
    const { status } = updateRequestStatusSchema.parse(req.body);
    res.json(await requestsService.updateRequestStatus(req.params.id, status));
  }),
);

requestsRouter.post(
  '/requests/:id/convert',
  asyncHandler(async (req, res) => {
    const { stateId, ...overrides } = convertRequestSchema.parse(req.body);
    res.status(201).json(await requestsService.convertRequestToTicket(req.params.id, stateId, overrides));
  }),
);
