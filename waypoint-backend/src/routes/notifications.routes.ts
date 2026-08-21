import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as notificationsService from '../services/notifications.service.js';

export const notificationsRouter = Router();

notificationsRouter.get(
  '/notifications',
  asyncHandler(async (_req, res) => {
    res.json(await notificationsService.listNotifications());
  }),
);

notificationsRouter.post(
  '/notifications/:id/read',
  asyncHandler(async (req, res) => {
    await notificationsService.markNotificationRead(req.params.id);
    res.status(204).end();
  }),
);
