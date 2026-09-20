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
  pickClosingState,
  pickReviewState,
  statePlanFor,
  type FinalizeDeps,
} from './finalize';
import {
  pickClosingTransition,
  pickReviewTransition,
  type JiraRunDeps,
} from './jiraRuns';
import {
  LedgerRequestError,
  type AgentRun,
  type LedgerClient,
} from './ledgerClient';

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
    verdict: null,
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    retryOfRunId: null,
    reopenCount: 0,
    lastReopenedAt: null,
    finalizeCount: 0,
    finalizedHeadSha: null,
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
      {
        id: 'st-cancelled',
        projectId: 'proj-1',
        name: 'Cancelled',
        group: 'cancelled',
        sortOrder: 4,
      },
    ]),
    postCopilotNote: jest.fn(async () => true),
    getTicket: jest.fn(async () => null),
    getTicketRef: jest.fn(async () => null),
    // Never-lock: what a follow-up finalize reads and writes.
    listTicketProposals: jest.fn(async () => []),
    listEvents: jest.fn(async () => []),
    claimPublish: jest.fn(async () => {}),
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
    // Proves whatever cwd the run claims by default — tests that care
    // about a refused cwd override this directly.
    assertPublishableCwd: jest.fn(
      async (r: { worktreePath?: string | null; cwd?: string | null }) =>
        r.worktreePath ?? r.cwd ?? '',
    ),
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

describe('pickClosingState (W5c)', () => {
  const state = (
    id: string,
    name: string,
    group: string,
    sortOrder: number,
  ) => ({
    id,
    projectId: 'p',
    name,
    group,
    sortOrder,
  });
  it('a cancelled-group state named for closing, else the first cancelled-group state, never Done', () => {
    const done = state('d', 'Done', 'completed', 3);
    const cancelled = state('c', 'Cancelled', 'cancelled', 5);
    const wontDo = state('w', "Won't Do", 'cancelled', 4);
    const dup = state('x', 'Duplicate', 'cancelled', 6);
    expect(pickClosingState([done, dup, cancelled, wontDo])?.id).toBe('w');
    expect(
      pickClosingState([done, state('c2', 'Archived', 'cancelled', 5)])?.id,
    ).toBe('c2');
    expect(pickClosingState([done])).toBeNull();
  });
});

