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
  modeFor,
  sessionModeIdFor,
  validateDispatchInput,
} from './dispatch';
import { SCRUBBED_ENV_KEYS } from './agentEnv';
import type { StartRunDeps } from './startRun';

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
  } as unknown as jest.Mocked<LedgerClient>;
  return { ledger, rows };
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
): StartRunDeps & { notify: jest.Mock } {
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
  };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

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
    expect(preview.repo.path).toBe(repoDir);
    expect(preview.repo.projectName).toBe('Roadmap');
    expect(preview.brief).toContain('## Ticket ROAD-116 — Sessions anywhere');
    expect(preview.brief).toContain('State: In Progress');
    expect(preview.liveWriterRunId).toBeNull();
    expect(preview.seededFromRunId).toBeNull();
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
        status: 'approved',
        origin: 'agent_run',
        agentRunId: 'run-inv00001',
        payload: { body: 'Older root cause.' },
        createdAt: '2026-09-10T00:00:00.000Z',
        resolvedAt: '2026-09-10T01:00:00.000Z',
      },
      {
        id: 'prop-new',
        kind: 'comment',
        status: 'approved',
        origin: 'agent_run',
        agentRunId: 'run-inv00001',
        payload: { body: 'The write is not guarded.' },
        createdAt: '2026-09-11T00:00:00.000Z',
        resolvedAt: '2026-09-11T01:00:00.000Z',
      },
      {
        id: 'prop-copilot',
        kind: 'comment',
        status: 'approved',
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
  it('an RCA must be approved, run-filed, and from an Investigate', () => {
    const runs = [run({ id: 'run-inv00001', intent: 'investigate' })];
    const base: LedgerProposal = {
      id: 'p',
      kind: 'comment',
      status: 'approved',
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
    await flush();
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
    await flush();
    const start = daemon.startSession.mock.calls[0][0];
    expect(start.modeId).toBe(AUTO_APPROVE_MODE_ID);
    expect(start.env).toBeDefined();
    for (const key of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'SSH_AUTH_SOCK',
      'GIT_SSH_COMMAND',
      'GIT_ASKPASS',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(SCRUBBED_ENV_KEYS).toContain(key);
      expect(start.env?.[key]).toBe('');
    }
    expect(start.env?.GIT_TERMINAL_PROMPT).toBe('0');
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
    await flush();
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
