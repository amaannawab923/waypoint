import { z } from 'zod';

export const createWorkstreamSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  leadId: z.string().nullable().optional(),
  status: z.enum(['planned', 'active', 'paused', 'done', 'dropped']).optional(),
  startDate: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(),
  memberIds: z.array(z.string()).optional(),
});

export const updateWorkstreamSchema = createWorkstreamSchema.partial();

const sprintDateOrderMessage = { message: 'endDate must not be before startDate' };

const sprintFieldsSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  startDate: z.string(),
  endDate: z.string(),
  // Nullable (not just optional), mirroring createWorkstreamSchema's leadId above — an
  // explicit `leadId: null` clears the lead, distinct from omitting the field entirely.
  leadId: z.string().nullable().optional(),
  memberIds: z.array(z.string()).optional(),
});

export const createSprintSchema = sprintFieldsSchema.refine((c) => c.endDate >= c.startDate, sprintDateOrderMessage);

// Built from sprintFieldsSchema.partial() rather than createSprintSchema —
// .refine() wraps a schema in ZodEffects, which drops .partial(). A PATCH
// may legitimately touch only one of startDate/endDate, so the pair is only
// checked here when both arrive together in the same patch; a patch that
// changes just one date against an already-stored other date isn't
// re-validated (that needs a DB read the schema layer can't do) — a
// narrower gap than having no check at all.
export const updateSprintSchema = sprintFieldsSchema
  .partial()
  .refine((c) => c.startDate === undefined || c.endDate === undefined || c.endDate >= c.startDate, sprintDateOrderMessage);
