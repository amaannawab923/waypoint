import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { seed } from '../db/seed.js';

export const devRouter = Router();

devRouter.post(
  '/dev/reset',
  asyncHandler(async (_req, res) => {
    await seed();
    res.status(204).end();
  }),
);
