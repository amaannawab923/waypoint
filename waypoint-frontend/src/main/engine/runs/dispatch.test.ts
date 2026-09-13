import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AUTO_APPROVE_MODE_ID, PLAN_MODE_ID } from '../types';
import type { DaemonRunsApi, DaemonWorkspaceRecord } from './daemonApi';
import { createFolderRegistry, type FolderDeps } from './folders';
import type { AgentRun, LedgerClient, LedgerProposal } from './ledgerClient';
import {
  buildBriefPreview,
  dispatchTicketRun,
  findApprovedRca,
  findLiveWriter,
  findPriorFixBranch,
  FOLDER_PLACEHOLDER,
  modeFor,
  sessionModeIdFor,
  validateDispatchInput,
  type DispatchDeps,
} from './dispatch';
import { SCRUBBED_ENV_KEYS } from './agentEnv';
import { readJiraRepos, rememberJiraRepo } from './jiraRepos';
import type { JiraRunDeps } from './jiraRuns';
import type { JiraWireTicket } from '../../jira/jiraTypes';

// Dispatch against fakes of the ledger and the daemon
// (docs/design/w5a-investigate-fix.md §6): no linked repo, a second
// writer refused, the mode per verb and switch, the env scrub keys.

let worktreesDir: string;
let repoDir: string;
beforeAll(() => {
  repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-repo-')));
  fs.mkdirSync(path.join(repoDir, '.git'));
  worktreesDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wp-wt-')),
  );
});
afterAll(() => {
  fs.rmSync(worktreesDir, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
});

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-abc1234',
    projectId: 'proj-1',
    ticketId: 'wi-1',
    ownerMemberId: 'mem-1',
    agentId: null,
    entry: 'dispatched',
    providerId: 'claude',
    title: null,
    isolation: 'worktree',
    cwd: null,
    autoApprove: false,
    modeId: null,
    intent: null,
    copilotConversationId: null,
    daemonWorkspaceId: null,
    daemonSessionId: null,
    providerSessionId: null,
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    prUrl: null,
    status: 'queued',
    blockedReason: null,
    errorKind: null,
    errorMessage: null,
    summary: null,
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    retryOfRunId: null,
    createdAt: '2026-09-12T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

const ticket = {
  id: 'wi-1',
  identifier: 'ROAD-116',
  title: 'Sessions anywhere',
  description: 'Take a folder.',
  projectId: 'proj-1',
  stateId: 'st-1',
  priority: 'high',
};

function fakeLedger(
  options: {
    runs?: AgentRun[];
    proposals?: LedgerProposal[];
    repoPath?: string | null;
    /** W5b: the site the Jira ref was minted against; null for a ref with none. */
    refSite?: string | null;
  } = {},
) {
  const rows = new Map<string, AgentRun>();
  const repoPath = options.repoPath === undefined ? repoDir : options.repoPath;
  const ledger = {
    listProjects: jest.fn(async () => [
      { id: 'proj-1', name: 'Roadmap', repoPath },
    ]),
    getProject: jest.fn(async (id: string) =>
      id === 'proj-1' ? { id, name: 'Roadmap', repoPath } : null,
    ),
    getTicket: jest.fn(async (id: string) => (id === 'wi-1' ? ticket : null)),
    listComments: jest.fn(async () => []),
    listMembers: jest.fn(async () => [
      { id: 'mem-1', fullName: 'Amaan Nawab', displayName: 'Amaan' },
    ]),
    listStates: jest.fn(async () => [
      {
        id: 'st-1',
        projectId: 'proj-1',
        name: 'In Progress',
        group: 'started',
        sortOrder: 2,
      },
    ]),
    listTicketProposals: jest.fn(async () => options.proposals ?? []),
    listAllRuns: jest.fn(async () => options.runs ?? []),
    createRun: jest.fn(async (input) => {
      const created = run({ ...input, id: 'run-new0001', status: 'queued' });
      rows.set(created.id, created);
      return created;
    }),
    getRun: jest.fn(async (id: string) => rows.get(id) ?? null),
    updateRun: jest.fn(async (id: string, patch) => {
      const current = rows.get(id);
      if (!current) throw new Error(`no row ${id}`);
      const fields = { ...patch };
      delete fields.reason;
      const next = { ...current, ...fields } as AgentRun;
      rows.set(id, next);
      return next;
    }),
    appendEvent: jest.fn(async () => ({}) as never),
    // W5b: the Jira issue's handle; only tref-eng4 exists.
    getTicketRef: jest.fn(async (id: string) =>
      id === 'tref-eng4'
        ? {
            id: 'tref-eng4',
            provider: 'jira',
            site: options.refSite === undefined ? JIRA_SITE : options.refSite,
            key: 'ENG-4',
            identifier: 'ENG-4',
            title: 'Checkout 500s (cached)',
            url: `https://${JIRA_SITE}/browse/ENG-4`,
          }
        : null,
    ),
  } as unknown as jest.Mocked<LedgerClient>;
  return { ledger, rows };
}

// --- W5b: a Jira issue --------------------------------------------------

const JIRA_SITE = 'yourteam.atlassian.net';

function jiraIssue(overrides: Partial<JiraWireTicket> = {}): JiraWireTicket {
  return {
    id: '10042',
    key: 'ENG-4',
    projectKey: 'ENG',
    title: 'Checkout 500s',
    role: 'assignee',
    stateName: 'In Progress',
    stateCategory: 'in-progress',
    priority: 'high',
    priorityId: '2',
    priorityName: 'High',
    assigneeName: 'Amaan Nawab',
    assigneeAccountId: '5b10ac8d82e05b22cc7d4ef5',
    reporterName: 'Priya Raman',
    description: 'POST /checkout returns 500 after the retry.',
    epicName: null,
    storyPoints: null,
    sprintName: null,
    labels: ['payments'],
    dueDate: null,
    subtasks: [],
    links: [],
    descriptionAdf: null,
    attachments: [],
    transitions: [],
    updatedAt: '2026-09-13T10:00:00.000Z',
    ...overrides,
  };
}

function fakeJira(
  options: { site?: string | null; issue?: JiraWireTicket | null } = {},
): JiraRunDeps {
  const issue = options.issue === undefined ? jiraIssue() : options.issue;
  return {
    site: () => (options.site === undefined ? JIRA_SITE : options.site),
    getTicket: jest.fn(async () =>
      issue
        ? { ok: true as const, value: issue }
        : {
            ok: false as const,
            reason: 'not_found' as const,
            message: 'That issue is gone.',
          },
    ),
    listComments: jest.fn(async () => ({
      ok: true as const,
      value: {
        comments: [
          {
            id: 'c1',
            ticketId: 'ENG-4',
            authorName: 'Priya Raman',
            authorAccountId: '5b10ac8d82e05b22cc7d4ef5',
            updatedAt: null,
            updateAuthorName: null,
            body: 'Repro on staging only. [~accountid:5b10ac8d82e05b22cc7d4ef5] can you look?',
            createdAt: '2026-09-12T09:00:00.000Z',
            parentId: null,
            visibility: null,
            bodyAdf: null,
          },
        ],
        total: 1,
      },
    })),
    listTransitions: jest.fn(async () => ({ ok: true as const, value: [] })),
  };
}

function fakeDaemon(
  overrides: Partial<Record<keyof DaemonRunsApi, unknown>> = {},
) {
  const record = (id: string): DaemonWorkspaceRecord => ({
    id,
    kind: 'worktree',
    path: path.join(worktreesDir, id),
    parentId: 'repo-1',
    observedStatus: 'present',
    creation: { branch: 'agent/ROAD-116', baseRef: 'main', requestedPath: '' },
    lifecycle: null,
    lastCreateOutcome: { status: 'succeeded', at: 1 },
  });
  return {
    registerRepository: jest.fn(async (id: string, p: string) => ({
      ...record(id),
      kind: 'repository' as const,
      path: p,
      creation: null,
    })),
    disableArtifactCopy: jest.fn(async () => {}),
    createWorktree: jest.fn(async (req) => record(req.workspaceId)),
    deleteWorktree: jest.fn(async () => {}),
    listLocalBranches: jest.fn(async () => ['main', 'feat/x']),
    listRefs: jest.fn(async () => ({
      branches: ['feat/x', 'main'],
      remoteHeads: [{ remote: 'origin', branch: 'main' }],
    })),
    startSession: jest.fn(async () => ({ sessionId: 'sess-1' })),
    sendPrompt: jest.fn(async () => {}),
    cancelTurn: jest.fn(async () => {}),
    killSession: jest.fn(async () => {}),
    ...overrides,
  } as unknown as jest.Mocked<DaemonRunsApi>;
}

function depsWith(
  ledger: LedgerClient,
  daemon: DaemonRunsApi | null,
  extra: { jira?: JiraRunDeps; jiraReposFile?: string } = {},
): DispatchDeps & { notify: jest.Mock } {
  const notify = jest.fn();
  return {
    ledger,
    daemon: () => daemon,
    worktreesDir,
    notify,
    git: jest.fn(async () => ({ stdout: '', code: 0 })),
    assertWorktreeGitDir: jest.fn(async () => {}),
    folders: {
      registry: createFolderRegistry(),
      recentsFile: path.join(worktreesDir, 'recents.json'),
      listProjects: () => ledger.listProjects(),
    } satisfies FolderDeps,
    logger: { info: jest.fn(), warn: jest.fn() },
    ...(extra.jira ? { jira: extra.jira } : {}),
    jiraReposFile:
      extra.jiraReposFile ?? path.join(worktreesDir, 'jira-project-repos.json'),
  };
}

// continueStart runs detached; wait for the daemon call it ends in rather
// than a fixed tick (a fixed 20 ms flaked under the full suite's load).
const flush = async (daemon?: {
  startSession: { mock: { calls: unknown[] } };
}) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- polling
    await new Promise((r) => setTimeout(r, 10));
    if (!daemon || daemon.startSession.mock.calls.length > 0) {
      // One more tick so the ledger writes after the call have landed.
      // eslint-disable-next-line no-await-in-loop -- polling
      await new Promise((r) => setTimeout(r, 30));
      return;
    }
  }
};

