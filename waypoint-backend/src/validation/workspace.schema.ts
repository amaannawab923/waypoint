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

export const updateCurrentUserSchema = requireAtLeastOneField(
  z.object({
    fullName: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    email: z.string().email().optional(),
  }),
);
