import { z } from 'zod';
import { requireAtLeastOneField } from './shared.js';

export const createProjectSchema = z.object({
  name: z.string().min(1),
  identifier: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  network: z.enum(['public', 'private']).optional(),
  leadId: z.string().nullable().optional(),
});

export const updateProjectSchema = requireAtLeastOneField(
  z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    network: z.enum(['public', 'private']).optional(),
    leadId: z.string().nullable().optional(),
    defaultAssigneeId: z.string().nullable().optional(),
    timezone: z.string().optional(),
    guestAccessEnabled: z.boolean().optional(),
  }),
);

export const addProjectMemberSchema = z.object({
  memberId: z.string(),
  role: z.enum(['admin', 'member', 'guest']).optional(),
});

export const projectFeaturesSchema = z.object({
  cycles: z.boolean().optional(),
  modules: z.boolean().optional(),
  views: z.boolean().optional(),
  pages: z.boolean().optional(),
  intake: z.boolean().optional(),
});

export const projectEstimateSchema = z
  .object({
    type: z.enum(['points', 'categories']),
    values: z.array(z.string()),
  })
  .nullable();

export const projectAutomationsSchema = z.object({
  autoArchiveEnabled: z.boolean().optional(),
  autoArchiveAfterDays: z.number().optional(),
  autoCloseEnabled: z.boolean().optional(),
  autoCloseAfterDays: z.number().optional(),
});

export const createStateSchema = z.object({
  name: z.string().min(1),
  group: z.enum(['backlog', 'unstarted', 'started', 'completed', 'cancelled', 'triage']),
  color: z.string(),
});

export const updateStateSchema = requireAtLeastOneField(
  z.object({
    name: z.string().min(1).optional(),
    group: z.enum(['backlog', 'unstarted', 'started', 'completed', 'cancelled', 'triage']).optional(),
    color: z.string().optional(),
  }),
);

export const createLabelSchema = z.object({
  name: z.string().min(1),
  color: z.string(),
});

export const updateLabelSchema = requireAtLeastOneField(
  z.object({
    name: z.string().min(1).optional(),
    color: z.string().optional(),
  }),
);
