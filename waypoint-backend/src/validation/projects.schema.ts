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
    // Shape only — existence, directory-ness and git-repo-ness need `fs`
    // calls, so they live in projects.service.ts's validateRepoPath instead.
    // Both POSIX (`/...`) and Windows drive-letter (`C:\...`, `C:/...`)
    // absolute forms are accepted: waypoint-frontend packages an nsis
    // Windows target alongside mac/linux, so a Windows path is a real
    // input here, not dead code.
    repoPath: z
      .string()
      .min(1)
      .refine((p) => /^\/|^[A-Za-z]:[\\/]/.test(p), 'repoPath must be an absolute path')
      .nullable()
      .optional(),
  }),
);

export const addProjectMemberSchema = z.object({
  memberId: z.string(),
  role: z.enum(['admin', 'member', 'guest']).optional(),
});

export const projectFeaturesSchema = z.object({
  sprints: z.boolean().optional(),
  workstreams: z.boolean().optional(),
  views: z.boolean().optional(),
  docs: z.boolean().optional(),
  requests: z.boolean().optional(),
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
  group: z.enum(['backlog', 'unstarted', 'started', 'completed', 'cancelled']),
  color: z.string(),
});

export const updateStateSchema = requireAtLeastOneField(
  z.object({
    name: z.string().min(1).optional(),
    group: z.enum(['backlog', 'unstarted', 'started', 'completed', 'cancelled']).optional(),
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
