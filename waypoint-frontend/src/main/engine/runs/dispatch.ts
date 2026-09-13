import {
  AUTO_APPROVE_MODE_ID,
  MAX_BRIEF_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  PLAN_MODE_ID,
  RUN_INTENTS,
  SUPPORTED_PROVIDERS,
  type BriefPreview,
  type BriefPreviewInput,
  type DispatchRunInput,
  type RunIntent,
  type SessionFolder,
} from '../types';
import { agentEnvFor } from './agentEnv';
import { briefTitle, buildBrief } from './briefs';
import { describeFolder } from './folders';
import {
  assertRunId,
  type AgentRun,
  type LedgerProposal,
} from './ledgerClient';
import {
  continueStart,
  ENGINE_NOT_RUNNING,
  listRunBranches,
  type StartRunDeps,
} from './startRun';
import { isRefSafeComponent, preferredBranchName } from './worktrees';

/**
 * Dispatching a session on a ticket — W5a, ROAD-119
 * (docs/design/w5a-investigate-fix.md §1.3, §2.2, §3.2).
 *
 * Two verbs over the same facts. `buildBriefPreview` is what the dialog
 * shows before anything starts: the brief (briefs.ts) built from the
 * ledger's view of the ticket, the repository the project links, its
 * branches, the mode the verb implies, and whether a writing session is
 * already live on the ticket. `dispatchTicketRun` is Start: it resolves
 * everything again from the ticket (the renderer sends ids and the edited
 * brief, never a path), writes the row with `entry: 'dispatched'`, and
 * hands the rest to W4's `continueStart` — a fresh worktree of the
 * repository on `agent/KEY`, the session in the verb's mode with the
 * brief as its first prompt, and for a writing session the scrubbed env
 * (agentEnv.ts).
 *
 * The mode is the intent (§2.1): Investigate is plan mode whatever else
 * is asked; Fix writes; *Something else…* is the switch. Auto-approve
 * only means anything for a writing session.
 */

export type DispatchDeps = StartRunDeps;

/** A run that still holds (or is about to hold) a session. */
const LIVE: ReadonlySet<AgentRun['status']> = new Set([
  'queued',
  'provisioning',
  'running',
  'blocked',
  'finishing',
]);

function isIntent(value: unknown): value is RunIntent {
  return (
    typeof value === 'string' &&
    (RUN_INTENTS as readonly string[]).includes(value)
  );
}

function cleanBaseRef(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    !value.split('/').every(isRefSafeComponent)
  ) {
    throw new Error('Choose a base branch.');
  }
  return value;
}

/** Plan mode (reads only) or a writing session, from the verb and the switch. */
export function modeFor(
  intent: RunIntent,
  mayChangeFiles: boolean | undefined,
): 'plan' | 'write' {
  if (intent === 'investigate') return 'plan';
  if (intent === 'fix') return 'write';
  return mayChangeFiles ? 'write' : 'plan';
}

/** The provider mode id a run with this verb, switch and auto-approve choice starts in. */
export function sessionModeIdFor(
  mode: 'plan' | 'write',
  autoApprove: boolean,
): string | null {
  if (mode === 'plan') return PLAN_MODE_ID;
  return autoApprove ? AUTO_APPROVE_MODE_ID : null;
}

/** The live writing run on the ticket, if any — one writer per ticket (§2.2). */
export function findLiveWriter(runs: AgentRun[]): AgentRun | null {
  return (
    runs.find(
      (r) =>
        r.entry === 'dispatched' &&
        LIVE.has(r.status) &&
        r.modeId !== PLAN_MODE_ID,
    ) ?? null
  );
}

/**
 * The approved root-cause comment from the ticket's latest Investigate:
 * an `agent_run`-origin comment proposal a person approved — `executed`
 * in the ledger's vocabulary (proposed → executing → executed; found on
 * the first live pass, there is no `approved` status) — whose run is an
 * Investigate on this ticket; the newest such by decision time (§1.9).
 */
const APPROVED_STATUSES: ReadonlySet<string> = new Set(['executed', 'approved']);

