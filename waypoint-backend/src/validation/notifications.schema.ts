import { z } from 'zod';
import { NOTIFICATION_PAGE_MAX, NOTIFICATION_TABS } from '../services/notifications.service.js';

const tab = z.enum(Object.keys(NOTIFICATION_TABS) as [keyof typeof NOTIFICATION_TABS, ...(keyof typeof NOTIFICATION_TABS)[]]);

// `.strict()` everywhere: an unknown key is a client bug worth a 400, not a
// silently ignored filter.
export const listNotificationsQuerySchema = z
  .object({
    tab: tab.optional(),
    // Query strings are text: only the literal "true" turns the filter on.
    unread: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(NOTIFICATION_PAGE_MAX).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export const markAllNotificationsReadSchema = z
  .object({
    tab: tab.optional(),
    // The cursor of the newest row the caller has loaded. Required: "mark
    // everything read" without a bound would clear rows nobody has seen.
    before: z.string().min(1).max(512),
  })
  .strict();

export const markReadForTicketSchema = z.object({ ticketId: z.string().min(1).max(64) }).strict();
