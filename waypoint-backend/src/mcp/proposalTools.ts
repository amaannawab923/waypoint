import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as workItemsService from '../services/workItems.service.js';
import * as statesService from '../services/states.service.js';
import * as projectsService from '../services/projects.service.js';
import {
  createProposal,
  ProposalValidationError,
  type ProposalKind,
  type ProposalPayload,
  type ProposalSnapshot,
} from '../services/proposals.service.js';
import { resolveActorNames } from '../lib/actorNames.js';
import { PRIORITY, ISO_DATE, jsonResult, notFoundResult, withErrorSafetyNet } from './workItemTools.js';

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
  workItemId: string | null;
  payload: ProposalPayload;
  snapshot: ProposalSnapshot;
  summary: string;
}) {
  try {
    const row = await createProposal({
      conversationId: input.conversationId,
      kind: input.kind,
      workItemId: input.workItemId,
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
    throw error;
  }
}

// Same draft-hiding requirement as workItemTools's get/list handlers: a
// draft is invisible to every read tool, so proposing against one must read
// as a plain miss, not confirm its existence.
async function getVisibleWorkItem(workItemId: string) {
  const item = await workItemsService.getWorkItem(workItemId);
  if (!item || item.isDraft) return undefined;
  return item;
}

function baseSnapshot(item: { identifier: string; title: string; updatedAt: Date }) {
  return {
    identifier: item.identifier,
    title: item.title,
    itemUpdatedAt: item.updatedAt.toISOString(),
  };
}

export async function proposeCommentHandler(
  conversationId: string | null,
  { workItemId, body }: { workItemId: string; body: string },
) {
  if (!conversationId) return validationErrorResult(UNAVAILABLE_MESSAGE);
  const item = await getVisibleWorkItem(workItemId);
  if (!item) return notFoundResult('work item');
  return submitProposal({
    conversationId,
    kind: 'comment',
    workItemId,
    payload: { body },
    snapshot: baseSnapshot(item),
    summary: `Proposed: comment on ${item.identifier}`,
  });
}

export async function proposeStateChangeHandler(
  conversationId: string | null,
  { workItemId, stateId }: { workItemId: string; stateId: string },
) {
  if (!conversationId) return validationErrorResult(UNAVAILABLE_MESSAGE);
  const item = await getVisibleWorkItem(workItemId);
  if (!item) return notFoundResult('work item');
  // Project-scoping check updateWorkItem itself lacks: its stateId column
  // FK only proves the state EXISTS, not that it belongs to this ticket's
  // project — approving a cross-project state would corrupt the board.
  const states = await statesService.listStates(item.projectId);
  const toState = states.find((s) => s.id === stateId);
  if (!toState) {
    return validationErrorResult(
      "That state does not belong to this ticket's project — use list_states with the ticket's projectId to find a valid one.",
    );
  }
  if (stateId === item.stateId) {
    return validationErrorResult(
      `This ticket is already in ${toState.name} — there is no change to propose.`,
    );
  }
  const fromState = states.find((s) => s.id === item.stateId);
  return submitProposal({
    conversationId,
    kind: 'state_change',
    workItemId,
    payload: { stateId },
    snapshot: {
      ...baseSnapshot(item),
      fromStateId: item.stateId,
      fromStateName: fromState?.name ?? item.stateId,
      fromStateColor: fromState?.color ?? null,
      toStateName: toState.name,
      toStateColor: toState.color,
    },
    summary: `Proposed: move ${item.identifier} from ${fromState?.name ?? item.stateId} to ${toState.name}`,
  });
}

export async function proposeAssigneeChangeHandler(
  conversationId: string | null,
  { workItemId, assigneeId, action }: { workItemId: string; assigneeId: string; action: 'add' | 'remove' },
) {
  if (!conversationId) return validationErrorResult(UNAVAILABLE_MESSAGE);
  const item = await getVisibleWorkItem(workItemId);
  if (!item) return notFoundResult('work item');
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
    workItemId,
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
  { workItemId, priority }: { workItemId: string; priority: z.infer<typeof PRIORITY> },
) {
  if (!conversationId) return validationErrorResult(UNAVAILABLE_MESSAGE);
  const item = await getVisibleWorkItem(workItemId);
  if (!item) return notFoundResult('work item');
  if (priority === item.priority) {
    return validationErrorResult(
      `This ticket's priority is already ${priority} — there is no change to propose.`,
    );
  }
  return submitProposal({
    conversationId,
    kind: 'priority_change',
    workItemId,
    payload: { priority },
    snapshot: { ...baseSnapshot(item), fromPriority: item.priority },
    summary: `Proposed: change ${item.identifier} priority from ${item.priority} to ${priority}`,
  });
}

export async function proposeCreateWorkItemHandler(
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
  if (!project) return notFoundResult('project');
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
    kind: 'create_work_item',
    workItemId: null,
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

// Read tool, but registered here rather than workItemTools: it only exists
// to serve propose_create_work_item (the model needs a projectId, and V1's
// read set had no way to list projects). Projected to id/name/identifier —
// a project row carries config (automations, gradients, lead) that's noise
// in the model's context.
export async function listProjectsHandler() {
  const projects = await projectsService.listProjects();
  return jsonResult(projects.map(({ id, name, identifier }) => ({ id, name, identifier })));
}

// Every propose_* description repeats the same contract on purpose — the
// description is the one piece of text the model re-reads on every call, so
// it, not just the system prompt, carries the "this does not execute
// anything" invariant.
const PROPOSAL_CONTRACT =
  'This does NOT change anything: it creates a proposal the user must approve in the Waypoint UI. ' +
  'Never tell the user the change was made after calling this — say you proposed it and they must approve the card. ' +
  'The outcome (approved/rejected) arrives at the start of a later turn.';

export function registerProposalTools(server: McpServer, conversationId: string | null): void {
  server.registerTool(
    'propose_comment',
    {
      description:
        `Propose posting a comment on a work item (ticket) on the user's behalf. ${PROPOSAL_CONTRACT} ` +
        'Write the body as plain text (no markdown/HTML — it is escaped, not rendered). Waypoint automatically prefixes ' +
        'the posted comment with a Copilot self-disclosure line — do not write one yourself.',
      inputSchema: {
        workItemId: z.string(),
        body: z.string().trim().min(1).max(8000),
      },
    },
    withErrorSafetyNet('propose_comment', (args: { workItemId: string; body: string }) =>
      proposeCommentHandler(conversationId, args),
    ),
  );

  server.registerTool(
    'propose_state_change',
    {
      description: `Propose moving a work item (ticket) to a different workflow state. ${PROPOSAL_CONTRACT} Use list_states with the ticket's projectId to find valid state ids.`,
      inputSchema: {
        workItemId: z.string(),
        stateId: z.string().describe("The target state's id — must belong to the ticket's own project."),
      },
    },
    withErrorSafetyNet('propose_state_change', (args: { workItemId: string; stateId: string }) =>
      proposeStateChangeHandler(conversationId, args),
    ),
  );

  server.registerTool(
    'propose_assignee_change',
    {
      description: `Propose adding or removing one assignee on a work item (ticket). ${PROPOSAL_CONTRACT} Use list_members to find assignee ids.`,
      inputSchema: {
        workItemId: z.string(),
        assigneeId: z.string(),
        action: z.enum(['add', 'remove']),
      },
    },
    withErrorSafetyNet(
      'propose_assignee_change',
      (args: { workItemId: string; assigneeId: string; action: 'add' | 'remove' }) =>
        proposeAssigneeChangeHandler(conversationId, args),
    ),
  );

  server.registerTool(
    'propose_priority_change',
    {
      description: `Propose changing a work item (ticket)'s priority. ${PROPOSAL_CONTRACT}`,
      inputSchema: {
        workItemId: z.string(),
        priority: PRIORITY,
      },
    },
    withErrorSafetyNet(
      'propose_priority_change',
      (args: { workItemId: string; priority: z.infer<typeof PRIORITY> }) =>
        proposePriorityChangeHandler(conversationId, args),
    ),
  );

  server.registerTool(
    'propose_create_work_item',
    {
      description:
        `Propose creating a new work item (ticket) in a project. ${PROPOSAL_CONTRACT} ` +
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
      'propose_create_work_item',
      (args: {
        projectId: string;
        title: string;
        description?: string;
        stateId?: string;
        priority?: z.infer<typeof PRIORITY>;
        assigneeIds?: string[];
        dueDate?: string;
      }) => proposeCreateWorkItemHandler(conversationId, args),
    ),
  );

  server.registerTool(
    'list_projects',
    {
      description:
        'List the projects in the workspace (id, name, identifier). Use this to find a projectId for propose_create_work_item or to scope other tools.',
      inputSchema: {},
    },
    withErrorSafetyNet('list_projects', listProjectsHandler),
  );
}