describe('modeFor / sessionModeIdFor', () => {
  it.each([
    ['investigate', undefined, 'plan'],
    ['investigate', true, 'plan'],
    ['fix', undefined, 'write'],
    ['fix', false, 'write'],
    ['custom', false, 'plan'],
    ['custom', true, 'write'],
  ] as const)('%s with mayChangeFiles=%s → %s', (intent, may, mode) => {
    expect(modeFor(intent, may)).toBe(mode);
  });
  it('plan mode ignores auto-approve; a writing session takes it', () => {
    expect(sessionModeIdFor('plan', true)).toBe(PLAN_MODE_ID);
    expect(sessionModeIdFor('write', true)).toBe(AUTO_APPROVE_MODE_ID);
    expect(sessionModeIdFor('write', false)).toBeNull();
  });
});

describe('buildBriefPreview', () => {
  it('builds the brief from the ticket and reports the facts', async () => {
    const { ledger } = fakeLedger();
    const preview = await buildBriefPreview(depsWith(ledger, fakeDaemon()), {
      ticketId: 'wi-1',
      intent: 'investigate',
    });
    expect(preview.identifier).toBe('ROAD-116');
    expect(preview.mode).toBe('plan');
    expect(preview.autoApproveDefault).toBe(false);
    expect(preview.baseRef).toBe('main');
    expect(preview.branchHint).toBe('agent/ROAD-116');
    expect(preview.repo?.path).toBe(repoDir);
    expect(preview.repo?.projectName).toBe('Roadmap');
    expect(preview.brief).toContain('## Ticket ROAD-116 — Sessions anywhere');
    expect(preview.brief).toContain('State: In Progress');
    expect(preview.liveWriterRunId).toBeNull();
    expect(preview.seededFromRunId).toBeNull();
    expect(preview.ticketSystem).toBe('waypoint');
    expect(preview.ticketUrl).toBeNull();
    expect(preview.jiraProjectKey).toBeNull();
    expect(preview.repoRemembered).toBe(false);
    expect(ledger.listTicketProposals).not.toHaveBeenCalled();
  });

  it('refuses a project with no linked repository, naming the settings', async () => {
    const { ledger } = fakeLedger({ repoPath: null });
    await expect(
      buildBriefPreview(depsWith(ledger, fakeDaemon()), {
        ticketId: 'wi-1',
        intent: 'fix',
      }),
    ).rejects.toThrow(/Roadmap has no linked repository.*Codebase settings/);
  });

  it('refuses a linked repository that is gone from this machine', async () => {
    const { ledger } = fakeLedger({
      repoPath: path.join(os.tmpdir(), 'wp-nope-' + Date.now()),
    });
    await expect(
      buildBriefPreview(depsWith(ledger, fakeDaemon()), {
        ticketId: 'wi-1',
        intent: 'fix',
      }),
    ).rejects.toThrow(/not a folder on this machine/);
  });

  it('refuses a base branch the repository does not have', async () => {
    const { ledger } = fakeLedger();
    await expect(
      buildBriefPreview(depsWith(ledger, fakeDaemon()), {
        ticketId: 'wi-1',
        intent: 'fix',
        baseRef: 'nope',
      }),
    ).rejects.toThrow(/nope is not a local branch/);
  });

  it('Something else… needs an instruction', async () => {
    const { ledger } = fakeLedger();
    await expect(
      buildBriefPreview(depsWith(ledger, fakeDaemon()), {
        ticketId: 'wi-1',
        intent: 'custom',
        instructions: '  ',
      }),
    ).rejects.toThrow('Say what the session should do.');
  });

  it('Fix: seeded from the approved RCA of the latest Investigate, flags a live writer', async () => {
    const investigate = run({
      id: 'run-inv00001',
      intent: 'investigate',
      status: 'done',
      modeId: PLAN_MODE_ID,
    });
    const liveFix = run({
      id: 'run-fix00001',
      intent: 'fix',
      status: 'running',
      modeId: AUTO_APPROVE_MODE_ID,
      title: 'ROAD-116 · Fix',
    });
    const proposals: LedgerProposal[] = [
      {
        id: 'prop-old',
        kind: 'comment',
        status: 'executed',
        origin: 'agent_run',
        agentRunId: 'run-inv00001',
        payload: { body: 'Older root cause.' },
        createdAt: '2026-09-10T00:00:00.000Z',
        resolvedAt: '2026-09-10T01:00:00.000Z',
      },
      {
        id: 'prop-new',
        kind: 'comment',
        status: 'executed',
        origin: 'agent_run',
        agentRunId: 'run-inv00001',
        payload: { body: 'The write is not guarded.' },
        createdAt: '2026-09-11T00:00:00.000Z',
        resolvedAt: '2026-09-11T01:00:00.000Z',
      },
      {
        id: 'prop-copilot',
        kind: 'comment',
        status: 'executed',
        origin: 'copilot',
        agentRunId: null,
        payload: { body: 'Not an RCA.' },
        createdAt: '2026-09-12T00:00:00.000Z',
        resolvedAt: '2026-09-12T01:00:00.000Z',
      },
    ];
    const { ledger } = fakeLedger({ runs: [investigate, liveFix], proposals });
    const preview = await buildBriefPreview(depsWith(ledger, fakeDaemon()), {
      ticketId: 'wi-1',
      intent: 'fix',
    });
    expect(preview.mode).toBe('write');
    expect(preview.autoApproveDefault).toBe(true);
    expect(preview.seededFromRunId).toBe('run-inv00001');
    expect(preview.brief).toContain(
      '## Root cause, as approved\nThe write is not guarded.',
    );
    expect(preview.brief).not.toContain('Older root cause');
    expect(preview.liveWriterRunId).toBe('run-fix00001');
  });
});

