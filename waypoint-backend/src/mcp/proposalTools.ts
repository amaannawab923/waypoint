import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as ticketsService from '../services/tickets.service.js';
import * as statesService from '../services/states.service.js';
import * as projectsService from '../services/projects.service.js';
import {
  createProposal,
  ProposalValidationError,
  type ProposalKind,
  type ProposalPayload,
  type ProposalSnapshot,
} from '../services/proposals.service.js';
import { NotFoundError } from '../middleware/errors.js';
import { resolveActorNames } from '../lib/actorNames.js';
import type { JiraCredential } from '../lib/jira/client.js';
import { nativeProvider } from '../providers/native.js';
import { getJiraProvider, isExternalRef, type JiraProvider } from '../providers/jira.js';
import type { NormalizedTicket } from '../providers/types.js';
import {
  PRIORITY,
  ISO_DATE,
  JIRA_NOT_CONNECTED,
  jsonResult,
  notFoundResult,
  withErrorSafetyNet,
  LIMIT_SCHEMA,
  resolveLimit,
  page,
} from './ticketTools.js';

// Same per-request shape (and same meaning of null) the read tools use — see
// ticketTools.ts's own note on why this is a parameter rather than a lookup.
// Nothing here writes through it: a propose tool reads Jira to confirm what
// it is about to describe, and the write waits for an Approve click.
type Jira = JiraProvider | null;

// Model-actionable validation failure — same result shape as
// notFoundResult, but with a message specific enough for the model to
// correct itself (wrong project's state, no-op change, cap hit) instead of
// the generic scrub withErrorSafetyNet applies to genuine internal errors.
function validationErrorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// Every propose handler starts here: without a validated conversation id
// (delivered only via the x-waypoint-conversation-id header the app itself
// injects into --mcp-config — never via tool input, so the model can't
// supply one) there is no conversation to attach a proposal row to. Read
// tools are unaffected; only proposing is disabled.
const UNAVAILABLE_MESSAGE = 'Proposals are unavailable in this session.';

// Shared submit tail for every propose handler: persist the row (mapping
// the service's cap/validation throws to a model-readable error) and shape
// the tool result. `status: 'pending_user_approval'` is load-bearing prompt
// material — it's what the system prompt tells the model a proposal means.
async function submitProposal(input: {
  conversationId: string;
  kind: ProposalKind;
  ticketId: string | null;
  payload: ProposalPayload;
  snapshot: ProposalSnapshot;
  summary: string;
}) {
  try {
    const row = await createProposal({
      conversationId: input.conversationId,
      kind: input.kind,
      ticketId: input.ticketId,
      payload: input.payload,
      snapshot: input.snapshot,
    });
    return jsonResult({
      proposalId: row.id,
      status: 'pending_user_approval',
      summary: `${input.summary} — awaiting user approval`,
    });
  } catch (error) {
    if (error instanceof ProposalValidationError) return validationErrorResult(error.message);
    // createProposal throws NotFoundError('conversation') when the
    // conversation row is gone (its own comment: intended to "404-shape
    // fail"). Without this mapping it fell through to withErrorSafetyNet's
    // generic scrub and came back as an opaque internal-error message.
    if (error instanceof NotFoundError) return notFoundResult('conversation');
    throw error;
  }
}

// Same draft-hiding requirement as ticketTools's get/list handlers: a
// draft is invisible to every read tool, so proposing against one must read
// as a plain miss, not confirm its existence.
//
// Still native-only, and still used by the three kinds that are native-only:
// assignee, priority and create-ticket. Those need columns that are this
// app's own (a member id, this app's priority vocabulary, a project's default
// state), which is why they are not part of the Jira write path — see
// refuseExternal below for how a Jira id reaching them is answered.
async function getVisibleTicket(ticketId: string) {
  const item = await ticketsService.getTicket(ticketId);
  if (!item || item.isDraft) return undefined;
  return item;
}

/**
 * The ticket a proposal targets, whichever system it lives in.
 *
 * Dispatches on the id's own prefix, exactly as the read tools do (see
 * getTicketHandler): a "tref-" id can only have come from a ticket_refs row,
 * so no lookup is needed to know which provider owns it. The native branch
 * goes through nativeProvider.getByRef rather than ticketsService directly —
 * that wrapper already carries the draft gate and the batched name/state
 * resolution, and a second copy of the draft rule here is exactly the kind of
 * duplicate that goes stale.
 *
 * The three outcomes are kept apart because they mean different things to the
 * model: 'missing' is a real miss, 'jira_off' is a configuration fact ("there
 * is no second place to look"), and only 'found' carries a ticket.
 */