describe('statePlanFor (W5c)', () => {
  it.each([
    ['fix', 'fixed', 'review'],
    ['fix', 'partial', 'review'],
    ['fix', 'not-a-bug', 'close'],
    ['fix', 'wont-fix', 'close'],
    ['fix', 'needs-info', null],
    ['fix', null, null],
    ['investigate', 'root-cause', null],
    ['investigate', 'not-a-bug', 'close'],
    ['investigate', 'needs-info', null],
    ['custom', 'wont-fix', null],
    [null, 'fixed', null],
  ] as const)('%s + %s → %s', (intent, verdict, plan) => {
    expect(statePlanFor({ intent }, verdict)).toBe(plan);
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
    // A native ticket's proposal carries no Jira credential.
    // W5c: the board-shaped comment — the verb's default verdict when the
    // session named none, the message as the summary, the footer.
    expect(ledger.createRunProposal).toHaveBeenCalledWith(
      'run-abc1234',
      {
        kind: 'comment',
        body: [
          '**Verdict:** root cause found',
          'The root cause is X.',
          '*Full report — the evidence, files and how it was verified — is on the run in Waypoint (ROAD-116 · Investigate).*',
        ].join('\n\n'),
      },
      { external: false },
    );
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'proposal_created',
      {
        proposalId: 'prop-1',
        kind: 'comment',
      },
    );
    // Never-lock: the session stays alive on success — a finished run is
    // a conversation that can be continued; the ledger remembers the
    // report was filed (finalizeCount) and says so in the trail.
    expect(daemon.killSession).not.toHaveBeenCalled();
    expect(ledger.appendEvent).not.toHaveBeenCalledWith(
      'run-abc1234',
      'session_ended',
      expect.anything(),
    );
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'finalized',
      expect.objectContaining({
        sequence: 1,
        verdict: 'root-cause',
        proposals: [{ id: 'prop-1', kind: 'comment' }],
      }),
    );
    expect(rows.get('run-abc1234')).toMatchObject({
      status: 'needs-review',
      finalizeCount: 1,
      summary: 'The root cause is X.',
      verdict: 'root-cause',
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
      'Run ROAD-116 · Investigate finished (1 turn) · verdict: root cause found · 1 proposal filed, waiting for your review.',
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
    const { body } = comment as { body: string };
    // W5c: the counts, not the listing — the PR body has the listing.
    expect(body).toContain('**Verdict:** fixed');
    expect(body).toContain(
      'Branch `agent/ROAD-116` from `main` · 1 commit · 1 file changed',
    );
    expect(body).not.toContain('abc1234 fix: guard the write');
    expect(body).not.toContain('M\tsrc/a.ts');
    expect(body).toContain('Guarded the write.');
    expect(ledger.createRunProposal).toHaveBeenNthCalledWith(2, 'run-abc1234', {
      kind: 'state_change',
      stateId: 'st-progress',
    });
    expect(ledger.postCopilotNote).toHaveBeenCalledWith(
      'run-abc1234',
      'Run ROAD-116 · Fix finished (1 turn) · verdict: fixed · 2 proposals filed, waiting for your review.',
    );
  });

  // W5c: the verdict drives the state change and the publish.
  it('Investigate that concludes not-a-bug: the closing state proposed, the verdict on the row and in the note', async () => {
    const { ledger, rows } = fakeLedger(run());
    const daemon = fakeDaemon({
      turns: [
        turn([
          {
            kind: 'message',
            role: 'assistant',
            text: 'Verdict: not-a-bug\n## Summary\nThe 500 is the upstream timeout, by design.\n## Details\nsrc/x.ts:3 — the timeout is 2 s on purpose.',
          },
        ]),
      ],
    });
    const { deps } = depsWith(ledger, daemon);
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(ledger.createRunProposal).toHaveBeenCalledTimes(2);
    const [, comment] = ledger.createRunProposal.mock.calls[0];
    const { body } = comment as { body: string };
    expect(body).toContain('**Verdict:** not a bug');
    expect(body).toContain('The 500 is the upstream timeout, by design.');
    expect(body).not.toContain('src/x.ts:3');
    expect(ledger.createRunProposal).toHaveBeenNthCalledWith(2, 'run-abc1234', {
      kind: 'state_change',
      stateId: 'st-cancelled',
    });
    expect(rows.get('run-abc1234')).toMatchObject({
      status: 'needs-review',
      verdict: 'not-a-bug',
      summary: 'The 500 is the upstream timeout, by design.',
    });
    expect(ledger.postCopilotNote).toHaveBeenCalledWith(
      'run-abc1234',
      expect.stringContaining('verdict: not a bug · 2 proposals filed'),
    );
  });

  it("Fix that concludes won't fix: not published, the closing state proposed, never the review state", async () => {
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
          {
            kind: 'message',
            role: 'assistant',
            text: "Verdict: won't fix\n## Summary\nThe ask conflicts with the pricing rule; nothing changed.",
          },
        ]),
      ],
    });
    const publish = jest.fn();
    const { deps } = depsWith(ledger, daemon, {
      pullRequests: { publish, publishFollowUp: jest.fn() },
      git: jest.fn(async () => ({ stdout: '', code: 0 })),
      assertWorktreeGitDir: jest.fn(async () => {}),
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(publish).not.toHaveBeenCalled();
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'note',
      expect.objectContaining({
        message: "not published: the session's verdict was won't fix",
      }),
    );
    const [, comment] = ledger.createRunProposal.mock.calls[0];
    expect((comment as { body: string }).body).toContain(
      "Not published: the session's verdict was won't fix",
    );
    expect(ledger.createRunProposal).toHaveBeenNthCalledWith(2, 'run-abc1234', {
      kind: 'state_change',
      stateId: 'st-cancelled',
    });
  });

  it('needs-info: the comment alone, no state change, no verdict guessed', async () => {
    const { ledger, rows } = fakeLedger(
      run({ intent: 'fix', modeId: 'bypassPermissions' }),
    );
    const daemon = fakeDaemon({
      turns: [
        turn([
          {
            kind: 'message',
            role: 'assistant',
            text: 'Verdict: needs-info\n## Summary\nTwo readings of the spec; a person must pick one.',
          },
        ]),
      ],
    });
    const { deps } = depsWith(ledger, daemon);
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(ledger.createRunProposal).toHaveBeenCalledTimes(1);
    expect(ledger.listStates).not.toHaveBeenCalled();
    expect(rows.get('run-abc1234')?.verdict).toBe('needs-info');
  });

  it('a closing verdict on a project with no cancelled state: the comment alone, said in the trail', async () => {
    const { ledger } = fakeLedger(run());
    ledger.listStates.mockResolvedValue([
      {
        id: 'a',
        projectId: 'proj-1',
        name: 'Todo',
        group: 'unstarted',
        sortOrder: 1,
      },
      {
        id: 'b',
        projectId: 'proj-1',
        name: 'Done',
        group: 'completed',
        sortOrder: 2,
      },
    ]);
    const daemon = fakeDaemon({
      turns: [
        turn([
          {
            kind: 'message',
            role: 'assistant',
            text: 'Verdict: not a bug\n## Summary\nBy design.',
          },
        ]),
      ],
    });
    const { deps } = depsWith(ledger, daemon);
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(ledger.createRunProposal).toHaveBeenCalledTimes(1);
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'note',
      expect.objectContaining({
        plan: 'close',
        offered: ['Todo', 'Done'],
      }),
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

  // Round 5 of review: every first-finalize failure branch killed the
  // session and stopped — a message typed into the outbox while finalize
  // held the row was delivered by nobody (the session it would have gone
  // to was dead, so no live drain ever picked it up). `fail()` drains
  // now, after the kill, so the drain may resume the run for it.
  it('a failed finalize still drains the outbox — after the kill, never before it', async () => {
    const { ledger } = fakeLedger(run());
    const daemon = fakeDaemon({
      turns: [turn([{ kind: 'message', role: 'user', text: 'brief' }])],
    });
    const order: string[] = [];
    daemon.killSession.mockImplementation(async () => {
      order.push('kill');
    });
    const drainOutbox = jest.fn(async () => {
      order.push('drain');
    });
    const { deps } = depsWith(ledger, daemon, { drainOutbox });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(drainOutbox).toHaveBeenCalledWith('run-abc1234');
    expect(order).toEqual(['kill', 'drain']);
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

describe('the transcript snapshot (ROAD-124)', () => {
  it('hands the keeper the turns it read on success — and no kill follows (never-lock)', async () => {
    const { ledger } = fakeLedger(run());
    const daemon = fakeDaemon();
    const order: string[] = [];
    daemon.killSession.mockImplementation(async () => {
      order.push('kill');
    });
    const capture = jest.fn(async (_id: string, turns?: unknown[]) => {
      order.push(`capture:${turns?.length ?? 'read'}`);
    });
    const { deps } = depsWith(ledger, daemon, { transcripts: { capture } });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(order).toEqual(['capture:1']);
  });

  it('still snapshots before the kill on a failure path', async () => {
    const { ledger } = fakeLedger(run());
    const daemon = fakeDaemon({ turns: [] });
    const order: string[] = [];
    daemon.killSession.mockImplementation(async () => {
      order.push('kill');
    });
    const capture = jest.fn(async (_id: string, turns?: unknown[]) => {
      order.push(`capture:${turns?.length ?? 'read'}`);
    });
    const { deps } = depsWith(ledger, daemon, { transcripts: { capture } });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(order).toEqual(['capture:0', 'kill']);
  });
});

// W5b (docs/design/w5b-jira-dispatch.md §2.4, §2.6): a run on a Jira
// issue files through the backend's Jira path — its proposals carry the
// borrowed credential — and a Fix proposes a TRANSITION picked by name.
describe('W5b: a run on a Jira issue', () => {
  const JIRA_REF = {
    id: 'tref-eng4',
    provider: 'jira',
    site: 'yourteam.atlassian.net',
    key: 'ENG-4',
    identifier: 'ENG-4',
    title: 'Checkout 500s',
    url: 'https://yourteam.atlassian.net/browse/ENG-4',
  };
  const transition = (
    id: string,
    targetStateName: string,
    targetStateCategory: 'todo' | 'in-progress' | 'done',
  ) => ({ id, targetStateName, targetStateCategory, requiresFields: [] });

  function jiraWith(
    transitions: ReturnType<typeof transition>[] | { message: string },
    site: string | null = 'yourteam.atlassian.net',
  ): JiraRunDeps {
    return {
      site: () => site,
      getTicket: jest.fn(),
      listComments: jest.fn(),
      listTransitions: jest.fn(async () =>
        Array.isArray(transitions)
          ? { ok: true as const, value: transitions }
          : {
              ok: false as const,
              reason: 'network' as const,
              message: transitions.message,
            },
      ),
    };
  }

  function jiraFixLedger() {
    const seeded = fakeLedger(
      run({
        ticketId: 'tref-eng4',
        projectId: null,
        intent: 'fix',
        modeId: 'bypassPermissions',
        title: 'ENG-4 · Fix',
        branch: 'agent/ENG-4',
      }),
    );
    seeded.ledger.getTicketRef.mockImplementation(async (id: string) =>
      id === 'tref-eng4' ? JIRA_REF : null,
    );
    return seeded;
  }

  it('pickReviewTransition: review by name, else the first in-progress target, else none', () => {
    const review = transition('21', 'In Review', 'in-progress');
    const progress = transition('11', 'In Progress', 'in-progress');
    const done = transition('31', 'Done', 'done');
    expect(pickReviewTransition([done, progress, review])).toBe(review);
    expect(pickReviewTransition([done, progress])).toBe(progress);
    expect(pickReviewTransition([done])).toBeNull();
    expect(pickReviewTransition([])).toBeNull();
  });

  it('pickClosingTransition: a closing name first, else the first done target, else none (W5c)', () => {
    const wontDo = transition('41', "Won't Do", 'done');
    const done = transition('31', 'Done', 'done');
    const progress = transition('11', 'In Progress', 'in-progress');
    expect(pickClosingTransition([progress, done, wontDo])).toBe(wontDo);
    expect(pickClosingTransition([progress, done])).toBe(done);
    expect(pickClosingTransition([progress])).toBeNull();
    expect(
      pickClosingTransition([
        transition('51', 'Cannot Reproduce', 'done'),
        done,
      ])?.id,
    ).toBe('51');
  });

  it('Investigate on a Jira issue that concludes not-a-bug: the closing transition, with the borrowed credential', async () => {
    const { ledger } = fakeLedger(
      run({
        ticketId: 'tref-eng4',
        projectId: null,
        title: 'ENG-4 · Investigate',
      }),
    );
    ledger.getTicketRef.mockResolvedValue(JIRA_REF);
    const daemon = fakeDaemon({
      turns: [
        turn([
          {
            kind: 'message',
            role: 'assistant',
            text: 'Verdict: not-a-bug\n## Summary\nBy design.',
          },
        ]),
      ],
    });
    const jira = jiraWith([
      transition('11', 'In Progress', 'in-progress'),
      transition('31', 'Done', 'done'),
      transition('41', "Won't Do", 'done'),
    ]);
    const { deps } = depsWith(ledger, daemon, { jira });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(ledger.createRunProposal).toHaveBeenCalledTimes(2);
    expect(ledger.createRunProposal).toHaveBeenNthCalledWith(
      2,
      'run-abc1234',
      { kind: 'state_change', stateId: '41' },
      { external: true },
    );
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'proposal_created',
      expect.objectContaining({ stateName: "Won't Do", plan: 'close' }),
    );
  });

  it('Investigate on a Jira issue: the comment rides the borrowed credential; no state change', async () => {
    const { ledger } = fakeLedger(
      run({
        ticketId: 'tref-eng4',
        projectId: null,
        title: 'ENG-4 · Investigate',
      }),
    );
    ledger.getTicketRef.mockResolvedValue(JIRA_REF);
    const jira = jiraWith([transition('21', 'In Review', 'in-progress')]);
    const { deps } = depsWith(ledger, fakeDaemon(), { jira });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(ledger.createRunProposal).toHaveBeenCalledTimes(1);
    expect(ledger.createRunProposal).toHaveBeenCalledWith(
      'run-abc1234',
      {
        kind: 'comment',
        body: expect.stringContaining(
          '**Verdict:** root cause found\n\nThe root cause is X.',
        ),
      },
      { external: true },
    );
    expect(jira.listTransitions).not.toHaveBeenCalled();
    expect(ledger.listStates).not.toHaveBeenCalled();
  });

  it('Fix on a Jira issue: the transition named for review, filed as a state_change with the TRANSITION id', async () => {
    const { ledger } = jiraFixLedger();
    const daemon = fakeDaemon({
      turns: [turn([{ kind: 'message', role: 'assistant', text: 'Fixed.' }])],
    });
    const jira = jiraWith([
      transition('31', 'Done', 'done'),
      transition('11', 'In Progress', 'in-progress'),
      transition('21', 'Code Review', 'in-progress'),
    ]);
    const publish = jest.fn(async () => ({
      kind: 'opened' as const,
      url: 'https://github.com/o/r/pull/70',
      pushed: true as const,
    }));
    const { deps } = depsWith(ledger, daemon, {
      jira,
      pullRequests: { publish, publishFollowUp: jest.fn() },
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    // The PR is titled and linked from the issue's key, title and URL.
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'ENG-4: Checkout 500s',
        ticketUrl: 'https://yourteam.atlassian.net/browse/ENG-4',
      }),
    );
    expect(jira.listTransitions).toHaveBeenCalledWith('ENG-4');
    expect(ledger.createRunProposal).toHaveBeenCalledTimes(2);
    expect(ledger.createRunProposal).toHaveBeenNthCalledWith(
      2,
      'run-abc1234',
      { kind: 'state_change', stateId: '21' },
      { external: true },
    );
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'proposal_created',
      expect.objectContaining({
        kind: 'state_change',
        transitionId: '21',
        stateName: 'Code Review',
      }),
    );
    // Never the native states.
    expect(ledger.listStates).not.toHaveBeenCalled();
    expect(ledger.postCopilotNote).toHaveBeenCalledWith(
      'run-abc1234',
      expect.stringContaining('2 proposals filed'),
    );
  });

  it('Fix with no fitting transition: the comment alone, and a note event naming what the issue offered', async () => {
    const { ledger, rows } = jiraFixLedger();
    const daemon = fakeDaemon({
      turns: [turn([{ kind: 'message', role: 'assistant', text: 'Fixed.' }])],
    });
    const jira = jiraWith([transition('31', 'Done', 'done')]);
    const { deps } = depsWith(ledger, daemon, { jira });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(ledger.createRunProposal).toHaveBeenCalledTimes(1);
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'note',
      expect.objectContaining({
        stage: 'finalize',
        message: expect.stringContaining(
          'no transition to review or in progress',
        ),
        offered: ['Done'],
      }),
    );
    expect(rows.get('run-abc1234')).toMatchObject({ status: 'needs-review' });
    expect(ledger.postCopilotNote).toHaveBeenCalledWith(
      'run-abc1234',
      expect.stringContaining('1 proposal filed'),
    );
  });

  it('Fix when the transitions cannot be read, or Jira is not connected: the comment alone, said in the trail', async () => {
    const unreadable = jiraFixLedger();
    const { deps: a } = depsWith(unreadable.ledger, fakeDaemon(), {
      jira: jiraWith({ message: 'Jira timed out.' }),
    });
    await createRunFinalizer(a).onSessionIdle('run-abc1234');
    expect(unreadable.ledger.createRunProposal).toHaveBeenCalledTimes(1);
    expect(unreadable.ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'note',
      expect.objectContaining({ reason: 'Jira timed out.' }),
    );

    const disconnected = jiraFixLedger();
    const { deps: b } = depsWith(disconnected.ledger, fakeDaemon(), {
      jira: jiraWith([], null),
    });
    await createRunFinalizer(b).onSessionIdle('run-abc1234');
    expect(disconnected.ledger.createRunProposal).toHaveBeenCalledTimes(1);
    expect(disconnected.ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'note',
      expect.objectContaining({
        message: expect.stringContaining('Jira is not connected'),
      }),
    );
  });
});

