import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { NotFoundError } from '../middleware/errors.js';
import * as agentsService from '../services/agents.service.js';
import * as agentAssignmentsService from '../services/agentAssignments.service.js';
import { createAgentSchema, updateAgentSchema, ensureAgentAssignmentsSchema } from '../validation/agents.schema.js';

export const agentsRouter = Router();

agentsRouter.get(
  '/agents',
  asyncHandler(async (_req, res) => {
    res.json(await agentsService.listAgents());
  }),
);

agentsRouter.get(
  '/agents/:id',
  asyncHandler(async (req, res) => {
    const agent = await agentsService.getAgent(req.params.id);
    if (!agent) throw new NotFoundError('agent');
    res.json(agent);
  }),
);

agentsRouter.post(
  '/agents',
  asyncHandler(async (req, res) => {
    const input = createAgentSchema.parse(req.body);
    res.status(201).json(await agentsService.createAgent(input));
  }),
);

agentsRouter.patch(
  '/agents/:id',
  asyncHandler(async (req, res) => {
    const patch = updateAgentSchema.parse(req.body);
    res.json(await agentsService.updateAgent(req.params.id, patch));
  }),
);

agentsRouter.delete(
  '/agents/:id',
  asyncHandler(async (req, res) => {
    await agentsService.deleteAgent(req.params.id);
    res.status(204).end();
  }),
);

agentsRouter.get(
  '/agent-assignments',
  asyncHandler(async (_req, res) => {
    res.json(await agentAssignmentsService.listAgentAssignments());
  }),
);

agentsRouter.post(
  '/tickets/:id/agent-assignments',
  asyncHandler(async (req, res) => {
    const { agentIds } = ensureAgentAssignmentsSchema.parse(req.body);
    await agentAssignmentsService.ensureAgentAssignments(req.params.id, agentIds);
    res.status(204).end();
  }),
);

agentsRouter.post(
  '/tickets/:id/agents/:agentId/toggle',
  asyncHandler(async (req, res) => {
    res.json(await agentAssignmentsService.toggleTicketAgent(req.params.id, req.params.agentId));
  }),
);

agentsRouter.post(
  '/tickets/:id/agents/:agentId/take-back',
  asyncHandler(async (req, res) => {
    res.json(await agentAssignmentsService.takeBackOverFromAgent(req.params.id, req.params.agentId));
  }),
);