type TargetLookup =
  | { status: 'found'; ticket: NormalizedTicket }
  | { status: 'missing' }
  | { status: 'jira_off' };

async function resolveTarget(jira: Jira, ticketId: string): Promise<TargetLookup> {
  if (isExternalRef(ticketId)) {
    if (!jira) return { status: 'jira_off' };
    const ticket = await jira.getByRef(ticketId);
    return ticket ? { status: 'found', ticket } : { status: 'missing' };
  }
  const ticket = await nativeProvider.getByRef(ticketId);
  return ticket ? { status: 'found', ticket } : { status: 'missing' };
}

/**
 * The three proposal kinds that have no Jira implementation, answered as what
 * they are.
 *
 * A plain not-found would be a lie with a plausible shape: the issue exists,
 * the model just asked for something this integration cannot do. Told that,
 * the model stops; told "no such ticket", it retries the lookup and asks
 * again.
 */
function refuseExternal(what: string) {
  return validationErrorResult(
    `${what} is not supported for Jira issues yet — only comments and state changes can be proposed against Jira. ` +
      'Tell the user this has to be done in Jira directly.',
  );
}

/**
 * The updated-at stamp, from whichever provider's detail record carries it.
 *
 * Native tickets hand back a Date (the column, spread straight through by
 * providers/native.ts's passthrough detail projection); Jira hands back the
 * ISO string its API returned. Normalizing here keeps the snapshot's
 * itemUpdatedAt byte-identical to what the native path has always written.
 */
