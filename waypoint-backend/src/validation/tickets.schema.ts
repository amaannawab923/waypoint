import { z } from 'zod';

const priority = z.enum(['urgent', 'high', 'medium', 'low', 'none']);

export const createTicketSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  stateId: z.string(),
  priority: priority.optional(),
  assigneeIds: z.array(z.string()).optional(),
  labelIds: z.array(z.string()).optional(),
  workstreamId: z.string().nullable().optional(),
  sprintId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  isDraft: z.boolean().optional(),
});

export const updateTicketSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  stateId: z.string().optional(),
  priority: priority.optional(),
  assigneeIds: z.array(z.string()).optional(),
  labelIds: z.array(z.string()).optional(),
  workstreamId: z.string().nullable().optional(),
  sprintId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  estimatePoints: z.number().nullable().optional(),
  estimateValue: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  isDraft: z.boolean().optional(),
});

export const reorderTicketSchema = z.object({
  targetId: z.string(),
  position: z.enum(['before', 'after']),
});

export const addTicketLinkSchema = z.object({
  url: z.string(),
  label: z.string(),
});

export const addCommentSchema = z.object({
  bodyHtml: z.string().min(1),
});
