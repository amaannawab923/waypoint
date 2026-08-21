import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as exportsService from '../services/exports.service.js';
import { createExportSchema } from '../validation/misc.schema.js';

export const exportsRouter = Router();

exportsRouter.get(
  '/exports',
  asyncHandler(async (_req, res) => {
    res.json(await exportsService.listExports());
  }),
);

exportsRouter.post(
  '/exports',
  asyncHandler(async (req, res) => {
    const input = createExportSchema.parse(req.body);
    res.status(201).json(await exportsService.createExport(input));
  }),
);
