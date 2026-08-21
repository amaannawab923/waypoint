import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { NotFoundError } from '../middleware/errors.js';
import * as pagesService from '../services/pages.service.js';
import { createPageSchema, updatePageSchema } from '../validation/pages.schema.js';

export const pagesRouter = Router();

pagesRouter.get(
  '/projects/:projectId/pages',
  asyncHandler(async (req, res) => {
    res.json(await pagesService.listPages(req.params.projectId));
  }),
);

pagesRouter.get(
  '/pages',
  asyncHandler(async (_req, res) => {
    res.json(await pagesService.listAllPages());
  }),
);

pagesRouter.get(
  '/pages/:id',
  asyncHandler(async (req, res) => {
    const page = await pagesService.getPage(req.params.id);
    if (!page) throw new NotFoundError('page');
    res.json(page);
  }),
);

pagesRouter.post(
  '/projects/:projectId/pages',
  asyncHandler(async (req, res) => {
    const { title, parentPageId } = createPageSchema.parse(req.body);
    res.status(201).json(await pagesService.createPage(req.params.projectId, title, parentPageId ?? null));
  }),
);

pagesRouter.patch(
  '/pages/:id',
  asyncHandler(async (req, res) => {
    const patch = updatePageSchema.parse(req.body);
    res.json(await pagesService.updatePage(req.params.id, patch));
  }),
);

pagesRouter.delete(
  '/pages/:id',
  asyncHandler(async (req, res) => {
    await pagesService.deletePage(req.params.id);
    res.status(204).end();
  }),
);