// W5b (docs/design/w5b-jira-dispatch.md §6): a session on a Jira issue —
// the brief from main's own client, the folder from the mapping or the
// request, the ref's site check, the project from the folder.
describe('buildBriefPreview on a Jira issue', () => {
  let otherRepo: string;
  let plainDir: string;
  beforeAll(() => {
    otherRepo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'wp-eng-')),
    );
    fs.mkdirSync(path.join(otherRepo, '.git'));
    plainDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'wp-plain-')),
    );
  });
  afterAll(() => {
    fs.rmSync(otherRepo, { recursive: true, force: true });
    fs.rmSync(plainDir, { recursive: true, force: true });
  });

  it('with no folder remembered: the brief from the issue and its comments, repo null, the placeholder in the brief', async () => {
    const { ledger } = fakeLedger();
    const jira = fakeJira();
    const deps = depsWith(ledger, fakeDaemon(), { jira });
    const preview = await buildBriefPreview(deps, {
      ticketId: 'tref-eng4',
      intent: 'investigate',
    });
    expect(preview.ticketSystem).toBe('jira');
    expect(preview.identifier).toBe('ENG-4');
    // The live summary, not the ref's cached one.
    expect(preview.title).toBe('Checkout 500s');
    expect(preview.ticketUrl).toBe(`https://${JIRA_SITE}/browse/ENG-4`);
    expect(preview.jiraProjectKey).toBe('ENG');
    expect(preview.repo).toBeNull();
    expect(preview.repoRemembered).toBe(false);
    expect(preview.branches).toEqual({ branches: [], suggested: null });
    expect(preview.baseRef).toBeNull();
    expect(preview.branchHint).toBe('agent/ENG-4');
    expect(jira.getTicket).toHaveBeenCalledWith('ENG-4');
    expect(jira.listComments).toHaveBeenCalledWith('ENG-4');
    // Never the ledger's ticket table.
    expect(ledger.getTicket).not.toHaveBeenCalled();
    expect(ledger.listComments).not.toHaveBeenCalled();
    const { brief } = preview;
    expect(brief).toContain(
      `You are working on ENG-4, a Jira issue (https://${JIRA_SITE}/browse/ENG-4)`,
    );
    expect(brief).toContain('## Issue ENG-4 — Checkout 500s');
    expect(brief).toContain(
      'Priority: High · State: In Progress · Labels: payments · Assignee: Amaan Nawab · Reporter: Priya Raman',
    );
    expect(brief).toContain('POST /checkout returns 500 after the retry.');
    expect(brief).toContain(
      '— Priya Raman, 2026-09-12 09:00:\nRepro on staging only.',
    );
    // The scrub: the raw mention the mapper left is not carried.
    expect(brief).not.toContain('accountid');
    expect(brief).toContain(`Repository: ${FOLDER_PLACEHOLDER}`);
    expect(brief).toContain('comment proposal on the issue');
  });

  it('with a folder handle: that repository, its branches, the brief rebuilt on it; a plain folder refused', async () => {
    const { ledger } = fakeLedger();
    const deps = depsWith(ledger, fakeDaemon(), { jira: fakeJira() });
    const handle = deps.folders.registry.mint(otherRepo);
    const preview = await buildBriefPreview(deps, {
      ticketId: 'tref-eng4',
      intent: 'fix',
      folder: handle,
    });
    expect(preview.repo?.path).toBe(otherRepo);
    expect(preview.repo?.projectId).toBeNull();
    expect(preview.repoRemembered).toBe(false);
    expect(preview.baseRef).toBe('main');
    expect(preview.mode).toBe('write');
    expect(preview.brief).toContain(`Repository: ${preview.repo?.displayPath}`);
    expect(preview.brief).toContain('Branch: agent/ENG-4, from main');

    await expect(
      buildBriefPreview(deps, {
        ticketId: 'tref-eng4',
        intent: 'fix',
        folder: deps.folders.registry.mint(plainDir),
      }),
    ).rejects.toThrow(/is not a git repository/);
    // A handle this window never minted is refused before anything is read.
    await expect(
      buildBriefPreview(deps, {
        ticketId: 'tref-eng4',
        intent: 'fix',
        folder: 'f-forged',
      }),
    ).rejects.toThrow(/not one this window offered/);
  });

  it('with a folder remembered for the Jira project: that repository, marked remembered; a gone one is forgotten', async () => {
    const { ledger } = fakeLedger();
    const file = path.join(worktreesDir, `jira-repos-${Date.now()}.json`);
    await rememberJiraRepo(file, JIRA_SITE, 'ENG', repoDir);
    const deps = depsWith(ledger, fakeDaemon(), {
      jira: fakeJira(),
      jiraReposFile: file,
    });
    const preview = await buildBriefPreview(deps, {
      ticketId: 'tref-eng4',
      intent: 'investigate',
    });
    expect(preview.repo?.path).toBe(repoDir);
    // The Roadmap project's linked repository → the run will be that project's.
    expect(preview.repo?.projectName).toBe('Roadmap');
    expect(preview.repoRemembered).toBe(true);
    expect(preview.baseRef).toBe('main');

    const gone = path.join(worktreesDir, `jira-repos-gone-${Date.now()}.json`);
    await rememberJiraRepo(
      gone,
      JIRA_SITE,
      'ENG',
      path.join(os.tmpdir(), 'wp-nope-x'),
    );
    const again = await buildBriefPreview(
      depsWith(ledger, fakeDaemon(), { jira: fakeJira(), jiraReposFile: gone }),
      { ticketId: 'tref-eng4', intent: 'investigate' },
    );
    expect(again.repo).toBeNull();
  });

  it('refuses when Jira is not connected, when the ref is another site’s, and when the issue is gone', async () => {
    const { ledger } = fakeLedger();
    await expect(
      buildBriefPreview(depsWith(ledger, fakeDaemon()), {
        ticketId: 'tref-eng4',
        intent: 'investigate',
      }),
    ).rejects.toThrow('Jira is not connected');
    await expect(
      buildBriefPreview(
        depsWith(ledger, fakeDaemon(), { jira: fakeJira({ site: null }) }),
        { ticketId: 'tref-eng4', intent: 'investigate' },
      ),
    ).rejects.toThrow('Jira is not connected');

    const other = fakeLedger({ refSite: 'other.atlassian.net' });
    await expect(
      buildBriefPreview(
        depsWith(other.ledger, fakeDaemon(), { jira: fakeJira() }),
        {
          ticketId: 'tref-eng4',
          intent: 'investigate',
        },
      ),
    ).rejects.toThrow(/belongs to another Jira site \(other\.atlassian\.net\)/);

    await expect(
      buildBriefPreview(
        depsWith(ledger, fakeDaemon(), { jira: fakeJira({ issue: null }) }),
        { ticketId: 'tref-eng4', intent: 'investigate' },
      ),
    ).rejects.toThrow('That issue is gone.');

    await expect(
      buildBriefPreview(depsWith(ledger, fakeDaemon(), { jira: fakeJira() }), {
        ticketId: 'tref-nope',
        intent: 'investigate',
      }),
    ).rejects.toThrow('No ticket tref-nope.');
  });
});

