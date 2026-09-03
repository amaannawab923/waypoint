import { z } from 'zod';

export const createDocSchema = z.object({
  title: z.string().optional(),
  parentDocId: z.string().nullable().optional(),
});

export const updateDocSchema = z.object({
  title: z.string().min(1).optional(),
  icon: z.string().optional(),
  contentHtml: z.string().optional(),
  visibility: z.enum(['public', 'private', 'archived']).optional(),
  isFavorite: z.boolean().optional(),
  isLocked: z.boolean().optional(),
  parentDocId: z.string().nullable().optional(),
});