export function findApprovedRca(
  proposals: LedgerProposal[],
  runs: AgentRun[],
): { runId: string; body: string } | null {
  const investigates = new Set(
    runs.filter((r) => r.intent === 'investigate').map((r) => r.id),
  );
  const candidates = proposals
    .filter(
      (p) =>
        p.origin === 'agent_run' &&
        p.kind === 'comment' &&
        APPROVED_STATUSES.has(p.status) &&
        p.agentRunId !== null &&
        investigates.has(p.agentRunId) &&
        typeof p.payload?.body === 'string' &&
        (p.payload.body as string).trim().length > 0,
    )
    .sort((a, b) =>
      (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt),
    );
  const latest = candidates[0];
  return latest
    ? {
        runId: latest.agentRunId as string,
        body: latest.payload.body as string,
      }
    : null;
}

/** The branch an earlier, no longer live Fix left on the ticket, newest first. */
export function findPriorFixBranch(runs: AgentRun[]): string | null {
  const prior = runs
    .filter((r) => r.intent === 'fix' && !LIVE.has(r.status) && r.branch)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return prior[0]?.branch ?? null;
}

interface TicketContext {
  ticket: NonNullable<Awaited<ReturnType<StartRunDeps['ledger']['getTicket']>>>;
  repo: SessionFolder;
  branches: { branches: string[]; suggested: string | null };
  runs: AgentRun[];
}

/**
 * The ticket, its project's linked repository (as a folder the dialog can
 * show), the repository's branches, and the ticket's runs. Every refusal
 * a person can act on is a sentence: no such ticket, no linked
 * repository, the repository gone from this machine.
 */
async function ticketContext(
  deps: DispatchDeps,
  ticketId: string,
): Promise<TicketContext> {
  if (!deps.daemon()) throw new Error(ENGINE_NOT_RUNNING);
  const ticket = await deps.ledger.getTicket(ticketId);
  if (!ticket) throw new Error(`No ticket ${ticketId}.`);
  const project = await deps.ledger.getProject(ticket.projectId);
  if (!project)
    throw new Error(`${ticket.identifier}'s project no longer exists.`);
  if (!project.repoPath) {
    throw new Error(
      `${project.name} has no linked repository, so there is nothing for a session to work in. Link one in the project's Codebase settings, then try again.`,
    );
  }
  const repo = await describeFolder(deps.folders, project.repoPath);
  if (!repo) {
    throw new Error(
      `${project.name}'s linked repository is not a folder on this machine any more. Relink it in the project's Codebase settings.`,
    );
  }
  if (repo.kind !== 'repo') {
    throw new Error(`${repo.displayPath} is not a git repository.`);
  }
  const branches = await listRunBranches(deps, repo.handle);
  const runs = await deps.ledger.listAllRuns({ ticketId });
  return { ticket, repo, branches, runs };
}

function resolveBase(
  branches: { branches: string[]; suggested: string | null },
  requested: string | null,
  repo: SessionFolder,
): string {
  if (requested) {
    if (!branches.branches.includes(requested)) {
      throw new Error(
        `${requested} is not a local branch of ${repo.displayPath}.`,
      );
    }
    return requested;
  }
  if (!branches.suggested) {
    throw new Error(
      `${repo.displayPath} has no local branch to take a worktree from.`,
    );
  }
  return branches.suggested;
}