function updatedAtIso(ticket: NormalizedTicket): string | undefined {
  const raw = ticket.detail?.updatedAt;
  if (raw instanceof Date) return raw.toISOString();
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * The three fields every proposal card renders regardless of kind.
 *
 * Takes either a normalized ticket (the provider-dispatched path) or a raw
 * native row (the three native-only kinds, which never reach a provider).
 * One function rather than two, because the card reads this shape uniformly
 * and two producers of it is how the two would drift.
 *
 * `'provider' in item` is a safe discriminant: it is required on
 * NormalizedTicket and does not exist on a native ticket row.
 */
function baseSnapshot(item: NormalizedTicket | ticketsService.Enriched) {
  return {
    identifier: item.identifier,
    title: item.title,
    itemUpdatedAt: 'provider' in item ? updatedAtIso(item) : item.updatedAt.toISOString(),
  };
}

/**
 * What the approval card has to say before anyone clicks Approve on a write
 * that leaves Waypoint: which system, which site, which issue, as whom, and
 * who finds out.
 *
 * Every field is display-only. `provider` in particular decides nothing —
 * executeProposal re-resolves a ticket's real provider from its own id and
 * refuses to run if the two disagree, precisely so that a snapshot written at
 * propose time can never be what routes a write.
 */
function externalSnapshot(jira: JiraProvider, ticket: NormalizedTicket) {
  return {
    provider: 'jira',
    externalSite: jira.site,
    externalUrl: ticket.url,
    externalActorName: jira.actorName,
    // Deliberately a description of Jira's behavior rather than a computed
    // list of people. Jira decides who is notified from the issue's watchers,
    // its assignee and the site's own notification scheme — resolving that
    // truthfully would be an extra round trip per proposal (and still only a
    // snapshot of it), while getting it subtly wrong would be worse than
    // saying plainly what Jira does. The honest general sentence is the right
    // trade here; a real recipient list is a later decision, not a cheaper
    // one.
    externalNotifiesLabel:
      "the issue's watchers and assignee will be notified, per your Jira notification scheme",
  };
}

export async function proposeCommentHandler(
  jira: Jira,
  conversationId: string | null,
  { ticketId, body }: { ticketId: string; body: string },
) {
  if (!conversationId) return validationErrorResult(UNAVAILABLE_MESSAGE);
  const found = await resolveTarget(jira, ticketId);
  if (found.status === 'jira_off') return validationErrorResult(JIRA_NOT_CONNECTED);
  if (found.status === 'missing') return notFoundResult('ticket');
  const { ticket } = found;

  const external = ticket.provider === 'jira' && jira ? externalSnapshot(jira, ticket) : {};
  return submitProposal({
    conversationId,
    kind: 'comment',
    ticketId,
    payload: { body },
    snapshot: { ...baseSnapshot(ticket), ...external },
    summary: `Proposed: comment on ${ticket.identifier}`,
  });
}

export async function proposeStateChangeHandler(
  jira: Jira,
  conversationId: string | null,
  { ticketId, stateId }: { ticketId: string; stateId: string },
) {
  if (!conversationId) return validationErrorResult(UNAVAILABLE_MESSAGE);
  const found = await resolveTarget(jira, ticketId);
  if (found.status === 'jira_off') return validationErrorResult(JIRA_NOT_CONNECTED);
  if (found.status === 'missing') return notFoundResult('ticket');
  const { ticket } = found;

  if (ticket.provider === 'jira') {
    if (!jira) return validationErrorResult(JIRA_NOT_CONNECTED);
    return proposeJiraTransition(jira, conversationId, ticket, ticketId, stateId);
  }

  // Project-scoping check updateTicket itself lacks: its stateId column
  // FK only proves the state EXISTS, not that it belongs to this ticket's
  // project — approving a cross-project state would corrupt the board.
  const states = await statesService.listStates(ticket.projectId);
  const toState = states.find((s) => s.id === stateId);
  if (!toState) {
    return validationErrorResult(
      "That state does not belong to this ticket's project — use list_states with the ticket's projectId to find a valid one.",
    );
  }
  if (stateId === ticket.stateId) {
    return validationErrorResult(
      `This ticket is already in ${toState.name} — there is no change to propose.`,
    );
  }
  const fromState = states.find((s) => s.id === ticket.stateId);
  return submitProposal({
    conversationId,
    kind: 'state_change',
    ticketId,
    payload: { stateId },
    snapshot: {
      ...baseSnapshot(ticket),
      fromStateId: ticket.stateId,
      fromStateName: fromState?.name ?? ticket.stateId,
      fromStateColor: fromState?.color ?? null,
      toStateName: toState.name,
      toStateColor: toState.color,
    },
    summary: `Proposed: move ${ticket.identifier} from ${fromState?.name ?? ticket.stateId} to ${toState.name}`,
  });
}

/**
 * The Jira half of propose_state_change.
 *
 * The `stateId` the model passes is a TRANSITION id here, not a status id,
 * and it is checked against the issue's live transition list rather than
 * accepted on trust. That check is doing two jobs at once:
 *
 *  - it stops the model guessing. A Jira transition id is a small integer
 *    ("31"), which is exactly the shape a model will happily invent; without
 *    this, an invented id would sit in a proposal until someone approved it
 *    and Jira answered 400. Refused here, with the tool to call instead
 *    named, the model can correct itself on the next turn.
 *  - it makes the snapshot honest. `toStateName` on the card is the
 *    transition's own label as this site spells it, read live, not a name the
 *    model supplied.
 *
 * There is no "already in that state" refusal to mirror the native branch's.
 * A transition is not a status, and a legal Jira workflow can offer one that
 * lands on the status the issue is already in — so refusing that would refuse
 * something real. `fromStateId` still records the issue's current status id,
 * which is what lets checkStaleness notice somebody else moved it.
 */
async function proposeJiraTransition(
  jira: JiraProvider,
  conversationId: string,
  ticket: NormalizedTicket,
  ticketId: string,
  transitionId: string,
) {
  const transitions = await jira.listTransitions(ticketId);
  if (!transitions) return notFoundResult('ticket');
  const target = transitions.find((t) => t.id === transitionId);
  if (!target) {
    const available = transitions.length
      ? `Available right now: ${transitions.map((t) => `${t.name} (${t.id})`).join(', ')}.`
      : 'This issue currently has no transitions available to the connected account.';
    return validationErrorResult(
      `"${transitionId}" is not a transition this Jira issue can make right now. ` +
        `Call list_states with ticketId="${ticketId}" to see what is actually available — ` +
        'Jira transitions depend on the issue\'s current status and can change between turns. ' +
        available,
    );
  }
  return submitProposal({
    conversationId,
    kind: 'state_change',
    ticketId,
    payload: { stateId: transitionId },
    snapshot: {
      ...baseSnapshot(ticket),
      // The issue's live STATUS id, not the transition's — this is the value
      // checkStaleness re-reads to tell whether the issue moved underneath
      // the proposal.
      fromStateId: ticket.stateId,
      fromStateName: ticket.stateName,
      // Jira status colors are per-site theme data this process does not
      // fetch; null renders as the card's neutral dot rather than a guess.
      fromStateColor: null,
      toStateName: target.name,
      toStateColor: null,
      ...externalSnapshot(jira, ticket),
    },
    summary: `Proposed: move ${ticket.identifier} from ${ticket.stateName} to ${target.name}`,
  });
}

export async function proposeAssigneeChangeHandler(
  conversationId: string | null,
  { ticketId, assigneeId, action }: { ticketId: string; assigneeId: string; action: 'add' | 'remove' },
) {
  if (!conversationId) return validationErrorResult(UNAVAILABLE_MESSAGE);
  if (isExternalRef(ticketId)) return refuseExternal('Changing the assignee');
  const item = await getVisibleTicket(ticketId);
  if (!item) return notFoundResult('ticket');
  // The proposed assignee AND the item's current assignees resolve in one
  // batched lookup — the card shows the ticket's current assignment as
  // context ("currently: Lena"), and building that from ids at render time
  // would either leak raw ids or cost the renderer an extra round trip.
  // Found in QA: showing only the proposed person's own wasAssigned flag
  // read as if it described the whole ticket ("currently unassigned" on a
  // ticket that had an assignee), misleading exactly the person deciding
  // whether to approve.
  const names = await resolveActorNames([assigneeId, ...item.assigneeIds]);
  const assigneeName = names.get(assigneeId);
  if (!assigneeName) return notFoundResult('assignee');
  const currentAssigneeNames = item.assigneeIds.map((id) => names.get(id) ?? id);
  // Direction pre-check (re-checked authoritatively at approve): the
  // underlying service is a TOGGLE, so a directionless proposal against the
  // wrong current state would silently do the opposite of what the card says.
  const wasAssigned = item.assigneeIds.includes(assigneeId);
  if (action === 'add' && wasAssigned) {
    return validationErrorResult(`${assigneeName} is already assigned to ${item.identifier}.`);
  }
  if (action === 'remove' && !wasAssigned) {
    return validationErrorResult(`${assigneeName} is not assigned to ${item.identifier}.`);
  }
  return submitProposal({
    conversationId,
    kind: 'assignee_change',
    ticketId,
    payload: { assigneeId, action },
    snapshot: { ...baseSnapshot(item), assigneeName, wasAssigned, currentAssigneeNames },
    summary:
      action === 'add'
        ? `Proposed: assign ${assigneeName} to ${item.identifier}`
        : `Proposed: unassign ${assigneeName} from ${item.identifier}`,
  });
}

export async function proposePriorityChangeHandler(
  conversationId: string | null,
  { ticketId, priority }: { ticketId: string; priority: z.infer<typeof PRIORITY> },
) {
  if (!conversationId) return validationErrorResult(UNAVAILABLE_MESSAGE);
  if (isExternalRef(ticketId)) return refuseExternal('Changing the priority');
  const item = await getVisibleTicket(ticketId);
  if (!item) return notFoundResult('ticket');
  if (priority === item.priority) {
    return validationErrorResult(
      `This ticket's priority is already ${priority} — there is no change to propose.`,
    );
  }
  return submitProposal({
    conversationId,
    kind: 'priority_change',
    ticketId,
    payload: { priority },
    snapshot: { ...baseSnapshot(item), fromPriority: item.priority },
    summary: `Proposed: change ${item.identifier} priority from ${item.priority} to ${priority}`,
  });
}

export async function proposeCreateTicketHandler(
  conversationId: string | null,
  {
    projectId,
    title,
    description,
    stateId,
    priority,
    assigneeIds,
    dueDate,
  }: {
    projectId: string;
    title: string;
    description?: string;
    stateId?: string;
    priority?: z.infer<typeof PRIORITY>;
    assigneeIds?: string[];
    dueDate?: string;
  },
) {
  if (!conversationId) return validationErrorResult(UNAVAILABLE_MESSAGE);
  const project = await projectsService.getProject(projectId);
  // getProject (unlike listProjects, used by list_projects) has no archived
  // filter — an archived project must still read as not-found here, same as
  // getVisibleTicket hides drafts, so Copilot can't create a real ticket in
  // a project no UI list ever surfaces again.
  if (!project || project.archivedAt) return notFoundResult('project');
  const states = await statesService.listStates(projectId);
  // The stored payload always carries a CONCRETE stateId — resolving the
  // default here (not at approve time) means the card can show the real
  // state the ticket will land in, and approve only has to re-verify it.
  let resolvedState;
  if (stateId) {
    resolvedState = states.find((s) => s.id === stateId);
    if (!resolvedState) {
      return validationErrorResult(
        'That state does not belong to this project — use list_states to find a valid one, or omit stateId to use the default.',
      );
    }
  } else {
    // listStates returns board order (sortOrder asc), so the first
    // backlog/unstarted state is the project's natural default landing spot.
    resolvedState = states.find((s) => s.group === 'backlog' || s.group === 'unstarted');
    if (!resolvedState) {
      return validationErrorResult(
        'This project has no backlog or unstarted state to default to — pass a stateId explicitly.',
      );
    }
  }
  let assigneeNames: string[] = [];
  if (assigneeIds?.length) {
    const names = await resolveActorNames(assigneeIds);
    const unknown = assigneeIds.filter((id) => !names.has(id));
    if (unknown.length) {
      return validationErrorResult(`unknown assignee id(s): ${unknown.join(', ')} — use list_members to find valid ids.`);
    }
    assigneeNames = assigneeIds.map((id) => names.get(id) as string);
  }
  return submitProposal({
    conversationId,
    kind: 'create_ticket',
    ticketId: null,
    payload: {
      projectId,
      title,
      ...(description !== undefined ? { description } : {}),
      stateId: resolvedState.id,
      ...(priority !== undefined ? { priority } : {}),
      ...(assigneeIds?.length ? { assigneeIds } : {}),
      ...(dueDate !== undefined ? { dueDate } : {}),
    },
    snapshot: {
      projectName: project.name,
      projectIdentifier: project.identifier,
      stateName: resolvedState.name,
      stateColor: resolvedState.color,
      assigneeNames,
    },
    summary: `Proposed: create "${title}" in ${project.name}`,
  });
}

// Read tool, but registered here rather than ticketTools: it only exists
// to serve propose_create_ticket (the model needs a projectId, and V1's
// read set had no way to list projects). Projected to id/name/identifier —
// a project row carries config (automations, gradients, lead) that's noise
// in the model's context.
//
// Naturally bounded by however many projects exist in the workspace — lower
// severity than list_sprints' own unbounded-fan-out problem — but capped the
// same way for consistency with every other list-style MCP tool, and because
// projectsService.listProjects() is not cheap per row: each project's
// primitiveCounts (sprints/workstreams/views/docs/requests) comes from five
// grouped-count subqueries joined onto the projects table, work an unbounded
// caller has no way to avoid paying for on a workspace with many projects.
export async function listProjectsHandler({ limit }: { limit?: number } = {}) {
  const effectiveLimit = resolveLimit(limit);
  const rows = await projectsService.listProjects(effectiveLimit + 1);
  const { items, truncated } = page(rows, effectiveLimit);
  return jsonResult({
    items: items.map(({ id, name, identifier }) => ({ id, name, identifier })),
    truncated,
  });
}

// Every propose_* description repeats the same contract on purpose — the
// description is the one piece of text the model re-reads on every call, so
// it, not just the system prompt, carries the "this does not execute
// anything" invariant.
const PROPOSAL_CONTRACT =
  'This does NOT change anything: it creates a proposal the user must approve in the Waypoint UI. ' +
  'Never tell the user the change was made after calling this — say you proposed it and they must approve the card. ' +
  'The outcome (approved/rejected) arrives at the start of a later turn.';

// The extra contract that applies only to a ticket living in another system.
// Repeated in the two tool descriptions that can reach one, for the same
// reason PROPOSAL_CONTRACT is: the description is the text the model re-reads
// on every call.
const EXTERNAL_CONTRACT =
  'This also works on a Jira issue (an id starting with "tref-"). Approving one writes to the real Jira, ' +
  "under the connected Jira account's name, where the issue's watchers are notified — say so when you propose it, " +
  'and never imply it can be undone afterwards.';

export function registerProposalTools(
  server: McpServer,
  conversationId: string | null,
  jiraCredential: JiraCredential | null,
): void {
  // Resolved once per server — which is once per request, see mcp/server.ts.
  // Construction does no I/O, and doing it here means every handler below
  // sees one Jira for the whole request rather than each re-deriving it.
  const jira = getJiraProvider(jiraCredential);

  server.registerTool(
    'propose_comment',
    {
      description:
        `Propose posting a comment on a ticket on the user's behalf. ${PROPOSAL_CONTRACT} ` +
        'Write the body as plain text (no markdown/HTML — it is escaped, not rendered). Waypoint automatically prefixes ' +
        `the posted comment with a Copilot self-disclosure line — do not write one yourself. ${EXTERNAL_CONTRACT}`,
      inputSchema: {
        ticketId: z.string(),
        body: z.string().trim().min(1).max(8000),
      },
    },
    withErrorSafetyNet('propose_comment', (args: { ticketId: string; body: string }) =>
      proposeCommentHandler(jira, conversationId, args),
    ),
  );

  server.registerTool(
    'propose_state_change',
    {
      description:
        `Propose moving a ticket to a different workflow state. ${PROPOSAL_CONTRACT} ` +
        "For a Waypoint ticket, use list_states with the ticket's projectId to find valid state ids. " +
        'For a Jira issue, use list_states with that ticket\'s id: Jira takes a TRANSITION id, which is only valid for that issue right now — ' +
        `read it immediately before proposing rather than reusing one from earlier in the conversation. ${EXTERNAL_CONTRACT}`,
      inputSchema: {
        ticketId: z.string(),
        stateId: z
          .string()
          .describe(
            "For a Waypoint ticket: the target state's id, which must belong to the ticket's own project. " +
              "For a Jira issue: a transition id from list_states with that issue's ticketId.",
          ),
      },
    },
    withErrorSafetyNet('propose_state_change', (args: { ticketId: string; stateId: string }) =>
      proposeStateChangeHandler(jira, conversationId, args),
    ),
  );

  server.registerTool(
    'propose_assignee_change',
    {
      description: `Propose adding or removing one assignee on a ticket. ${PROPOSAL_CONTRACT} Use list_members to find assignee ids.`,
      inputSchema: {
        ticketId: z.string(),
        assigneeId: z.string(),
        action: z.enum(['add', 'remove']),
      },
    },
    withErrorSafetyNet(
      'propose_assignee_change',
      (args: { ticketId: string; assigneeId: string; action: 'add' | 'remove' }) =>
        proposeAssigneeChangeHandler(conversationId, args),
    ),
  );

  server.registerTool(
    'propose_priority_change',
    {
      description: `Propose changing a ticket's priority. ${PROPOSAL_CONTRACT}`,
      inputSchema: {
        ticketId: z.string(),
        priority: PRIORITY,
      },
    },
    withErrorSafetyNet(
      'propose_priority_change',
      (args: { ticketId: string; priority: z.infer<typeof PRIORITY> }) =>
        proposePriorityChangeHandler(conversationId, args),
    ),
  );

  server.registerTool(
    'propose_create_ticket',
    {
      description:
        `Propose creating a new ticket in a project. ${PROPOSAL_CONTRACT} ` +
        'Use list_projects to find a projectId. If stateId is omitted, the project\'s first backlog/unstarted state is used.',
      inputSchema: {
        projectId: z.string(),
        title: z.string().trim().min(1).max(255),
        description: z.string().max(20_000).optional(),
        stateId: z.string().optional(),
        priority: PRIORITY.optional(),
        assigneeIds: z.array(z.string()).max(10).optional(),
        dueDate: ISO_DATE.optional(),
      },
    },
    withErrorSafetyNet(
      'propose_create_ticket',
      (args: {
        projectId: string;
        title: string;
        description?: string;
        stateId?: string;
        priority?: z.infer<typeof PRIORITY>;
        assigneeIds?: string[];
        dueDate?: string;
      }) => proposeCreateTicketHandler(conversationId, args),
    ),
  );

  server.registerTool(
    'list_projects',
    {
      description:
        'List the projects in the workspace (id, name, identifier). Use this to find a projectId for propose_create_ticket or to scope other tools. ' +
        'Results are capped (see limit) — check the truncated flag and narrow the query if it comes back true.',
      inputSchema: { limit: LIMIT_SCHEMA },
    },
    withErrorSafetyNet('list_projects', listProjectsHandler),
  );
}
