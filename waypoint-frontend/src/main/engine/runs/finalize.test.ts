import type {
  DaemonRunsApi,
  DaemonSessionSummary,
  DaemonTranscriptTurn,
} from './daemonApi';
import {
  closingMessageOf,
  createRunFinalizer,
  finishedNote,
  isTurnEnded,
  pickReviewState,
  type FinalizeDeps,
} from './finalize';
import type { AgentRun, LedgerClient } from './ledgerClient';

// Host-side finalize against fakes (docs/design/w5a-investigate-fix.md
// §6): the turn-ended fact, proposals filed once, an empty closing
// message → failed, the session killed after, the Copilot note.

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-abc1234',
    projectId: 'proj-1',
    ticketId: 'wi-1',
    ownerMemberId: 'mem-1',
    agentId: null,
    entry: 'dispatched',
    providerId: 'claude',
    title: 'ROAD-116 · Investigate',
    isolation: 'worktree',
    cwd: '/wt/run-abc1234',
    autoApprove: false,
    modeId: 'plan',
    intent: 'investigate',
    copilotConversationId: null,
    daemonWorkspaceId: 'run-abc1234',
    daemonSessionId: 'run-abc1234',
    providerSessionId: 'sess-1',
    worktreePath: '/wt/run-abc1234',
    branch: 'agent/ROAD-116',
    baseRef: 'main',
    prUrl: null,
    status: 'running',
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

function summary(
  overrides: Partial<DaemonSessionSummary> = {},
): DaemonSessionSummary {
  return {
    conversationId: 'run-abc1234',
    providerId: 'claude',
    lifecycle: 'ready',
    isGenerating: false,
    pendingPermissionCount: 0,
    queuedPromptCount: 0,
    lastStopReason: 'end_turn',
    lastTurnErrored: false,
    updatedAt: 1,
    lastOutputAt: 1,
    ...overrides,
  };
}

const turn = (
  items: DaemonTranscriptTurn['items'],
  seq = 1,
): DaemonTranscriptTurn => ({
  id: `t${seq}`,
  seq,
  initiator: 'user',
  items,
  outcome: { kind: 'done', reason: 'end_turn' },
});

function fakeLedger(seed: AgentRun) {
  const rows = new Map([[seed.id, seed]]);
  let proposalSeq = 0;
  const ledger = {
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
    createRunProposal: jest.fn(async () => ({
      id: `prop-${(proposalSeq += 1)}`,
    })),
    listStates: jest.fn(async () => [
      {
        id: 'st-backlog',
        projectId: 'proj-1',
        name: 'Backlog',
        group: 'backlog',
        sortOrder: 0,
      },
      {
        id: 'st-progress',
        projectId: 'proj-1',
        name: 'In Progress',
        group: 'started',
        sortOrder: 2,
      },
      {
        id: 'st-done',
        projectId: 'proj-1',
        name: 'Done',
        group: 'completed',
        sortOrder: 3,
      },
    ]),
    postCopilotNote: jest.fn(async () => true),
  } as unknown as jest.Mocked<LedgerClient>;
  return { ledger, rows };
}

function fakeDaemon(
  options: {
    sessions?: Record<string, DaemonSessionSummary>;
    turns?: DaemonTranscriptTurn[];
  } = {},
) {
  return {
    listSessions: jest.fn(
      async () => options.sessions ?? { 'run-abc1234': summary() },
    ),
    getHistory: jest.fn(
      async () =>
        options.turns ?? [
          turn([
            {
              kind: 'message',
              role: 'assistant',
              text: 'The root cause is X.',
            },
          ]),
        ],
    ),
    killSession: jest.fn(async () => {}),
  } as unknown as jest.Mocked<DaemonRunsApi>;
}

function depsWith(
  ledger: LedgerClient,
  daemon: DaemonRunsApi | null,
  extra: Partial<FinalizeDeps> = {},
) {
  const notify = jest.fn();
  const onRunStatus = jest.fn();
  const deps: FinalizeDeps = {
    ledger,
    daemon: () => daemon,
    notify,
    onRunStatus,
    logger: { info: jest.fn(), warn: jest.fn() },
    confirmMs: 0,
    ...extra,
  };
  return { deps, notify, onRunStatus };
}

describe('isTurnEnded', () => {
  it.each([
    [summary(), true],
    [summary({ isGenerating: true }), false],
    [summary({ pendingPermissionCount: 1 }), false],
    [summary({ queuedPromptCount: 1 }), false],
    [summary({ lastStopReason: null }), false],
    [summary({ lastStopReason: 'cancelled' }), false],
    [summary({ lastStopReason: null, lastTurnErrored: true }), true],
    [summary({ lastStopReason: 'max_tokens' }), true],
  ])('%j → %s', (s, expected) => {
    expect(isTurnEnded(s)).toBe(expected);
  });
});