function validatePreviewInput(
  input: unknown,
): Required<Pick<BriefPreviewInput, 'ticketId' | 'intent'>> & {
  instructions: string | null;
  mayChangeFiles: boolean;
  baseRef: string | null;
} {
  if (!input || typeof input !== 'object')
    throw new Error('Not a preview request.');
  const raw = input as Record<string, unknown>;
  if (typeof raw.ticketId !== 'string') throw new Error('Choose a ticket.');
  assertRunId(raw.ticketId);
  if (!isIntent(raw.intent))
    throw new Error('Choose what the session should do.');
  let instructions: string | null = null;
  if (raw.instructions !== undefined && raw.instructions !== null) {
    if (typeof raw.instructions !== 'string')
      throw new Error('The instruction must be text.');
    instructions = raw.instructions.trim() || null;
    if (instructions && instructions.length > MAX_INSTRUCTIONS_CHARS) {
      throw new Error(
        `The instruction can be at most ${MAX_INSTRUCTIONS_CHARS} characters.`,
      );
    }
  }
  if (raw.intent === 'custom' && !instructions) {
    throw new Error('Say what the session should do.');
  }
  const mayChangeFiles = raw.mayChangeFiles === true;
  return {
    ticketId: raw.ticketId,
    intent: raw.intent,
    instructions,
    mayChangeFiles,
    baseRef: cleanBaseRef(raw.baseRef),
  };
}

/** The brief and the facts the preview dialog shows (§1.3). */
export async function buildBriefPreview(
  deps: DispatchDeps,
  rawInput: unknown,
): Promise<BriefPreview> {
  const input = validatePreviewInput(rawInput);
  const { ticket, repo, branches, runs } = await ticketContext(
    deps,
    input.ticketId,
  );
  const baseRef = resolveBase(branches, input.baseRef, repo);
  const mode = modeFor(input.intent, input.mayChangeFiles);

  const [comments, members, states, proposals] = await Promise.all([
    deps.ledger.listComments(ticket.id),
    deps.ledger.listMembers(),
    deps.ledger.listStates(ticket.projectId),
    input.intent === 'fix'
      ? deps.ledger.listTicketProposals(ticket.id)
      : Promise.resolve([] as LedgerProposal[]),
  ]);
  const rca = input.intent === 'fix' ? findApprovedRca(proposals, runs) : null;
  const liveWriter = mode === 'write' ? findLiveWriter(runs) : null;
  const branchHint = preferredBranchName(
    { id: 'run-preview', entry: 'dispatched' },
    ticket.identifier,
  );

  const brief = buildBrief({
    ticket,
    comments,
    members,
    stateName: states.find((s) => s.id === ticket.stateId)?.name ?? null,
    repoDisplayPath: repo.displayPath,
    branch: branchHint,
    baseRef,
    intent: input.intent,
    instructions: input.instructions,
    mayChangeFiles: mode === 'write',
    approvedRca: rca?.body ?? null,
    priorFixBranch: input.intent === 'fix' ? findPriorFixBranch(runs) : null,
  });

  return {
    ticketId: ticket.id,
    identifier: ticket.identifier,
    title: ticket.title,
    intent: input.intent,
    brief,
    repo,
    branches,
    baseRef,
    branchHint,
    mode,
    // The founder's default for a writing session is on, with the env
    // scrub as the guard (§2.5). SESS-36 is the live proof; if it fails on
    // the pinned daemon this flips to false until ROAD-88.
    autoApproveDefault: mode === 'write',
    seededFromRunId: rca?.runId ?? null,
    liveWriterRunId: liveWriter?.id ?? null,
  };
}

