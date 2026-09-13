import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { NotFoundError } from '../middleware/errors.js';
import * as agentRunsService from '../services/agentRuns.service.js';
import * as proposalsService from '../services/proposals.service.js';
import {
  appendAgentRunEventSchema,
  createAgentRunSchema,
  createRunProposalSchema,
  listAgentRunEventsQuerySchema,
  listAgentRunsQuerySchema,
  saveAgentRunTranscriptSchema,
  updateAgentRunSchema,
} from '../validation/agentRuns.schema.js';

// The agent-runs ledger's HTTP surface — ROAD-54, plus the ticket relation
// ROAD-56 asked for. Thin by design: validation here, rules in the service,
// the status machine in runStatusMachine.ts. A refused status move is a 409
// whose body is the sentence the panel shows.

export const agentRunsRouter = Router();

agentRunsRouter.post(
  '/agent-runs',
  asyncHandler(async (req, res) => {
    const input = createAgentRunSchema.parse(req.body);
    res.status(201).json(await agentRunsService.createRun(input));
  }),
);

agentRunsRouter.get(
  '/agent-runs',
  asyncHandler(async (req, res) => {
    const query = listAgentRunsQuerySchema.parse(req.query);
    res.json(await agentRunsService.listRuns(query));
  }),
);

agentRunsRouter.get(
  '/agent-runs/:id',
  asyncHandler(async (req, res) => {
    const run = await agentRunsService.getRun(req.params.id);
    if (!run) throw new NotFoundError('agent run');
    res.json(run);
  }),
);

agentRunsRouter.patch(
  '/agent-runs/:id',
  asyncHandler(async (req, res) => {
    const patch = updateAgentRunSchema.parse(req.body);
    res.json(await agentRunsService.updateRun(req.params.id, patch));
  }),
);

agentRunsRouter.get(
  '/agent-runs/:id/events',
  asyncHandler(async (req, res) => {
    const query = listAgentRunEventsQuerySchema.parse(req.query);
    res.json(await agentRunsService.listEvents(req.params.id, query));
  }),
);

agentRunsRouter.post(
  '/agent-runs/:id/events',
  asyncHandler(async (req, res) => {
    const input = appendAgentRunEventSchema.parse(req.body);
    res.status(201).json(await agentRunsService.appendEvent(req.params.id, input));
  }),
);

// W5a follow-up (ROAD-124): the transcript snapshot main keeps for a run,
// replaced whole (PUT); the panel reads it when the daemon holds nothing.
agentRunsRouter.put(
  '/agent-runs/:id/transcript',
  asyncHandler(async (req, res) => {
    const input = saveAgentRunTranscriptSchema.parse(req.body);
    res.json(await agentRunsService.saveTranscript(req.params.id, input));
  }),
);

agentRunsRouter.get(
  '/agent-runs/:id/transcript',
  asyncHandler(async (req, res) => {
    const transcript = await agentRunsService.getTranscript(req.params.id);
    if (!transcript) throw new NotFoundError('transcript');
    res.json(transcript);
  }),
);

// The ticket drawer's "Runs" list (ROAD-56). Under /tickets so it reads as
// a property of the ticket; it is the same rows GET /agent-runs?ticketId=
// would page through, unpaged because a ticket's runs are a handful.
agentRunsRouter.get(
  '/tickets/:id/agent-runs',
  asyncHandler(async (req, res) => {
    res.json(await agentRunsService.listRunsForTicket(req.params.id));
  }),
);

// W5a (ROAD-117): a proposal Waypoint main files on a run's behalf — the
// agent's closing message as a comment, or the state change Fix asks for.
// Lands in Review with origin agent_run; the agent itself never calls this.
agentRunsRouter.post(
  '/agent-runs/:id/proposals',
  asyncHandler(async (req, res) => {
    const input = createRunProposalSchema.parse(req.body);
    const payload = input.kind === 'comment' ? { body: input.body } : { stateId: input.stateId };
    res.status(201).json(
      await proposalsService.createRunProposal({ agentRunId: req.params.id, kind: input.kind, payload }),
    );
  }),
);