describe('closingMessageOf', () => {
  it('is the last assistant message of the last turn', () => {
    expect(
      closingMessageOf([
        turn([{ kind: 'message', role: 'assistant', text: 'earlier' }], 1),
        turn(
          [
            { kind: 'message', role: 'user', text: 'the brief' },
            { kind: 'thinking', text: 'hmm' },
            { kind: 'message', role: 'assistant', text: 'first' },
            { kind: 'tool', title: 'Read' },
            { kind: 'message', role: 'assistant', text: '  final  ' },
          ],
          2,
        ),
      ]),
    ).toBe('final');
  });
  it('is null for no turns, or a turn with only user text', () => {
    expect(closingMessageOf([])).toBeNull();
    expect(
      closingMessageOf([
        turn([{ kind: 'message', role: 'user', text: 'brief' }]),
      ]),
    ).toBeNull();
    expect(
      closingMessageOf([
        turn([{ kind: 'message', role: 'assistant', text: '   ' }]),
      ]),
    ).toBeNull();
  });
});

describe('pickReviewState', () => {
  it('prefers a state named for review, else the last started state', () => {
    const states = [
      {
        id: 'a',
        projectId: 'p',
        name: 'Todo',
        group: 'unstarted',
        sortOrder: 1,
      },
      {
        id: 'b',
        projectId: 'p',
        name: 'In Progress',
        group: 'started',
        sortOrder: 2,
      },
      {
        id: 'c',
        projectId: 'p',
        name: 'In Review',
        group: 'started',
        sortOrder: 3,
      },
    ];
    expect(pickReviewState(states)?.id).toBe('c');
    expect(pickReviewState(states.slice(0, 2))?.id).toBe('b');
    expect(pickReviewState(states.slice(0, 1))).toBeNull();
  });
});