describe('W6: the branch is published before the proposals', () => {
  it('a Fix leads its comment with the PR, the note names it; Investigate never publishes', async () => {
    const { ledger } = fakeLedger(
      run({
        intent: 'fix',
        modeId: 'bypassPermissions',
        title: 'ROAD-116 · Fix',
      }),
    );
    (ledger as unknown as { getTicket: jest.Mock }).getTicket = jest.fn(
      async () => ({
        id: 'wi-1',
        identifier: 'ROAD-116',
        title: 'Sessions anywhere',
        description: null,
        projectId: 'proj-1',
        stateId: null,
        priority: null,
      }),
    );
    const daemon = fakeDaemon({
      turns: [
        turn([
          { kind: 'message', role: 'assistant', text: 'Guarded the write.' },
        ]),
      ],
    });
    const publish = jest.fn(async () => ({
      kind: 'opened' as const,
      url: 'https://github.com/o/r/pull/61',
      pushed: true as const,
    }));
    const { deps } = depsWith(ledger, daemon, {
      pullRequests: { publish, publishFollowUp: jest.fn() },
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        closingMessage: 'Guarded the write.',
        title: 'ROAD-116: Sessions anywhere',
      }),
    );
    const [, comment] = ledger.createRunProposal.mock.calls[0];
    expect((comment as { body: string }).body).toContain(
      'Pull request: https://github.com/o/r/pull/61',
    );
    expect(ledger.postCopilotNote).toHaveBeenCalledWith(
      'run-abc1234',
      expect.stringContaining('PR opened: https://github.com/o/r/pull/61'),
    );
    // Publish comes before the proposals are filed.
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(
      ledger.createRunProposal.mock.invocationCallOrder[0],
    );

    const investigate = fakeLedger(run());
    const { deps: planDeps } = depsWith(investigate.ledger, fakeDaemon(), {
      pullRequests: { publish, publishFollowUp: jest.fn() },
    });
    await createRunFinalizer(planDeps).onSessionIdle('run-abc1234');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('a failed publish is a sentence on the comment and in the note; the run still reaches needs-review', async () => {
    const { ledger, rows } = fakeLedger(
      run({
        intent: 'fix',
        modeId: 'bypassPermissions',
        title: 'ROAD-116 · Fix',
      }),
    );
    (ledger as unknown as { getTicket: jest.Mock }).getTicket = jest.fn(
      async () => null,
    );
    const daemon = fakeDaemon({
      turns: [
        turn([
          { kind: 'message', role: 'assistant', text: 'Guarded the write.' },
        ]),
      ],
    });
    const publish = jest.fn(async () => ({
      kind: 'failed' as const,
      stage: 'push' as const,
      message: 'could not read Username',
    }));
    const { deps } = depsWith(ledger, daemon, {
      pullRequests: { publish, publishFollowUp: jest.fn() },
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(rows.get('run-abc1234')?.status).toBe('needs-review');
    const [, comment] = ledger.createRunProposal.mock.calls[0];
    expect((comment as { body: string }).body).toContain(
      'push failed: could not read Username',
    );
    expect(ledger.postCopilotNote).toHaveBeenCalledWith(
      'run-abc1234',
      expect.stringContaining('the branch was not published (push failed)'),
    );
  });

  it('ROAD-131: a run whose cwd fails the provenance check is never published — refused before publish is ever called, and the failure is reported the same way a push failure is', async () => {
    const { ledger, rows } = fakeLedger(
      run({
        intent: 'fix',
        modeId: 'bypassPermissions',
        title: 'ROAD-116 · Fix',
        worktreePath: '/wt/poisoned',
      }),
    );
    (ledger as unknown as { getTicket: jest.Mock }).getTicket = jest.fn(
      async () => null,
    );
    const daemon = fakeDaemon({
      turns: [
        turn([
          { kind: 'message', role: 'assistant', text: 'Guarded the write.' },
        ]),
      ],
    });
    const publish = jest.fn();
    const assertPublishableCwd = jest.fn(async () => {
      throw new Error(
        "This worktree's gitdir is inside the worktree itself, where the agent writes. Refusing to run git in it.",
      );
    });
    const { deps } = depsWith(ledger, daemon, {
      pullRequests: { publish, publishFollowUp: jest.fn() },
      assertPublishableCwd,
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(assertPublishableCwd).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: '/wt/poisoned' }),
    );
    expect(publish).not.toHaveBeenCalled();
    expect(rows.get('run-abc1234')?.status).toBe('needs-review');
    const [, comment] = ledger.createRunProposal.mock.calls[0];
    expect((comment as { body: string }).body).toContain(
      "push failed: This worktree's gitdir is inside the worktree itself",
    );
  });

  // Found in review, round 3: a run's first-ever publish used to skip
  // both the claim and the ticket lock entirely — only a follow-up's
  // publish took either. Two runs finalizing for the first time on the
  // same ticket at once could each open a competing PR with nothing to
  // serialize them.
  it('a run’s first-ever publish takes the same claim and ticket lock a follow-up’s does', async () => {
    const { ledger, rows } = fakeLedger(
      run({ intent: 'fix', modeId: 'bypassPermissions' }),
    );
    const daemon = fakeDaemon({
      turns: [
        turn([{ kind: 'message', role: 'assistant', text: 'Fixed it.' }]),
      ],
    });
    const publish = jest.fn(async () => ({
      kind: 'opened' as const,
      url: 'https://github.com/o/r/pull/1',
      pushed: true as const,
    }));
    const order: string[] = [];
    const withTicketLock = jest.fn(
      async <T>(_t: string, fn: () => Promise<T>): Promise<T> => {
        order.push('lock');
        const r = await fn();
        order.push('unlock');
        return r;
      },
    ) as unknown as FinalizeDeps['withTicketLock'] & jest.Mock;
    (ledger.claimPublish as jest.Mock).mockImplementation(async () => {
      order.push('claim');
    });
    const { deps } = depsWith(ledger, daemon, {
      git: (args: string[]) =>
        Promise.resolve(
          args[0] === 'rev-parse'
            ? { stdout: 'aaaaaaa\n', stderr: '', code: 0 }
            : { stdout: '', stderr: '', code: 0 },
        ),
      assertWorktreeGitDir: jest.fn(async () => {}),
      pullRequests: { publish, publishFollowUp: jest.fn() },
      withTicketLock,
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(order).toEqual(['lock', 'claim', 'unlock']);
    expect(withTicketLock).toHaveBeenCalledWith('wi-1', expect.any(Function));
    expect(ledger.claimPublish).toHaveBeenCalledWith('run-abc1234', 'aaaaaaa');
    expect(publish).toHaveBeenCalledTimes(1);
    // Publish happens inside the lock, strictly before the claim is
    // released — proven by `order` above; the row itself only needs to
    // reach needs-review (the real publisher, not this bare mock, is
    // what writes prUrl to the ledger — covered in pullRequests.test.ts).
    expect(rows.get('run-abc1234')?.status).toBe('needs-review');
  });

  it('a refused publish claim on a first-ever publish still files the comment, unpublished — the note says why, not just the follow-up path', async () => {
    const { ledger, rows } = fakeLedger(
      run({ intent: 'fix', modeId: 'bypassPermissions' }),
    );
    const daemon = fakeDaemon({
      turns: [
        turn([{ kind: 'message', role: 'assistant', text: 'Fixed it.' }]),
      ],
    });
    (ledger.claimPublish as jest.Mock).mockRejectedValue(
      new LedgerRequestError(
        409,
        'Not published: this ticket has a live writer (Other).',
      ),
    );
    const publish = jest.fn();
    const { deps } = depsWith(ledger, daemon, {
      pullRequests: { publish, publishFollowUp: jest.fn() },
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(publish).not.toHaveBeenCalled();
    expect(rows.get('run-abc1234')?.status).toBe('needs-review');
    const [, comment] = ledger.createRunProposal.mock.calls[0];
    expect((comment as { body: string }).body).toContain('live writer (Other)');
    // The Copilot note must say why too — this line used to be
    // suppressed for a first-ever publish (finishedNote's own `&&
    // outcome.followUp` guard), which would have gone silent here.
    expect(ledger.postCopilotNote).toHaveBeenCalledWith(
      'run-abc1234',
      expect.stringContaining('live writer (Other)'),
    );
  });

  it('a non-409 claim failure on a first-ever publish never throws past this — the run still reaches needs-review, not wedged at finishing', async () => {
    const { ledger, rows } = fakeLedger(
      run({ intent: 'fix', modeId: 'bypassPermissions' }),
    );
    const daemon = fakeDaemon({
      turns: [
        turn([{ kind: 'message', role: 'assistant', text: 'Fixed it.' }]),
      ],
    });
    (ledger.claimPublish as jest.Mock).mockRejectedValue(
      new Error('ledger request timed out'),
    );
    const publish = jest.fn();
    const { deps } = depsWith(ledger, daemon, {
      pullRequests: { publish, publishFollowUp: jest.fn() },
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(publish).not.toHaveBeenCalled();
    // The old bug: this used to throw out of the whole finalize call,
    // leaving the row at `finishing` forever.
    expect(rows.get('run-abc1234')?.status).toBe('needs-review');
    const [, comment] = ledger.createRunProposal.mock.calls[0];
    expect((comment as { body: string }).body).toContain(
      'Could not claim the publish',
    );
  });

  // Found in review, round 3: this failure used to only warn, kill the
  // session, and return — leaving the run at `finishing` forever, same
  // wedge as the follow-up path's identical failure.
  it('a failure writing needs-review does not wedge the first finalize at finishing — it becomes failed (revivable) instead', async () => {
    const { ledger, rows } = fakeLedger(
      run({ intent: 'investigate' }),
    );
    const daemon = fakeDaemon({
      turns: [
        turn([
          { kind: 'message', role: 'assistant', text: 'The root cause is X.' },
        ]),
      ],
    });
    const realUpdateRun = ledger.updateRun.getMockImplementation()!;
    (ledger.updateRun as jest.Mock).mockImplementation(
      async (id: string, patch: Record<string, unknown>) => {
        if (patch.status === 'needs-review') {
          throw new Error('ledger unreachable');
        }
        return realUpdateRun(id, patch);
      },
    );
    const { deps } = depsWith(ledger, daemon);
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(rows.get('run-abc1234')?.status).toBe('failed');
    expect(rows.get('run-abc1234')?.errorMessage).toContain(
      'Could not record the finalized report',
    );
    // The success path keeps the session alive (never-lock); a failed
    // write is no reason to take it down (round 5 of review).
    expect(daemon.killSession).not.toHaveBeenCalled();
  });
});

// Never-lock (design §4): a run whose report is filed (finalizeCount > 0)
// is a conversation. Its later turns REST unless the agent explicitly
// ends one with a report; then a follow-up is filed, and published only
// when there are new commits.
describe('follow-up finalize (a continued run)', () => {
  const filed = (over: Partial<AgentRun> = {}) =>
    run({
      status: 'running',
      entry: 'dispatched',
      intent: 'fix',
      ticketId: 'wi-1',
      modeId: 'bypassPermissions',
      branch: 'agent/ROAD-1',
      worktreePath: '/wt/run-abc1234',
      finalizeCount: 1,
      finalizedHeadSha: 'aaaaaaa',
      verdict: 'fixed',
      summary: 'Fixed it.',
      prUrl: 'https://github.com/a/b/pull/1',
      ...over,
    });
  const gitWith = (opts: { head?: string; count?: string }) =>
    jest.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse')
        return { stdout: `${opts.head ?? 'aaaaaaa'}\n`, code: 0 };
      if (args[0] === 'rev-list')
        return { stdout: `${opts.count ?? '0'}\n`, code: 0 };
      return { stdout: '', code: 0 };
    });

  // Round 5 of review: rest() — new in this PR, six call sites — had its
  // own warn-and-return on a failed status write, the third copy of the
  // wedge round 3 and round 4 each fixed once. There is one copy now
  // (settle), and this is its regression test.
  it('a failed status write in REST does not wedge the run at finishing — it becomes failed, and the outbox still drains', async () => {
    const { ledger, rows } = fakeLedger(filed());
    const daemon = fakeDaemon({
      turns: [turn([{ kind: 'message', role: 'assistant', text: 'ok' }])],
    });
    const realUpdateRun = ledger.updateRun.getMockImplementation()!;
    (ledger.updateRun as jest.Mock).mockImplementation(
      async (id: string, patch: Record<string, unknown>) => {
        if (patch.status === 'done' || patch.status === 'needs-review') {
          throw new Error('ledger unreachable');
        }
        return realUpdateRun(id, patch);
      },
    );
    const drainOutbox = jest.fn(async () => {});
    const { deps } = depsWith(ledger, daemon, { drainOutbox });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(rows.get('run-abc1234')?.status).toBe('failed');
    expect(rows.get('run-abc1234')?.errorMessage).toContain(
      'Could not record that the turn was conversation',
    );
    expect(drainOutbox).toHaveBeenCalledWith('run-abc1234');
    expect(daemon.killSession).not.toHaveBeenCalled();
  });

  it('a plain answer (no Verdict line) RESTS: no proposal, no publish, summary/verdict untouched, back to done with no open proposals — and the outbox drained last', async () => {
    const { ledger, rows } = fakeLedger(filed());
    const daemon = fakeDaemon({
      turns: [
        turn([
          {
            kind: 'message',
            role: 'assistant',
            text: 'Because setDate keeps the wall-clock time.',
          },
        ]),
      ],
    });
    const drainOutbox = jest.fn(async () => {});
    const { deps, notify } = depsWith(ledger, daemon, {
      git: gitWith({}),
      assertWorktreeGitDir: jest.fn(async () => {}),
      drainOutbox,
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(ledger.createRunProposal).not.toHaveBeenCalled();
    expect(rows.get('run-abc1234')).toMatchObject({
      status: 'done',
      summary: 'Fixed it.',
      verdict: 'fixed',
      finalizeCount: 1,
    });
    expect(notify).toHaveBeenLastCalledWith({
      runId: 'run-abc1234',
      status: 'done',
    });
    expect(daemon.killSession).not.toHaveBeenCalled();
    expect(ledger.postCopilotNote).not.toHaveBeenCalled();
    expect(drainOutbox).toHaveBeenCalledWith('run-abc1234');
  });

  it('RESTS to needs-review when the run still has open proposals', async () => {
    const { ledger, rows } = fakeLedger(filed());
    (ledger.listTicketProposals as jest.Mock).mockResolvedValue([
      {
        id: 'prop-1',
        agentRunId: 'run-abc1234',
        status: 'proposed',
        kind: 'comment',
        payload: {},
      },
    ]);
    const daemon = fakeDaemon({
      turns: [turn([{ kind: 'message', role: 'assistant', text: 'Sure.' }])],
    });
    const { deps } = depsWith(ledger, daemon, { git: gitWith({}) });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(rows.get('run-abc1234')?.status).toBe('needs-review');
  });

  it('an answer with new commits but no report RESTS and leaves a marker note: "N new commits, not published"', async () => {
    const { ledger } = fakeLedger(filed());
    const daemon = fakeDaemon({
      turns: [
        turn([
          { kind: 'message', role: 'assistant', text: 'Tidied the lockfile.' },
        ]),
      ],
    });
    const { deps } = depsWith(ledger, daemon, {
      git: gitWith({ head: 'bbbbbbb', count: '2' }),
      assertWorktreeGitDir: jest.fn(async () => {}),
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(ledger.createRunProposal).not.toHaveBeenCalled();
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'note',
      expect.objectContaining({
        stage: 'finalize',
        unpublishedCommits: 2,
        headSha: 'bbbbbbb',
        afterTurnId: 't1',
      }),
    );
  });

  it('an explicit report with new commits FILES a follow-up and PUBLISHES under the claim and the ticket lock; the verdict’s default is never applied', async () => {
    const { ledger, rows } = fakeLedger(filed());
    const daemon = fakeDaemon({
      turns: [
        turn([
          {
            kind: 'message',
            role: 'assistant',
            text: 'Verdict: fixed\n\n## Summary\nAlso handled DST.',
          },
        ]),
      ],
    });
    const publishFollowUp = jest.fn(async () => ({
      kind: 'updated' as const,
      url: 'https://github.com/a/b/pull/1',
      pushed: true as const,
    }));
    const order: string[] = [];
    const withTicketLock = jest.fn(
      async <T>(_t: string, fn: () => Promise<T>): Promise<T> => {
        order.push('lock');
        const r = await fn();
        order.push('unlock');
        return r;
      },
    ) as unknown as FinalizeDeps['withTicketLock'] & jest.Mock;
    (ledger.claimPublish as jest.Mock).mockImplementation(async () => {
      order.push('claim');
    });
    const { deps } = depsWith(ledger, daemon, {
      git: gitWith({ head: 'bbbbbbb', count: '1' }),
      assertWorktreeGitDir: jest.fn(async () => {}),
      pullRequests: { publish: jest.fn(), publishFollowUp },
      withTicketLock,
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(order).toEqual(['lock', 'claim', 'unlock']);
    expect(withTicketLock).toHaveBeenCalledWith('wi-1', expect.any(Function));
    expect(ledger.claimPublish).toHaveBeenCalledWith('run-abc1234', 'bbbbbbb');
    expect(publishFollowUp).toHaveBeenCalledTimes(1);
    expect(ledger.createRunProposal).toHaveBeenCalledWith(
      'run-abc1234',
      expect.objectContaining({
        kind: 'comment',
        // The filed comment itself names the updated PR (review round 4:
        // runComment.ts's 'updated' case was only unit-tested; this is
        // the real path through finalize).
        body: expect.stringMatching(
          /Follow-up 2[\s\S]*Pull request updated: https:\/\/github\.com\/a\/b\/pull\/1/,
        ),
      }),
      expect.anything(),
    );
    // Same verdict as before: no state-change proposal again.
    expect(ledger.createRunProposal).toHaveBeenCalledTimes(1);
    expect(rows.get('run-abc1234')).toMatchObject({
      status: 'needs-review',
      finalizeCount: 2,
      finalizedHeadSha: 'bbbbbbb',
      summary: 'Also handled DST.',
      prUrl: 'https://github.com/a/b/pull/1',
    });
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'finalized',
      expect.objectContaining({
        sequence: 2,
        pr: { action: 'updated', url: 'https://github.com/a/b/pull/1' },
        newCommits: 1,
      }),
    );
    expect(ledger.postCopilotNote).toHaveBeenCalledWith(
      'run-abc1234',
      expect.stringContaining('follow-up 2'),
    );
    expect(daemon.killSession).not.toHaveBeenCalled();
  });

  it('a refused publish claim (another writer holds the ticket) still files the comment, unpublished, with how to retry', async () => {
    const { ledger, rows } = fakeLedger(filed());
    const daemon = fakeDaemon({
      turns: [
        turn([
          {
            kind: 'message',
            role: 'assistant',
            text: 'Verdict: fixed\n\n## Summary\nMore.',
          },
        ]),
      ],
    });
    (ledger.claimPublish as jest.Mock).mockRejectedValue(
      new LedgerRequestError(
        409,
        'Not published: this ticket has a live writer (Other).',
      ),
    );
    const publishFollowUp = jest.fn();
    const { deps } = depsWith(ledger, daemon, {
      git: gitWith({ head: 'ccccccc', count: '3' }),
      assertWorktreeGitDir: jest.fn(async () => {}),
      pullRequests: { publish: jest.fn(), publishFollowUp },
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(publishFollowUp).not.toHaveBeenCalled();
    expect(ledger.createRunProposal).toHaveBeenCalledTimes(1);
    expect(rows.get('run-abc1234')?.status).toBe('needs-review');
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'finalized',
      expect.objectContaining({
        pr: expect.objectContaining({
          action: 'skipped',
          reason: expect.stringMatching(
            /live writer \(Other\).*Open PR from the run header/,
          ),
        }),
      }),
    );
  });

  // Found in review, round 3: a non-409 claim failure (a timeout, a 5xx)
  // used to rethrow uncaught out of publishOnce, past withTicketLock,
  // wedging the run at `finishing` forever — no later idle event ever
  // retries a run once it has left `running`.
  it('a non-409 claim failure never throws past this — the follow-up still files its comment and reaches needs-review, not wedged at finishing', async () => {
    const { ledger, rows } = fakeLedger(filed());
    const daemon = fakeDaemon({
      turns: [
        turn([
          {
            kind: 'message',
            role: 'assistant',
            text: 'Verdict: fixed\n\n## Summary\nMore.',
          },
        ]),
      ],
    });
    (ledger.claimPublish as jest.Mock).mockRejectedValue(
      new Error('ledger request timed out'),
    );
    const publishFollowUp = jest.fn();
    const { deps } = depsWith(ledger, daemon, {
      git: gitWith({ head: 'ccccccc', count: '3' }),
      assertWorktreeGitDir: jest.fn(async () => {}),
      pullRequests: { publish: jest.fn(), publishFollowUp },
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(publishFollowUp).not.toHaveBeenCalled();
    expect(ledger.createRunProposal).toHaveBeenCalledTimes(1);
    // The old bug: this used to throw out of the whole finalize call,
    // leaving the row at `finishing` forever.
    expect(rows.get('run-abc1234')?.status).toBe('needs-review');
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'finalized',
      expect.objectContaining({
        pr: expect.objectContaining({
          action: 'failed',
          reason: expect.stringContaining('Could not claim the publish'),
        }),
      }),
    );
  });

  // Found in review, round 3: a failure writing the final `needs-review`
  // status used to only warn and return, leaving the run at `finishing`
  // forever — its proposals (filed just before, successfully) exist, but
  // the row itself never moves, and no later idle event retries it.
  it('a failure writing needs-review does not wedge the follow-up at finishing — it becomes failed (revivable) instead, and the outbox still gets a drain attempt', async () => {
    const { ledger, rows } = fakeLedger(filed());
    const daemon = fakeDaemon({
      turns: [
        turn([
          {
            kind: 'message',
            role: 'assistant',
            text: 'Verdict: fixed\n\n## Summary\nMore.',
          },
        ]),
      ],
    });
    const realUpdateRun = ledger.updateRun.getMockImplementation()!;
    (ledger.updateRun as jest.Mock).mockImplementation(
      async (id: string, patch: Record<string, unknown>) => {
        if (patch.status === 'needs-review') {
          throw new Error('ledger unreachable');
        }
        return realUpdateRun(id, patch);
      },
    );
    const drainOutbox = jest.fn(async () => {});
    const publishFollowUp = jest.fn(async () => ({
      kind: 'updated' as const,
      url: 'https://github.com/a/b/pull/1',
      pushed: true as const,
    }));
    const { deps } = depsWith(ledger, daemon, {
      git: gitWith({ head: 'ccccccc', count: '3' }),
      assertWorktreeGitDir: jest.fn(async () => {}),
      pullRequests: { publish: jest.fn(), publishFollowUp },
      drainOutbox,
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(rows.get('run-abc1234')?.status).toBe('failed');
    expect(rows.get('run-abc1234')?.errorMessage).toContain(
      "Could not record the follow-up's report",
    );
    expect(drainOutbox).toHaveBeenCalledWith('run-abc1234');
    // Follow-ups keep the session alive on purpose — this failure is not
    // a reason to kill it.
    expect(daemon.killSession).not.toHaveBeenCalled();
  });

  // Found in review: the follow-up path's own closing-verdict branch
  // (hand-duplicated from the first-finalize one at line ~498) had no
  // test of its own — only the non-closing publish/REST paths were
  // covered in this describe block.
  it("a follow-up that concludes won't fix: not published, same as a first finalize's own closing branch — never a re-file of the closed verdict", async () => {
    const { ledger, rows } = fakeLedger(filed({ verdict: 'wont-fix' }));
    const daemon = fakeDaemon({
      turns: [
        turn([
          {
            kind: 'message',
            role: 'assistant',
            text: "Verdict: won't fix\n## Summary\nStill conflicts with the pricing rule on a second look.",
          },
        ]),
      ],
    });
    const publishFollowUp = jest.fn();
    const { deps } = depsWith(ledger, daemon, {
      git: gitWith({ head: 'ddddddd', count: '1' }),
      assertWorktreeGitDir: jest.fn(async () => {}),
      pullRequests: { publish: jest.fn(), publishFollowUp },
    });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');

    expect(publishFollowUp).not.toHaveBeenCalled();
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'finalized',
      expect.objectContaining({
        sequence: 2,
        pr: {
          action: 'skipped',
          reason: "the session's verdict was won't fix",
        },
      }),
    );
    const [, comment] = ledger.createRunProposal.mock.calls[0];
    expect((comment as { body: string }).body).toContain(
      "Not published: the session's verdict was won't fix",
    );
    // Same verdict as before this follow-up (`wont-fix` → `wont-fix`):
    // no second state-change proposal for a closing state already set.
    expect(ledger.createRunProposal).toHaveBeenCalledTimes(1);
    expect(rows.get('run-abc1234')).toMatchObject({
      status: 'needs-review',
      finalizeCount: 2,
      verdict: 'wont-fix',
    });
  });

  it('a report that repeats the last filed summary is conversation: RESTS', async () => {
    const { ledger } = fakeLedger(filed());
    (ledger.listEvents as jest.Mock).mockResolvedValue([
      {
        runId: 'run-abc1234',
        seq: 5,
        kind: 'finalized',
        payload: { sequence: 1, summary: 'Fixed it.' },
        at: '',
      },
    ]);
    const daemon = fakeDaemon({
      turns: [
        turn([
          {
            kind: 'message',
            role: 'assistant',
            text: 'Verdict: fixed\n\n## Summary\nFixed it.',
          },
        ]),
      ],
    });
    const { deps } = depsWith(ledger, daemon, { git: gitWith({}) });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(ledger.createRunProposal).not.toHaveBeenCalled();
  });

  it('a turn that answered a legacy resume-note prompt is never a report (first finalize or not)', async () => {
    const { ledger } = fakeLedger(
      run({
        status: 'running',
        entry: 'dispatched',
        intent: 'fix',
        ticketId: 'wi-1',
        worktreePath: '/wt/x',
      }),
    );
    const daemon = fakeDaemon({
      turns: [
        turn([
          {
            kind: 'message',
            role: 'user',
            text: 'Waypoint resumed this run after an interruption, but your previous conversation could not be restored, so this is a fresh session in the same worktree. Here is where things stand.\n\nBranch: x',
          },
          {
            kind: 'message',
            role: 'assistant',
            text: 'Understood. Standing by.',
          },
        ]),
      ],
    });
    const { deps } = depsWith(ledger, daemon, { git: gitWith({}) });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(ledger.createRunProposal).not.toHaveBeenCalled();
    expect(daemon.killSession).not.toHaveBeenCalled();
  });

  it('an errored turn on a continued run RESTS with a note — never `failed`', async () => {
    const { ledger, rows } = fakeLedger(filed());
    const daemon = fakeDaemon({
      sessions: { 'run-abc1234': summary({ lastTurnErrored: true }) },
    });
    const { deps } = depsWith(ledger, daemon, { git: gitWith({}) });
    await createRunFinalizer(deps).onSessionIdle('run-abc1234');
    expect(rows.get('run-abc1234')?.status).toBe('done');
    expect(daemon.killSession).not.toHaveBeenCalled();
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'note',
      expect.objectContaining({
        stage: 'finalize',
        rest: expect.stringContaining('error'),
      }),
    );
  });
});
