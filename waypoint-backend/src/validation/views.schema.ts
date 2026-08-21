import { z } from 'zod';
import { boundedJson } from './shared.js';

export const createViewSchema = z.object({
  name: z.string().min(1),
  filters: boundedJson(z.record(z.string(), z.unknown())),
});

export const updateViewSchema = z.object({
  name: z.string().min(1).optional(),
  filters: boundedJson(z.record(z.string(), z.unknown())).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  isFavorite: z.boolean().optional(),
});