describe('dispatchTicketRun on a Jira issue', () => {
  const base = {
    ticketId: 'tref-eng4',
    intent: 'fix',
    brief: 'The brief as edited.',
    autoApprove: true,
    baseRef: 'main',
    ownerMemberId: 'mem-1',
    providerId: 'claude',
  };

  it('refuses without a folder; with one, remembers it for the Jira project and dispatches on the tref with the folder’s project', async () => {
    const { ledger } = fakeLedger();
    const daemon = fakeDaemon();
    const file = path.join(
      worktreesDir,
      `jira-repos-dispatch-${Date.now()}.json`,
    );
    const deps = depsWith(ledger, daemon, {
      jira: fakeJira(),
      jiraReposFile: file,
    });
    await expect(dispatchTicketRun(deps, base)).rejects.toThrow(
      "Choose the folder ENG's code lives in first.",
    );
    expect(ledger.createRun).not.toHaveBeenCalled();

    const handle = deps.folders.registry.mint(repoDir);
    const created = await dispatchTicketRun(deps, { ...base, folder: handle });
    expect(created.status).toBe('provisioning');
    expect(ledger.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: 'dispatched',
        ticketId: 'tref-eng4',
        // repoDir is the Roadmap project's linked repository.
        projectId: 'proj-1',
        intent: 'fix',
        modeId: AUTO_APPROVE_MODE_ID,
        title: 'ENG-4 · Fix',
        baseRef: 'main',
      }),
    );
    expect(await readJiraRepos(file)).toEqual([
      expect.objectContaining({
        site: JIRA_SITE,
        projectKey: 'ENG',
        path: repoDir,
      }),
    ]);
    await flush(daemon);
    expect(daemon.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'agent/ENG-4' }),
    );
    expect(daemon.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modeId: AUTO_APPROVE_MODE_ID,
        initialQueue: [{ text: 'The brief as edited.' }],
      }),
    );
    // A writing session's env is scrubbed on a Jira issue as on a native ticket.
    const env = daemon.startSession.mock.calls[0][0].env as Record<
      string,
      string
    >;
    for (const key of SCRUBBED_ENV_KEYS) expect(env[key]).toBe('');

    // The next dispatch on the project needs no folder: the mapping stands.
    const next = fakeLedger();
    const nextDeps = depsWith(next.ledger, fakeDaemon(), {
      jira: fakeJira(),
      jiraReposFile: file,
    });
    await dispatchTicketRun(nextDeps, { ...base, intent: 'investigate' });
    expect(next.ledger.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: 'tref-eng4',
        projectId: 'proj-1',
        modeId: PLAN_MODE_ID,
      }),
    );
  });

  it('a folder that is no project’s repository dispatches with no project', async () => {
    const { ledger } = fakeLedger({ repoPath: null });
    const other = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'wp-eng2-')),
    );
    fs.mkdirSync(path.join(other, '.git'));
    try {
      const deps = depsWith(ledger, fakeDaemon(), { jira: fakeJira() });
      await dispatchTicketRun(deps, {
        ...base,
        intent: 'investigate',
        folder: deps.folders.registry.mint(other),
      });
      expect(ledger.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 'tref-eng4', projectId: null }),
      );
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('one writer per issue holds on a Jira issue too', async () => {
    const live = run({
      id: 'run-live0001',
      ticketId: 'tref-eng4',
      intent: 'fix',
      modeId: null,
      status: 'running',
      title: 'ENG-4 · Fix',
    });
    const { ledger } = fakeLedger({ runs: [live] });
    const deps = depsWith(ledger, fakeDaemon(), { jira: fakeJira() });
    await expect(
      dispatchTicketRun(deps, {
        ...base,
        folder: deps.folders.registry.mint(repoDir),
      }),
    ).rejects.toThrow(
      'A writing session is already live on ENG-4 (ENG-4 · Fix)',
    );
  });
});