interface ValidatedDispatchInput {
  ticketId: string;
  intent: RunIntent;
  brief: string;
  mayChangeFiles: boolean;
  autoApprove: boolean;
  baseRef: string;
  ownerMemberId: string;
  providerId: DispatchRunInput['providerId'];
  copilotConversationId: string | null;
}

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function validateDispatchInput(input: unknown): ValidatedDispatchInput {
  if (!input || typeof input !== 'object')
    throw new Error('Not a dispatch request.');
  const raw = input as Record<string, unknown>;
  if (typeof raw.ticketId !== 'string') throw new Error('Choose a ticket.');
  assertRunId(raw.ticketId);
  if (!isIntent(raw.intent))
    throw new Error('Choose what the session should do.');
  if (typeof raw.brief !== 'string' || raw.brief.trim().length === 0) {
    throw new Error('The brief is empty.');
  }
  const brief = raw.brief.trim();
  if (brief.length > MAX_BRIEF_CHARS) {
    throw new Error(`The brief can be at most ${MAX_BRIEF_CHARS} characters.`);
  }
  if (typeof raw.autoApprove !== 'boolean') {
    throw new Error('Say whether the agent may work without asking.');
  }
  const baseRef = cleanBaseRef(raw.baseRef);
  if (!baseRef) throw new Error('Choose a base branch.');
  if (typeof raw.ownerMemberId !== 'string')
    throw new Error('No current member.');
  assertRunId(raw.ownerMemberId);
  if (
    typeof raw.providerId !== 'string' ||
    !(SUPPORTED_PROVIDERS as readonly string[]).includes(raw.providerId)
  ) {
    throw new Error(
      `Provider ${JSON.stringify(raw.providerId)} is not one Waypoint can start a session on.`,
    );
  }
  let copilotConversationId: string | null = null;
  if (
    raw.copilotConversationId !== undefined &&
    raw.copilotConversationId !== null
  ) {
    if (
      typeof raw.copilotConversationId !== 'string' ||
      !CONVERSATION_ID.test(raw.copilotConversationId)
    ) {
      throw new Error('Not a Copilot conversation id.');
    }
    copilotConversationId = raw.copilotConversationId;
  }
  return {
    ticketId: raw.ticketId,
    intent: raw.intent,
    brief,
    mayChangeFiles: raw.mayChangeFiles === true,
    autoApprove: raw.autoApprove,
    baseRef,
    ownerMemberId: raw.ownerMemberId,
    providerId: raw.providerId as DispatchRunInput['providerId'],
    copilotConversationId,
  };
}

/**
 * Start. Answers once the row is `provisioning`; the worktree and the
 * session follow in main through `continueStart`. Refuses before a row
 * is written: engine down, no such ticket, no linked repository, an
 * unknown base branch, a writing session already live on the ticket.
 */
export async function dispatchTicketRun(
  deps: DispatchDeps,
  rawInput: unknown,
): Promise<AgentRun> {
  const input = validateDispatchInput(rawInput);
  const daemon = deps.daemon();
  if (!daemon) throw new Error(ENGINE_NOT_RUNNING);
  const { ticket, repo, branches, runs } = await ticketContext(
    deps,
    input.ticketId,
  );
  const baseRef = resolveBase(branches, input.baseRef, repo);
  const mode = modeFor(input.intent, input.mayChangeFiles);
  if (mode === 'write') {
    const live = findLiveWriter(runs);
    if (live) {
      throw new Error(
        `A writing session is already live on ${ticket.identifier} (${live.title ?? live.id}). Open it from the sessions panel, or wait for it to finish.`,
      );
    }
  }
  const autoApprove = mode === 'write' && input.autoApprove;
  const modeId = sessionModeIdFor(mode, autoApprove);

  const created = await deps.ledger.createRun({
    projectId: ticket.projectId,
    ticketId: ticket.id,
    ownerMemberId: input.ownerMemberId,
    entry: 'dispatched',
    providerId: input.providerId,
    isolation: 'worktree',
    autoApprove,
    modeId,
    intent: input.intent,
    baseRef,
    title: briefTitle(ticket.identifier, input.intent),
    copilotConversationId: input.copilotConversationId,
  });
  const run = await deps.ledger.updateRun(created.id, {
    status: 'provisioning',
    reason: `Dispatched on ${ticket.identifier}`,
  });
  deps.notify({ runId: run.id, status: run.status });
  deps.logger.info('engine: run dispatched', {
    runId: run.id,
    ticket: ticket.identifier,
    intent: input.intent,
    mode,
    autoApprove,
    baseRef,
    fromCopilot: input.copilotConversationId !== null,
  });

  // Not awaited: the renderer has its row; what follows reports through
  // the ledger and `runs:changed`. Never rejects — every failure is a
  // ledger write inside.
  void continueStart(
    { ...deps, daemonApi: daemon },
    run,
    repo.path,
    input.brief,
    {
      ticketIdentifier: ticket.identifier,
      env: agentEnvFor(run),
    },
  );
  return run;
}
