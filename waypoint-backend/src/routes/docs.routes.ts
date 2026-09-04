import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { NotFoundError } from '../middleware/errors.js';
import * as docsService from '../services/docs.service.js';
import { createDocSchema, updateDocSchema } from '../validation/docs.schema.js';

export const docsRouter = Router();

docsRouter.get(
  '/projects/:projectId/docs',
  asyncHandler(async (req, res) => {
    res.json(await docsService.listDocs(req.params.projectId));
  }),
);

docsRouter.get(
  '/docs',
  asyncHandler(async (_req, res) => {
    res.json(await docsService.listAllDocs());
  }),
);

docsRouter.get(
  '/docs/:id',
  asyncHandler(async (req, res) => {
    const doc = await docsService.getDoc(req.params.id);
    if (!doc) throw new NotFoundError('doc');
    res.json(doc);
  }),
);

docsRouter.post(
  '/projects/:projectId/docs',
  asyncHandler(async (req, res) => {
    const { title, parentDocId } = createDocSchema.parse(req.body);
    res.status(201).json(await docsService.createDoc(req.params.projectId, title, parentDocId ?? null));
  }),
);

docsRouter.patch(
  '/docs/:id',
  asyncHandler(async (req, res) => {
    const patch = updateDocSchema.parse(req.body);
    res.json(await docsService.updateDoc(req.params.id, patch));
  }),
);

docsRouter.delete(
  '/docs/:id',
  asyncHandler(async (req, res) => {
    await docsService.deleteDoc(req.params.id);
    res.status(204).end();
  }),
);
