import { z } from 'zod';

const priority = z.enum(['urgent', 'high', 'medium', 'low', 'none']);

export const createIntakeRequestSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: priority.optional(),
  sourceName: z.string(),
  sourceEmail: z.string(),
});

export const updateIntakeStatusSchema = z.object({
  status: z.enum(['pending', 'accepted', 'declined', 'duplicate']),
});

export const convertIntakeSchema = z.object({
  stateId: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  priority: priority.optional(),
});
