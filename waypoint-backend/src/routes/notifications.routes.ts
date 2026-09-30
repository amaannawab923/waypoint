import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as notificationsService from '../services/notifications.service.js';
import {
  listNotificationsQuerySchema,
  markAllNotificationsReadSchema,
  markReadForTicketSchema,
} from '../validation/notifications.schema.js';

export const notificationsRouter = Router();

notificationsRouter.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const q = listNotificationsQuerySchema.parse(req.query);
    res.json(
      await notificationsService.listNotifications({
        tab: q.tab,
        unreadOnly: q.unread === 'true',
        limit: q.limit,
        cursor: q.cursor,
      }),
    );
  }),
);

// Registered before `/:id/...` so "unread-count" is never read as an id.
notificationsRouter.get(
  '/notifications/unread-count',
  asyncHandler(async (_req, res) => {
    res.json({ count: await notificationsService.countUnreadNotifications() });
  }),
);

notificationsRouter.post(
  '/notifications/read-all',
  asyncHandler(async (req, res) => {
    const body = markAllNotificationsReadSchema.parse(req.body ?? {});
    res.json(await notificationsService.markAllNotificationsRead(body));
  }),
);

// Opening a ticket clears what it was about. Registered before `/:id/...`.
notificationsRouter.post(
  '/notifications/read-for-ticket',
  asyncHandler(async (req, res) => {
    const { ticketId } = markReadForTicketSchema.parse(req.body ?? {});
    res.json(await notificationsService.markNotificationsReadForTicket(ticketId));
  }),
);

notificationsRouter.post(
  '/notifications/:id/read',
  asyncHandler(async (req, res) => {
    await notificationsService.markNotificationRead(req.params.id);
    res.status(204).end();
  }),
);

notificationsRouter.post(
  '/notifications/:id/unread',
  asyncHandler(async (req, res) => {
    await notificationsService.markNotificationUnread(req.params.id);
    res.status(204).end();
  }),
);
