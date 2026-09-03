import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as scratchNotesService from '../services/scratchNotes.service.js';
import { createScratchNoteSchema } from '../validation/misc.schema.js';

export const scratchNotesRouter = Router();

scratchNotesRouter.get(
  '/scratch-notes',
  asyncHandler(async (_req, res) => {
    res.json(await scratchNotesService.listScratchNotes());
  }),
);

scratchNotesRouter.post(
  '/scratch-notes',
  asyncHandler(async (req, res) => {
    const { title, body } = createScratchNoteSchema.parse(req.body);
    res.status(201).json(await scratchNotesService.createScratchNote(title, body));
  }),
);

scratchNotesRouter.delete(
  '/scratch-notes/:id',
  asyncHandler(async (req, res) => {
    await scratchNotesService.deleteScratchNote(req.params.id);
    res.status(204).end();
  }),
);
