import { z } from 'zod';
import { ticketFilterSchema } from './ticketFilter.schema.js';

// A saved view's filters is validated against the same typed shape as the
// ticket list read path (§4.6) — no more arbitrary jsonb. boundedJson's
// depth guard (shared.ts) isn't needed here anymore: ticketFilterSchema is
// a fixed, flat-ish shape (string/boolean/array-of-string fields only, no
// unbounded nesting), so the pathological-depth attack that guard exists
// for doesn't apply to this field once it has a real schema.
export const createViewSchema = z.object({
  name: z.string().min(1),
  filters: ticketFilterSchema,
});

export const updateViewSchema = z.object({
  name: z.string().min(1).optional(),
  filters: ticketFilterSchema.optional(),
  visibility: z.enum(['public', 'private']).optional(),
  isFavorite: z.boolean().optional(),
});