describe('findLiveWriter / findApprovedRca / findPriorFixBranch', () => {
  it('a plan-mode run is never a writer; a finished one is not live', () => {
    expect(
      findLiveWriter([run({ status: 'running', modeId: PLAN_MODE_ID })]),
    ).toBeNull();
    expect(
      findLiveWriter([run({ status: 'needs-review', modeId: null })]),
    ).toBeNull();
    expect(findLiveWriter([run({ status: 'blocked', modeId: null })])?.id).toBe(
      'run-abc1234',
    );
    expect(
      findLiveWriter([run({ status: 'running', entry: 'independent' })]),
    ).toBeNull();
  });
  it('an RCA must be executed (approved), run-filed, and from an Investigate', () => {
    const runs = [run({ id: 'run-inv00001', intent: 'investigate' })];
    const base: LedgerProposal = {
      id: 'p',
      kind: 'comment',
      status: 'executed',
      origin: 'agent_run',
      agentRunId: 'run-inv00001',
      payload: { body: 'rca' },
      createdAt: '2026-09-11T00:00:00.000Z',
      resolvedAt: null,
    };
    expect(findApprovedRca([base], runs)?.body).toBe('rca');
    expect(findApprovedRca([{ ...base, status: 'proposed' }], runs)).toBeNull();
    expect(
      findApprovedRca([{ ...base, kind: 'state_change' }], runs),
    ).toBeNull();
    expect(
      findApprovedRca([{ ...base, agentRunId: 'run-other001' }], runs),
    ).toBeNull();
  });
  it('names the newest finished Fix branch, never a live one', () => {
    expect(
      findPriorFixBranch([
        run({
          id: 'run-a',
          intent: 'fix',
          status: 'done',
          branch: 'agent/ROAD-116',
          createdAt: '2026-09-01T00:00:00.000Z',
        }),
        run({
          id: 'run-b',
          intent: 'fix',
          status: 'failed',
          branch: 'agent/ROAD-116-b',
          createdAt: '2026-09-02T00:00:00.000Z',
        }),
        run({
          id: 'run-c',
          intent: 'fix',
          status: 'running',
          branch: 'agent/ROAD-116-c',
          createdAt: '2026-09-03T00:00:00.000Z',
        }),
      ]),
    ).toBe('agent/ROAD-116-b');
  });
});

