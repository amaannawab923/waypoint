import { z } from 'zod';

export const createModuleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  leadId: z.string().nullable().optional(),
  status: z.enum(['backlog', 'planned', 'in-progress', 'paused', 'completed', 'cancelled']).optional(),
  startDate: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(),
  memberIds: z.array(z.string()).optional(),
});

export const updateModuleSchema = createModuleSchema.partial();

const cycleDateOrderMessage = { message: 'endDate must not be before startDate' };

const cycleFieldsSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  startDate: z.string(),
  endDate: z.string(),
  leadId: z.string().optional(),
  memberIds: z.array(z.string()).optional(),
});

export const createCycleSchema = cycleFieldsSchema.refine((c) => c.endDate >= c.startDate, cycleDateOrderMessage);

// Built from cycleFieldsSchema.partial() rather than createCycleSchema —
// .refine() wraps a schema in ZodEffects, which drops .partial(). A PATCH
// may legitimately touch only one of startDate/endDate, so the pair is only
// checked here when both arrive together in the same patch; a patch that
// changes just one date against an already-stored other date isn't
// re-validated (that needs a DB read the schema layer can't do) — a
// narrower gap than having no check at all.
export const updateCycleSchema = cycleFieldsSchema
  .partial()
  .refine((c) => c.startDate === undefined || c.endDate === undefined || c.endDate >= c.startDate, cycleDateOrderMessage);
