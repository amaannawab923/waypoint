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
import type { JiraWireTicket } from '../../jira/jiraTypes';
import { agentEnvFor } from './agentEnv';
import {
  briefTitle,
  buildBrief,
  jiraBriefComments,
  jiraBriefTicket,
  jiraIssueUrl,
  type BriefInput,
} from './briefs';
import { describeFolder } from './folders';
import { lookupJiraRepo, projectKeyOf, rememberJiraRepo } from './jiraRepos';
import { JIRA_NOT_CONNECTED, type JiraRunDeps } from './jiraRuns';
import {
  assertRunId,
  isTicketRef,
  type AgentRun,
  type LedgerProposal,
  type LedgerTicket,
  type LedgerTicketRef,
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

export type DispatchDeps = StartRunDeps & {
  /** W5b: main's own Jira reads (runs/jiraRuns.ts); absent when Jira is not connected. */
  jira?: JiraRunDeps;
  /** Where main remembers which folder a Jira project's code lives in (runs/jiraRepos.ts). */
  jiraReposFile: string;
};

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
const APPROVED_STATUSES: ReadonlySet<string> = new Set([
  'executed',
  'approved',
]);

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

type Branches = { branches: string[]; suggested: string | null };
const NO_BRANCHES: Branches = { branches: [], suggested: null };

/**
 * What a preview and a dispatch resolve from a ticket id — a native
 * ticket's, or a Jira issue's (W5b): the ticket as its system has it, the
 * repository the session will take a worktree of (null for a Jira issue
 * whose project has no remembered folder yet), that repository's
 * branches, the ticket's runs, and the facts the dialog names.
 */
type TicketContext = {
  identifier: string;
  title: string;
  repo: SessionFolder | null;
  /** The repository came from the Jira project's remembered folder (so the dialog offers *Change*). */
  repoRemembered: boolean;
  branches: Branches;
  runs: AgentRun[];
} & (
  | { system: 'waypoint'; ticket: LedgerTicket; jira: null }
  | {
      system: 'jira';
      ticket: null;
      jira: {
        ref: LedgerTicketRef;
        site: string;
        projectKey: string;
        issue: JiraWireTicket;
        url: string;
        client: JiraRunDeps;
      };
    }
);

/**
 * A native ticket: its project's linked repository (as a folder the
 * dialog can show), the repository's branches, and the ticket's runs.
 * Every refusal a person can act on is a sentence: no such ticket, no
 * linked repository, the repository gone from this machine.
 */
async function nativeTicketContext(
  deps: DispatchDeps,
  ticketId: string,
): Promise<TicketContext> {
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
  return {
    system: 'waypoint',
    ticket,
    jira: null,
    identifier: ticket.identifier,
    title: ticket.title,
    repo,
    repoRemembered: false,
    branches,
    runs,
  };
}

/**
 * A Jira issue (W5b, docs/design/w5b-jira-dispatch.md §2.2, §2.3, §2.9):
 * its ledger handle must exist and belong to the connected site; the
 * issue is read live through main's own client; the repository is the
 * folder the request chose (a handle this window minted, and a git
 * repository), else the one remembered for the issue's Jira project,
 * else nothing — the preview then asks. The runs are the handle's.
 */
async function jiraTicketContext(
  deps: DispatchDeps,
  ticketId: string,
  folderHandle: string | null,
): Promise<TicketContext> {
  const ref = await deps.ledger.getTicketRef(ticketId);
  if (!ref) throw new Error(`No ticket ${ticketId}.`);
  const client = deps.jira;
  const site = client?.site() ?? null;
  if (!client || !site) throw new Error(JIRA_NOT_CONNECTED);
  if (ref.site && ref.site !== site) {
    throw new Error(
      `${ref.key} belongs to another Jira site (${ref.site}); this Waypoint is connected to ${site}.`,
    );
  }
  const projectKey = projectKeyOf(ref.key);
  if (!projectKey) throw new Error(`${ref.key} is not a Jira issue key.`);

  const read = await client.getTicket(ref.key);
  if (!read.ok) throw new Error(read.message);
  const issue = read.value;

  let repo: SessionFolder | null = null;
  let repoRemembered = false;
  if (folderHandle) {
    const chosen = deps.folders.registry.resolve(folderHandle);
    repo = await describeFolder(deps.folders, chosen);
    if (!repo) throw new Error('That folder is not on this machine any more.');
    if (repo.kind !== 'repo') {
      throw new Error(
        `${repo.displayPath} is not a git repository; a session on ${ref.key} needs one to take a worktree of.`,
      );
    }
  } else {
    const remembered = await lookupJiraRepo(
      deps.jiraReposFile,
      site,
      projectKey,
    );
    if (remembered) {
      const described = await describeFolder(deps.folders, remembered);
      // A remembered folder that is gone, or no longer a repository, is
      // simply not remembered: the dialog asks again.
      if (described?.kind === 'repo') {
        repo = described;
        repoRemembered = true;
      }
    }
  }
  const branches = repo
    ? await listRunBranches(deps, repo.handle)
    : NO_BRANCHES;
  const runs = await deps.ledger.listAllRuns({ ticketId });
  return {
    system: 'jira',
    ticket: null,
    jira: {
      ref,
      site,
      projectKey,
      issue,
      url: jiraIssueUrl(site, ref.key),
      client,
    },
    identifier: ref.key,
    title: issue.title,
    repo,
    repoRemembered,
    branches,
    runs,
  };
}

async function ticketContext(
  deps: DispatchDeps,
  ticketId: string,
  folderHandle: string | null = null,
): Promise<TicketContext> {
  if (!deps.daemon()) throw new Error(ENGINE_NOT_RUNNING);
  return isTicketRef(ticketId)
    ? jiraTicketContext(deps, ticketId, folderHandle)
    : nativeTicketContext(deps, ticketId);
}

/** The brief's ticket, comments and facts from whichever system the context came from. */
async function briefSource(
  deps: DispatchDeps,
  context: TicketContext,
): Promise<
  Pick<BriefInput, 'ticket' | 'comments' | 'members' | 'stateName' | 'jira'>
> {
  if (context.system === 'jira') {
    const { issue, site, ref, client } = context.jira;
    const comments = await client.listComments(ref.key);
    if (!comments.ok) throw new Error(comments.message);
    const facts = jiraBriefTicket(issue, site);
    return {
      ticket: facts.ticket,
      comments: jiraBriefComments(comments.value.comments),
      members: [],
      stateName: facts.stateName,
      jira: facts.jira,
    };
  }
  const { ticket } = context;
  const [comments, members, states] = await Promise.all([
    deps.ledger.listComments(ticket.id),
    deps.ledger.listMembers(),
    deps.ledger.listStates(ticket.projectId),
  ]);
  return {
    ticket,
    comments,
    members,
    stateName: states.find((st) => st.id === ticket.stateId)?.name ?? null,
    jira: null,
  };
}

function resolveBase(
  branches: Branches,
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

/** A folder handle as the renderer sends it (W5b); null when none. Resolved later, against the registry. */
function cleanFolder(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Choose a folder.');
  return value;
}

function validatePreviewInput(input: unknown): Required<
  Pick<BriefPreviewInput, 'ticketId' | 'intent'>
> & {
  instructions: string | null;
  mayChangeFiles: boolean;
  baseRef: string | null;
  folder: string | null;
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
    folder: cleanFolder(raw.folder),
  };
}

/** What the brief says about the repository before one is chosen (W5b). */
export const FOLDER_PLACEHOLDER = '(the folder you choose in the preview)';

/** The brief and the facts the preview dialog shows (§1.3). */
export async function buildBriefPreview(
  deps: DispatchDeps,
  rawInput: unknown,
): Promise<BriefPreview> {
  const input = validatePreviewInput(rawInput);
  const context = await ticketContext(deps, input.ticketId, input.folder);
  const { repo, branches, runs } = context;
  // A Jira issue with no folder yet: the brief is still built — with a
  // placeholder where the repository goes — so the person reads it while
  // choosing; it is rebuilt with the real folder the moment one is picked.
  const baseRef = repo ? resolveBase(branches, input.baseRef, repo) : null;
  const mode = modeFor(input.intent, input.mayChangeFiles);

  const [source, proposals] = await Promise.all([
    briefSource(deps, context),
    input.intent === 'fix'
      ? deps.ledger.listTicketProposals(input.ticketId)
      : Promise.resolve([] as LedgerProposal[]),
  ]);
  const rca = input.intent === 'fix' ? findApprovedRca(proposals, runs) : null;
  const liveWriter = mode === 'write' ? findLiveWriter(runs) : null;
  const branchHint = preferredBranchName(
    { id: 'run-preview', entry: 'dispatched' },
    context.identifier,
  );

  const brief = buildBrief({
    ...source,
    repoDisplayPath: repo?.displayPath ?? FOLDER_PLACEHOLDER,
    branch: branchHint,
    baseRef,
    intent: input.intent,
    instructions: input.instructions,
    mayChangeFiles: mode === 'write',
    approvedRca: rca?.body ?? null,
    priorFixBranch: input.intent === 'fix' ? findPriorFixBranch(runs) : null,
  });

  return {
    ticketId: input.ticketId,
    identifier: context.identifier,
    title: context.title,
    intent: input.intent,
    brief,
    repo,
    branches,
    ticketSystem: context.system,
    ticketUrl: context.jira?.url ?? null,
    jiraProjectKey: context.jira?.projectKey ?? null,
    repoRemembered: context.repoRemembered,
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
  /** W5b: the folder chosen in the preview for a Jira issue; null otherwise. */
  folder: string | null;
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
    folder: cleanFolder(raw.folder),
  };
}

/**
 * ROAD-131: `findLiveWriter` reads the ticket's runs, then, well below,
 * `createRun` writes the new one — nothing serializes the two. Two Start
 * presses on the same ticket (the drawer and a Copilot-offered card, or
 * just a double-click) can both read "no live writer" before either write
 * lands, and both pass, producing two writing sessions (two worktrees) on
 * one ticket. This queues every dispatch on the same ticket behind
 * whichever one started first, so a later call's live-writer check always
 * sees the effect of an earlier call that is still in flight — the second
 * press waits, then is refused with the normal "already live" error
 * rather than racing it. A rejected dispatch does not jam the queue for
 * the ticket: the next one still runs once it is this dispatch's turn.
 *
 * Scope: this serializes dispatches within this one Electron main
 * process. The ledger itself — a shared HTTP backend, `LedgerClient` —
 * enforces nothing of its own about one-writer-per-ticket, so a second
 * app instance, a process restart mid-provision, or any other ledger
 * client can still race past this queue and double-create. Closing that
 * for real needs a constraint on the backend's own `/agent-runs` route
 * (a conditional insert or a partial unique index); tracked separately.
 */
const dispatchQueues = new Map<string, Promise<unknown>>();

function withTicketDispatchLock<T>(
  ticketId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = dispatchQueues.get(ticketId) ?? Promise.resolve();
  const settled = previous.then(fn, fn);
  const bare = settled.then(
    () => undefined,
    () => undefined,
  );
  dispatchQueues.set(ticketId, bare);
  void bare.then(() => {
    if (dispatchQueues.get(ticketId) === bare) dispatchQueues.delete(ticketId);
  });
  return settled;
}

// The actual body of a Start, run only once `dispatchTicketRun` below has
// this ticket's dispatch lock — see `dispatchTicketRun`'s own doc comment
// for the externally-visible contract this implements.
async function dispatchTicketRunLocked(
  deps: DispatchDeps,
  input: ValidatedDispatchInput,
): Promise<AgentRun> {
  const daemon = deps.daemon();
  if (!daemon) throw new Error(ENGINE_NOT_RUNNING);
  const context = await ticketContext(deps, input.ticketId, input.folder);
  const { repo, branches, runs, identifier } = context;
  if (!repo) {
    throw new Error(
      `Choose the folder ${context.jira?.projectKey ?? identifier}'s code lives in first.`,
    );
  }
  const baseRef = resolveBase(branches, input.baseRef, repo);
  const mode = modeFor(input.intent, input.mayChangeFiles);
  if (mode === 'write') {
    const live = findLiveWriter(runs);
    if (live) {
      throw new Error(
        `A writing session is already live on ${identifier} (${live.title ?? live.id}). Open it from the sessions panel, or wait for it to finish.`,
      );
    }
  }
  const autoApprove = mode === 'write' && input.autoApprove;
  const modeId = sessionModeIdFor(mode, autoApprove);

  // W5b: the folder chosen for a Jira project is remembered on Start —
  // the person said where ENG's code lives, once.
  if (context.system === 'jira' && !context.repoRemembered) {
    await rememberJiraRepo(
      deps.jiraReposFile,
      context.jira.site,
      context.jira.projectKey,
      repo.path,
    );
  }

  const created = await deps.ledger.createRun({
    // A native ticket's project; for a Jira issue the project whose
    // linked repository the folder is, if any (W4b's rule) — a Jira issue
    // belongs to no Waypoint project of its own.
    projectId:
      context.system === 'jira' ? repo.projectId : context.ticket.projectId,
    ticketId: input.ticketId,
    ownerMemberId: input.ownerMemberId,
    entry: 'dispatched',
    providerId: input.providerId,
    isolation: 'worktree',
    autoApprove,
    modeId,
    intent: input.intent,
    baseRef,
    title: briefTitle(identifier, input.intent),
    copilotConversationId: input.copilotConversationId,
  });
  const run = await deps.ledger.updateRun(created.id, {
    status: 'provisioning',
    reason: `Dispatched on ${identifier}`,
  });
  deps.notify({ runId: run.id, status: run.status });
  deps.logger.info('engine: run dispatched', {
    runId: run.id,
    ticket: identifier,
    system: context.system,
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
      ticketIdentifier: identifier,
      env: agentEnvFor(run),
    },
  );
  return run;
}

/**
 * Start. Answers once the row is `provisioning`; the worktree and the
 * session follow in main through `continueStart`. Refuses before a row
 * is written: engine down, no such ticket, no linked repository, an
 * unknown base branch, a writing session already live on the ticket —
 * and, per-ticket, serialized against a concurrent Start on the same
 * ticket (ROAD-131) so two presses cannot both win that check.
 */
export async function dispatchTicketRun(
  deps: DispatchDeps,
  rawInput: unknown,
): Promise<AgentRun> {
  const input = validateDispatchInput(rawInput);
  return withTicketDispatchLock(input.ticketId, () =>
    dispatchTicketRunLocked(deps, input),
  );
}
