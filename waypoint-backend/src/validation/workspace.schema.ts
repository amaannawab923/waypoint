import { z } from 'zod';
import { requireAtLeastOneField } from './shared.js';

export const updateWorkspaceSchema = requireAtLeastOneField(
  z.object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    companySize: z.string().optional(),
    timezone: z.string().optional(),
    plan: z.enum(['community', 'pro', 'business', 'enterprise']).optional(),
    restrictWorkspaceCreation: z.boolean().optional(),
  }),
);

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'guest']),
});

export const notificationPrefsSchema = z.object({
  email: z.boolean().optional(),
  push: z.boolean().optional(),
  mentions: z.boolean().optional(),
  comments: z.boolean().optional(),
});

export const updateCurrentUserSchema = requireAtLeastOneField(
  z.object({
    fullName: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    email: z.string().email().optional(),
    firstDayOfWeek: z.enum(['Sunday', 'Monday']).optional(),
    // Merged into the stored value, not replaced — see
    // members.service.ts's updateCurrentUser, the same convention
    // projects.service.ts's updateProjectAutomations uses for its own
    // partial-patch jsonb column.
    notificationPrefs: notificationPrefsSchema.optional(),
  }),
);
