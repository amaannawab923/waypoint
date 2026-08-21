import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as stickiesService from '../services/stickies.service.js';
import { createStickySchema } from '../validation/misc.schema.js';

export const stickiesRouter = Router();

stickiesRouter.get(
  '/stickies',
  asyncHandler(async (_req, res) => {
    res.json(await stickiesService.listStickies());
  }),
);

stickiesRouter.post(
  '/stickies',
  asyncHandler(async (req, res) => {
    const { title, body } = createStickySchema.parse(req.body);
    res.status(201).json(await stickiesService.createSticky(title, body));
  }),
);

stickiesRouter.delete(
  '/stickies/:id',
  asyncHandler(async (req, res) => {
    await stickiesService.deleteSticky(req.params.id);
    res.status(204).end();
  }),
);