describe('dispatchTicketRun', () => {
  const dispatchInput = {
    ticketId: 'wi-1',
    intent: 'investigate',
    brief: 'The brief as edited.',
    autoApprove: true,
    baseRef: 'main',
    ownerMemberId: 'mem-1',
    providerId: 'claude',
    copilotConversationId: 'conv-abc',
  };

  it('Investigate: a dispatched worktree run in plan mode, the brief as the first prompt, no env scrub', async () => {
    const { ledger, rows } = fakeLedger();
    const daemon = fakeDaemon();
    const deps = depsWith(ledger, daemon);
    const created = await dispatchTicketRun(deps, dispatchInput);
    expect(created.status).toBe('provisioning');
    expect(ledger.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: 'dispatched',
        ticketId: 'wi-1',
        projectId: 'proj-1',
        intent: 'investigate',
        isolation: 'worktree',
        autoApprove: false,
        modeId: PLAN_MODE_ID,
        title: 'ROAD-116 · Investigate',
        baseRef: 'main',
        copilotConversationId: 'conv-abc',
      }),
    );
    await flush(daemon);
    expect(daemon.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'agent/ROAD-116' }),
    );
    expect(daemon.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'run-new0001',
        modeId: PLAN_MODE_ID,
        initialQueue: [{ text: 'The brief as edited.' }],
      }),
    );
    expect(daemon.startSession.mock.calls[0][0].env).toBeUndefined();
    expect(rows.get('run-new0001')?.status).toBe('running');
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-new0001',
      'prompt_sent',
      { by: 'waypoint', kind: 'brief' },
    );
  });

  it('Fix with auto-approve: bypass mode and every credential scrubbed from the env', async () => {
    const { ledger } = fakeLedger();
    const daemon = fakeDaemon();
    await dispatchTicketRun(depsWith(ledger, daemon), {
      ...dispatchInput,
      intent: 'fix',
    });
    await flush(daemon);
    const start = daemon.startSession.mock.calls[0][0];
    expect(start.modeId).toBe(AUTO_APPROVE_MODE_ID);
    expect(start.env).toBeDefined();
    for (const key of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'SSH_AUTH_SOCK',
      'GIT_ASKPASS',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(SCRUBBED_ENV_KEYS).toContain(key);
      expect(start.env?.[key]).toBe('');
    }
    expect(start.env?.GIT_TERMINAL_PROMPT).toBe('0');
    // The keychain and ssh keys are not env: closed through git's own config
    // injection, a pinned ssh command, and gh's config dir.
    expect(start.env?.GIT_CONFIG_COUNT).toBe('1');
    expect(start.env?.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(start.env?.GIT_CONFIG_VALUE_0).toBe('');
    expect(start.env?.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(start.env?.GH_CONFIG_DIR).toBe('/dev/null/gh');
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-new0001',
      'session_started',
      expect.objectContaining({
        envScrubbed: expect.arrayContaining(['GH_TOKEN']),
      }),
    );
  });

  it('Fix without auto-approve still writes with the scrubbed env, in the default mode', async () => {
    const { ledger } = fakeLedger();
    const daemon = fakeDaemon();
    await dispatchTicketRun(depsWith(ledger, daemon), {
      ...dispatchInput,
      intent: 'fix',
      autoApprove: false,
    });
    await flush(daemon);
    const start = daemon.startSession.mock.calls[0][0];
    expect(start.modeId).toBeNull();
    expect(start.env?.GH_TOKEN).toBe('');
  });

  it('refuses a second writing session while one is live on the ticket', async () => {
    const live = run({
      id: 'run-fix00001',
      intent: 'fix',
      status: 'blocked',
      modeId: null,
      title: 'ROAD-116 · Fix',
    });
    const { ledger } = fakeLedger({ runs: [live] });
    await expect(
      dispatchTicketRun(depsWith(ledger, fakeDaemon()), {
        ...dispatchInput,
        intent: 'fix',
      }),
    ).rejects.toThrow(/already live on ROAD-116 \(ROAD-116 · Fix\)/);
    expect(ledger.createRun).not.toHaveBeenCalled();
    // A reading session is still allowed beside it.
    await expect(
      dispatchTicketRun(depsWith(ledger, fakeDaemon()), dispatchInput),
    ).resolves.toBeDefined();
  });

  it('refuses with the engine down, before any row is written', async () => {
    const { ledger } = fakeLedger();
    await expect(
      dispatchTicketRun(depsWith(ledger, null), dispatchInput),
    ).rejects.toThrow('The agent engine is not running.');
    expect(ledger.createRun).not.toHaveBeenCalled();
  });

  it('refuses an unknown ticket', async () => {
    const { ledger } = fakeLedger();
    await expect(
      dispatchTicketRun(depsWith(ledger, fakeDaemon()), {
        ...dispatchInput,
        ticketId: 'wi-nope',
      }),
    ).rejects.toThrow('No ticket wi-nope.');
  });
});

