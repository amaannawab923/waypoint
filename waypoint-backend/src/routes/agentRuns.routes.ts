import { Router } from 'express';
import { JIRA_CREDENTIAL_HEADER, parseJiraCredentialHeader } from '../lib/jira/credentialHeader.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { NotFoundError } from '../middleware/errors.js';
import { currentMemberId } from '../lib/requestContext.js';
import * as agentRunsService from '../services/agentRuns.service.js';
import * as pendingPromptsService from '../services/pendingPrompts.service.js';
import * as proposalsService from '../services/proposals.service.js';
import {
  appendAgentRunEventSchema,
  claimPublishSchema,
  createAgentRunSchema,
  createPendingPromptSchema,
  createRunProposalSchema,
  listAgentRunEventsQuerySchema,
  listAgentRunsQuerySchema,
  listWorkedOnJiraKeysQuerySchema,
  reopenAgentRunSchema,
  saveAgentRunTranscriptSchema,
  updateAgentRunSchema,
  updatePendingPromptSchema,
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

// ROAD-158: the Worked-on tab. Registered ahead of GET /agent-runs/:id —
// Express matches route order, and 'worked-on-jira-keys' would otherwise be
// read as an :id and 404 from getRun instead of ever reaching this handler.
agentRunsRouter.get(
  '/agent-runs/worked-on-jira-keys',
  asyncHandler(async (req, res) => {
    const { site } = listWorkedOnJiraKeysQuerySchema.parse(req.query);
    res.json(await agentRunsService.listWorkedOnJiraTickets(currentMemberId(), site));
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
    // AT11 (ROAD-146) fifth review round: updateRun itself can't carry
    // this check — it's also reached from proposals.service.ts's
    // settleRunIfDecided, including a request-less expiry sweep that
    // legitimately settles runs across every workspace — so the guard
    // lives here, at the one call site that's always a real request.
    await agentRunsService.assertRunInWorkspace(req.params.id);
    res.json(await agentRunsService.updateRun(req.params.id, patch));
  }),
);

// Continue a run that is not live. Deliberately not PATCH — see
// reopenRun's own doc comment for why this is a scoped verb rather than a
// wider write to the general route, and why the workspace check lives
// inside the service's own transaction instead of here (unlike PATCH
// above, reopenRun has no request-less caller to make an exception for).
agentRunsRouter.post(
  '/agent-runs/:id/reopen',
  asyncHandler(async (req, res) => {
    const { reason } = reopenAgentRunSchema.parse(req.body ?? {});
    res.json(await agentRunsService.reopenRun(req.params.id, reason));
  }),
);

// Never-lock: one publisher per ticket at publish time. A 409 names the
// writer that holds it; the host files its comment unpublished.
agentRunsRouter.post(
  '/agent-runs/:id/publish-claim',
  asyncHandler(async (req, res) => {
    const { headSha } = claimPublishSchema.parse(req.body ?? {});
    res.json(await agentRunsService.claimPublish(req.params.id, headSha ?? null));
  }),
);

// Never-lock: the per-run outbox (pendingPrompts.service.ts).
agentRunsRouter.get(
  '/agent-runs/:id/pending-prompts',
  asyncHandler(async (req, res) => {
    res.json(await pendingPromptsService.listPendingPrompts(req.params.id));
  }),
);
agentRunsRouter.post(
  '/agent-runs/:id/pending-prompts',
  asyncHandler(async (req, res) => {
    const input = createPendingPromptSchema.parse(req.body);
    res.status(201).json(await pendingPromptsService.createPendingPrompt(req.params.id, input));
  }),
);
agentRunsRouter.patch(
  '/agent-runs/:id/pending-prompts/:ppId',
  asyncHandler(async (req, res) => {
    const input = updatePendingPromptSchema.parse(req.body);
    res.json(await pendingPromptsService.updatePendingPrompt(req.params.id, req.params.ppId, input));
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
// W5b: for a run on a Jira issue main attaches the borrowed credential
// header — the same seam an approve uses (lib/jira/credentialHeader.ts) —
// so the service can read the issue live and build the external-write
// card; absent on a native run, and ignored there when present.
agentRunsRouter.post(
  '/agent-runs/:id/proposals',
  asyncHandler(async (req, res) => {
    const input = createRunProposalSchema.parse(req.body);
    const payload = input.kind === 'comment' ? { body: input.body } : { stateId: input.stateId };
    res.status(201).json(
      await proposalsService.createRunProposal(
        { agentRunId: req.params.id, kind: input.kind, payload, groupId: input.groupId ?? null },
        parseJiraCredentialHeader(req.header(JIRA_CREDENTIAL_HEADER)),
      ),
    );
  }),
);
