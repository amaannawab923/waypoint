import { z } from 'zod';

export const createAgentSchema = z.object({
  name: z.string().min(1),
  avatarColor: z.string(),
  instructionsFile: z.object({ filename: z.string(), contentMarkdown: z.string() }),
  scopeAllProjects: z.boolean(),
  scopeProjectIds: z.array(z.string()).optional(),
  executionMethod: z.enum([
    'local-claude-subscription',
    'local-codex-subscription',
    'local-gemini-subscription',
    'hosted-api-key',
  ]),
  model: z.string(),
  autonomy: z.enum(['plan-only', 'ask-before-write', 'ask-before-pr', 'full-auto']),
  triggers: z.array(z.enum(['manual', 'on-assign', 'on-comment-mention', 'on-label'])).optional(),
  templateId: z.string().optional(),
});

export const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  avatarColor: z.string().optional(),
  instructionsFile: z.object({ filename: z.string(), contentMarkdown: z.string() }).optional(),
  scopeAllProjects: z.boolean().optional(),
  scopeProjectIds: z.array(z.string()).optional(),
  executionMethod: z
    .enum(['local-claude-subscription', 'local-codex-subscription', 'local-gemini-subscription', 'hosted-api-key'])
    .optional(),
  model: z.string().optional(),
  autonomy: z.enum(['plan-only', 'ask-before-write', 'ask-before-pr', 'full-auto']).optional(),
  triggers: z.array(z.enum(['manual', 'on-assign', 'on-comment-mention', 'on-label'])).optional(),
  isActive: z.boolean().optional(),
});

export const ensureAgentAssignmentsSchema = z.object({
  agentIds: z.array(z.string()),
});
