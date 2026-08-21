import { z } from 'zod';

export const createPageSchema = z.object({
  title: z.string().optional(),
  parentPageId: z.string().nullable().optional(),
});

export const updatePageSchema = z.object({
  title: z.string().min(1).optional(),
  icon: z.string().optional(),
  contentHtml: z.string().optional(),
  visibility: z.enum(['public', 'private', 'archived']).optional(),
  isFavorite: z.boolean().optional(),
  isLocked: z.boolean().optional(),
  parentPageId: z.string().nullable().optional(),
});