describe('createRunFinalizer', () => {
  it('Investigate: finishing → one comment proposal → needs-review, the session killed, the note posted', async () => {
    const { ledger, rows } = fakeLedger(run());
    const daemon = fakeDaemon();
    const { deps, notify, onRunStatus } = depsWith(ledger, daemon);
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    const statuses = ledger.updateRun.mock.calls.map(([, p]) => p.status);
    expect(statuses).toEqual(['finishing', 'needs-review']);
    expect(ledger.createRunProposal).toHaveBeenCalledTimes(1);
    expect(ledger.createRunProposal).toHaveBeenCalledWith('run-abc1234', {
      kind: 'comment',
      body: 'The root cause is X.',
    });
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'proposal_created',
      {
        proposalId: 'prop-1',
        kind: 'comment',
      },
    );
    expect(daemon.killSession).toHaveBeenCalledWith('run-abc1234');
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'session_ended',
      { reason: 'finalized' },
    );
    expect(rows.get('run-abc1234')).toMatchObject({
      status: 'needs-review',
      summary: 'The root cause is X.',
      turnCount: 1,
    });
    expect(notify).toHaveBeenLastCalledWith({
      runId: 'run-abc1234',
      status: 'needs-review',
    });
    expect(onRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'needs-review' }),
      'finishing',
    );
    expect(ledger.postCopilotNote).toHaveBeenCalledWith(
      'run-abc1234',
      'Run ROAD-116 · Investigate finished (1 turn) · 1 proposal filed, waiting for your review.',
    );
  });

  it('Fix: the comment carries the branch work, and the state change goes to the review state', async () => {
    const { ledger } = fakeLedger(
      run({
        intent: 'fix',
        modeId: 'bypassPermissions',
        title: 'ROAD-116 · Fix',
      }),
    );
    const daemon = fakeDaemon({
      turns: [
        turn([
          { kind: 'message', role: 'assistant', text: 'Guarded the write.' },
        ]),
      ],
    });
    const git = jest.fn(async (args: string[]) => {
      if (args[0] === 'log')
        return { stdout: 'abc1234 fix: guard the write\n', code: 0 };
      if (args[0] === 'diff') return { stdout: 'M\tsrc/a.ts\n', code: 0 };
      return { stdout: '', code: 0 };
    });
    const { deps } = depsWith(ledger, daemon, {
      git,
      assertWorktreeGitDir: jest.fn(async () => {}),
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(ledger.createRunProposal).toHaveBeenCalledTimes(2);
    const [, comment] = ledger.createRunProposal.mock.calls[0];
    expect(comment.kind).toBe('comment');
    const body = (comment as { body: string }).body;
    expect(body).toContain('Branch `agent/ROAD-116` from `main`');
    expect(body).toContain('abc1234 fix: guard the write');
    expect(body).toContain('M\tsrc/a.ts');
    expect(body).toMatch(/---\n\nGuarded the write\.$/);
    expect(ledger.createRunProposal).toHaveBeenNthCalledWith(2, 'run-abc1234', {
      kind: 'state_change',
      stateId: 'st-progress',
    });
    expect(ledger.postCopilotNote).toHaveBeenCalledWith(
      'run-abc1234',
      'Run ROAD-116 · Fix finished (1 turn) · 2 proposals filed, waiting for your review.',
    );
  });

  it('a turn that ended with no closing message fails the run, files nothing, kills the session', async () => {
    const { ledger, rows } = fakeLedger(run());
    const daemon = fakeDaemon({
      turns: [turn([{ kind: 'message', role: 'user', text: 'brief' }])],
    });
    const { deps, onRunStatus } = depsWith(ledger, daemon);
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(ledger.createRunProposal).not.toHaveBeenCalled();
    expect(rows.get('run-abc1234')).toMatchObject({
      status: 'failed',
      errorKind: 'finalize',
      errorMessage: 'The agent ended its turn without a closing message.',
    });
    expect(daemon.killSession).toHaveBeenCalled();
    expect(onRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
      'finishing',
    );
    expect(ledger.postCopilotNote).toHaveBeenCalledWith(
      'run-abc1234',
      'Run ROAD-116 · Investigate failed: The agent ended its turn without a closing message.',
    );
  });

  it('a turn that errored fails the run without reading history', async () => {
    const { ledger, rows } = fakeLedger(run());
    const daemon = fakeDaemon({
      sessions: {
        'run-abc1234': summary({ lastStopReason: null, lastTurnErrored: true }),
      },
    });
    const { deps } = depsWith(ledger, daemon);
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(daemon.getHistory).not.toHaveBeenCalled();
    expect(rows.get('run-abc1234')?.status).toBe('failed');
    expect(rows.get('run-abc1234')?.errorMessage).toBe(
      "The agent's turn ended in an error.",
    );
  });

  it('a proposal the backend refuses fails the run rather than leaving nothing to review', async () => {
    const { ledger, rows } = fakeLedger(run());
    ledger.createRunProposal.mockRejectedValueOnce(
      new Error('This run is not attached to a ticket'),
    );
    const { deps } = depsWith(ledger, fakeDaemon());
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(rows.get('run-abc1234')).toMatchObject({
      status: 'failed',
      errorMessage:
        'The proposal could not be filed: This run is not attached to a ticket',
    });
  });

  it.each([
    ['an independent run', run({ entry: 'independent' })],
    ['a run that is not running', run({ status: 'blocked' })],
    ['a run already finishing', run({ status: 'finishing' })],
  ])('declines %s', async (_name, row) => {
    const { ledger } = fakeLedger(row);
    const daemon = fakeDaemon();
    const { deps } = depsWith(ledger, daemon);
    await createRunFinalizer(deps).onSessionIdle(row.id);
    expect(ledger.updateRun).not.toHaveBeenCalled();
    expect(daemon.killSession).not.toHaveBeenCalled();
  });

  it('declines when the fresh session list no longer says idle (a queued prompt was dequeued)', async () => {
    const { ledger } = fakeLedger(run());
    const daemon = fakeDaemon({
      sessions: { 'run-abc1234': summary({ isGenerating: true }) },
    });
    const { deps } = depsWith(ledger, daemon);
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(ledger.updateRun).not.toHaveBeenCalled();
  });

  it('a second idle fact for the same run while one is in flight does nothing', async () => {
    const { ledger } = fakeLedger(run());
    const daemon = fakeDaemon();
    const { deps } = depsWith(ledger, daemon, { confirmMs: 30 });
    const finalizer = createRunFinalizer(deps);
    await Promise.all([
      finalizer.onSessionIdle('run-abc1234'),
      finalizer.onSessionIdle('run-abc1234'),
    ]);
    expect(ledger.createRunProposal).toHaveBeenCalledTimes(1);
    // And a third, after: the run is needs-review, nothing to do.
    await finalizer.onSessionIdle('run-abc1234');
    expect(ledger.createRunProposal).toHaveBeenCalledTimes(1);
  });

  it('does nothing with the engine down', async () => {
    const { ledger } = fakeLedger(run());
    const { deps } = depsWith(ledger, null);
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(ledger.getRun).not.toHaveBeenCalled();
  });
});

describe('finishedNote', () => {
  it("reads from the ledger's facts", () => {
    expect(
      finishedNote(run({ title: null, intent: 'fix' }), {
        turns: 3,
        proposals: 0,
      }),
    ).toBe('Run wi-1 · Fix finished (3 turns) · nothing filed.');
  });
});
