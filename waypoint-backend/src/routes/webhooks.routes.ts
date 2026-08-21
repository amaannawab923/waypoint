import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as webhooksService from '../services/webhooks.service.js';
import { createWebhookSchema } from '../validation/misc.schema.js';

export const webhooksRouter = Router();

webhooksRouter.get(
  '/webhooks',
  asyncHandler(async (_req, res) => {
    res.json(await webhooksService.listWebhooks());
  }),
);

webhooksRouter.post(
  '/webhooks',
  asyncHandler(async (req, res) => {
    const input = createWebhookSchema.parse(req.body);
    res.status(201).json(await webhooksService.createWebhook(input));
  }),
);

webhooksRouter.delete(
  '/webhooks/:id',
  asyncHandler(async (req, res) => {
    await webhooksService.deleteWebhook(req.params.id);
    res.status(204).end();
  }),
);
