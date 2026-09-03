import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as intakeService from '../services/intake.service.js';
import { createIntakeRequestSchema, updateIntakeStatusSchema, convertIntakeSchema } from '../validation/intake.schema.js';

export const intakeRouter = Router();

intakeRouter.get(
  '/projects/:projectId/intake',
  asyncHandler(async (req, res) => {
    res.json(await intakeService.listIntake(req.params.projectId));
  }),
);

intakeRouter.post(
  '/intake',
  asyncHandler(async (req, res) => {
    const input = createIntakeRequestSchema.parse(req.body);
    res.status(201).json(await intakeService.createIntakeRequest(input));
  }),
);

intakeRouter.patch(
  '/intake/:id/status',
  asyncHandler(async (req, res) => {
    const { status } = updateIntakeStatusSchema.parse(req.body);
    res.json(await intakeService.updateIntakeStatus(req.params.id, status));
  }),
);

intakeRouter.post(
  '/intake/:id/convert',
  asyncHandler(async (req, res) => {
    const { stateId, ...overrides } = convertIntakeSchema.parse(req.body);
    res.status(201).json(await intakeService.convertIntakeToTicket(req.params.id, stateId, overrides));
  }),
);
