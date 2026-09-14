import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireSetupToken } from '../middleware/auth.js';
import * as instanceService from '../services/instance.service.js';
import { completeSetupSchema } from '../validation/instance.schema.js';

// AT8 (ROAD-143). Public: the desktop app asks any backend it's pointed
// at whether first-run setup is still needed and which sign-in methods
// exist (spec §4). Token-gated: completing setup. The ongoing admin
// surface is admin.routes.ts.
export const instanceRouter = Router();

instanceRouter.get(
  '/instance/setup-status',
  asyncHandler(async (_req, res) => {
    res.json(await instanceService.getSetupStatus());
  }),
);

instanceRouter.post(
  '/instance/setup',
  requireSetupToken(),
  asyncHandler(async (req, res) => {
    const input = completeSetupSchema.parse(req.body);
    res.status(201).json(await instanceService.completeSetup(input));
  }),
);