describe('validateDispatchInput', () => {
  const good = {
    ticketId: 'wi-1',
    intent: 'fix',
    brief: 'x',
    autoApprove: false,
    baseRef: 'main',
    ownerMemberId: 'mem-1',
    providerId: 'claude',
  };
  it.each([
    [{ ...good, ticketId: '../x' }, /Not a run id/],
    [{ ...good, intent: 'deploy' }, 'Choose what the session should do.'],
    [{ ...good, brief: '   ' }, 'The brief is empty.'],
    [{ ...good, autoApprove: 'yes' }, /without asking/],
    [{ ...good, baseRef: 'a..b' }, 'Choose a base branch.'],
    [{ ...good, baseRef: '' }, 'Choose a base branch.'],
    [{ ...good, providerId: 'codex' }, /not one Waypoint can start/],
    [
      { ...good, copilotConversationId: 'conv/1' },
      'Not a Copilot conversation id.',
    ],
  ])('refuses %j', (raw, message) => {
    expect(() => validateDispatchInput(raw)).toThrow(message);
  });
  it('accepts the good one, trimming the brief', () => {
    expect(validateDispatchInput({ ...good, brief: '  hi  ' }).brief).toBe(
      'hi',
    );
    expect(validateDispatchInput(good).copilotConversationId).toBeNull();
  });
});
