import type { AgentRun, LedgerProposal } from '../engine/runs/ledgerClient';
import {
  buildSessionToolSpecs,
  SESSION_TOOL_NAMES,
  sessionToolsServer,
  type SessionOffer,
  type SessionToolsDeps,
} from './sessionTools';

// The two session tools against a fake ledger
// (docs/design/w5a-investigate-fix.md §6): dispatch_session answers with an
// offer the renderer shows and never starts anything; get_run's shape.

const ticket = {
  id: 'wi-1',
  identifier: 'ROAD-116',
  title: 'Sessions anywhere',
  description: null,
  projectId: 'proj-1',
  stateId: null,
  priority: null,
};

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
    cwd: null,
    autoApprove: false,
    modeId: 'plan',
    intent: 'investigate',
    copilotConversationId: 'conv-1',
    daemonWorkspaceId: null,
    daemonSessionId: null,
    providerSessionId: null,
    worktreePath: null,
    branch: 'agent/ROAD-116',
    baseRef: 'main',
    prUrl: null,
    status: 'needs-review',
    blockedReason: null,
    errorKind: null,
    errorMessage: null,
    summary: 'The root cause is X.',
    verdict: null,
    turnCount: 3,
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
    updatedAt: '2026-09-12T01:00:00.000Z',
    ...overrides,
  };
}

function harness(
  options: {
    runs?: AgentRun[];
    proposals?: LedgerProposal[];
    windowGone?: boolean;
    openPullRequest?: SessionToolsDeps['openPullRequest'];
  } = {},
) {
  const offers: SessionOffer[] = [];
  const deps: SessionToolsDeps = {
    ...(options.openPullRequest
      ? { openPullRequest: options.openPullRequest }
      : {}),
    conversationId: 'conv-1',
    ledger: {
      getTicket: jest.fn(async (id: string) => (id === 'wi-1' ? ticket : null)),
      // W5b: a key resolves in either system; ROAD-116 is native, ENG-4 a
      // Jira issue whose handle is tref-eng4, ENG-9 is in both.
      resolveTicket: jest.fn(async (key: string) => {
        if (key === 'ROAD-116') {
          return {
            provider: 'native' as const,
            id: 'wi-1',
            identifier: 'ROAD-116',
            title: 'Sessions anywhere',
            projectId: 'proj-1',
            url: null,
          };
        }
        if (key === 'ENG-4') {
          return {
            provider: 'jira' as const,
            id: 'tref-eng4',
            identifier: 'ENG-4',
            title: 'Checkout 500s',
            projectId: 'ENG',
            url: 'https://yourteam.atlassian.net/browse/ENG-4',
          };
        }
        if (key === 'ENG-9') {
          throw new Error(
            '"ENG-9" is ambiguous: it names a Waypoint ticket ("A") and a Jira issue ("B").',
          );
        }
        return null;
      }),
      getTicketRef: jest.fn(async (id: string) =>
        id === 'tref-eng4'
          ? {
              id: 'tref-eng4',
              provider: 'jira',
              site: 'yourteam.atlassian.net',
              key: 'ENG-4',
              identifier: 'ENG-4',
              title: 'Checkout 500s',
              url: 'https://yourteam.atlassian.net/browse/ENG-4',
            }
          : null,
      ),
      getRun: jest.fn(
        async (id: string) => options.runs?.find((r) => r.id === id) ?? null,
      ),
      listAllRuns: jest.fn(async () => options.runs ?? []),
      listTicketProposals: jest.fn(async () => options.proposals ?? []),
    },
    offer: (offer) => {
      if (options.windowGone) return false;
      offers.push(offer);
      return true;
    },
  };
  const specs = buildSessionToolSpecs(deps);
  const tool = (name: string) => {
    const spec = specs.find((s) => s.name === name);
    if (!spec) throw new Error(`no tool ${name}`);
    return spec;
  };
  return { deps, specs, tool, offers };
}

describe('sessionToolsServer', () => {
  it('names the server the allowlist expects, with both tools', () => {
    const { deps } = harness();
    const server = sessionToolsServer(deps);
    expect(server.name).toBe('waypoint_sessions');
    expect(server.tools.map((t) => `mcp__${server.name}__${t.name}`)).toEqual([
      ...SESSION_TOOL_NAMES,
    ]);
  });
});

describe('dispatch_session', () => {
  it('resolves the key, hands the renderer the offer, and tells the model nothing started', async () => {
    const { tool, offers } = harness();
    const answer = await tool('dispatch_session').handler({
      ticket: 'road-116',
      intent: 'investigate',
    });
    expect(offers).toEqual([
      {
        conversationId: 'conv-1',
        ticketId: 'wi-1',
        identifier: 'ROAD-116',
        title: 'Sessions anywhere',
        intent: 'investigate',
        note: null,
        history: null,
      },
    ]);
    expect(answer).toContain(
      'showing the person the session options for ROAD-116',
    );
    expect(answer).toContain('You suggested Investigate');
    expect(answer).toContain('ROAD-116 has no earlier runs.');
    expect(answer).toContain('Nothing has started');
  });

  // W5c: the ticket's earlier runs ride on the offer and in the reply —
  // the latest one's verb, status, verdict and PR, from the ledger.
  it("carries the ticket's run history and the latest verdict; a ledger that will not answer still offers", async () => {
    const { tool, offers, deps } = harness({
      runs: [
        run({
          id: 'run-old0000',
          createdAt: '2026-09-10T00:00:00.000Z',
          status: 'done',
          verdict: 'root-cause',
        }),
        run({
          id: 'run-new0000',
          createdAt: '2026-09-12T00:00:00.000Z',
          intent: 'fix',
          title: 'ROAD-116 · Fix',
          status: 'needs-review',
          verdict: 'not-a-bug',
          prUrl: null,
        }),
      ],
    });
    const answer = await tool('dispatch_session').handler({
      ticket: 'ROAD-116',
    });
    expect(deps.ledger.listAllRuns).toHaveBeenCalledWith({ ticketId: 'wi-1' });
    expect(offers[0].history).toEqual({
      runs: 2,
      latest: {
        runId: 'run-new0000',
        title: 'ROAD-116 · Fix',
        intent: 'fix',
        status: 'needs-review',
        verdict: 'not-a-bug',
        prUrl: null,
      },
    });
    expect(answer).toContain(
      'ROAD-116 already has 2 earlier runs · latest: Fix, needs review, verdict: not a bug (run run-new0000).',
    );
    expect(answer).toContain('say so before suggesting another session');

    const failing = harness();
    (failing.deps.ledger.listAllRuns as jest.Mock).mockRejectedValue(
      new Error('ledger down'),
    );
    const answer2 = await failing
      .tool('dispatch_session')
      .handler({ ticket: 'ROAD-116' });
    expect(failing.offers[0].history).toBeNull();
    expect(answer2).toContain('has no earlier runs');
  });

  it('takes a ticket id too, and a note for the brief', async () => {
    const { tool, offers } = harness();
    await tool('dispatch_session').handler({
      ticket: 'wi-1',
      intent: 'custom',
      note: '  List the IPC channels. ',
    });
    expect(offers[0]).toMatchObject({
      ticketId: 'wi-1',
      intent: 'custom',
      note: 'List the IPC channels.',
    });
  });

  it('refuses an unknown key, a malformed one, and a verb it does not know', async () => {
    const { tool, offers } = harness();
    await expect(
      tool('dispatch_session').handler({ ticket: 'ROAD-999' }),
    ).rejects.toThrow('No ticket ROAD-999.');
    await expect(
      tool('dispatch_session').handler({ ticket: '../x' }),
    ).rejects.toThrow(/not a ticket key/);
    const answer = await tool('dispatch_session').handler({
      ticket: 'ROAD-116',
      intent: 'deploy',
    });
    expect(offers[0].intent).toBeNull();
    expect(answer).not.toContain('You suggested');
  });

  it('is an error the model sees when no window can show the offer', async () => {
    const { tool } = harness({ windowGone: true });
    await expect(
      tool('dispatch_session').handler({ ticket: 'ROAD-116' }),
    ).rejects.toThrow(/no window/);
  });

  // W5b: a Jira key resolves to the issue's ledger handle — the offer the
  // renderer opens names `tref-…` and the preview reads the issue live.
  it('resolves a Jira key (or its tref id) to the issue’s handle and names the issue', async () => {
    const { tool, offers, deps } = harness();
    const answer = await tool('dispatch_session').handler({
      ticket: 'eng-4',
      intent: 'fix',
    });
    expect(deps.ledger.resolveTicket).toHaveBeenCalledWith('ENG-4');
    expect(offers[0]).toMatchObject({
      ticketId: 'tref-eng4',
      identifier: 'ENG-4',
      title: 'Checkout 500s',
      intent: 'fix',
    });
    expect(answer).toContain(
      'a Jira issue: https://yourteam.atlassian.net/browse/ENG-4',
    );

    await tool('dispatch_session').handler({ ticket: 'tref-eng4' });
    expect(offers[1]).toMatchObject({
      ticketId: 'tref-eng4',
      identifier: 'ENG-4',
    });
  });

  it('surfaces an ambiguous key as the backend’s sentence, never a guess', async () => {
    const { tool, offers } = harness();
    await expect(
      tool('dispatch_session').handler({ ticket: 'ENG-9' }),
    ).rejects.toThrow(/ambiguous/);
    expect(offers).toEqual([]);
  });
});

describe('get_run', () => {
  const proposals: LedgerProposal[] = [
    {
      id: 'prop-1',
      kind: 'comment',
      status: 'proposed',
      origin: 'agent_run',
      agentRunId: 'run-abc1234',
      payload: { body: 'The root cause is X.\nEvidence: a.ts:12.' },
      createdAt: '2026-09-12T01:00:00.000Z',
      resolvedAt: null,
    },
    {
      id: 'prop-2',
      kind: 'comment',
      status: 'approved',
      origin: 'copilot',
      agentRunId: null,
      payload: { body: 'unrelated' },
      createdAt: '2026-09-12T01:00:00.000Z',
      resolvedAt: null,
    },
  ];

  it('by run id: the facts, what it filed, and its closing message', async () => {
    const { tool } = harness({
      runs: [
        run({ verdict: 'root-cause', prUrl: 'https://github.com/o/r/pull/3' }),
      ],
      proposals,
    });
    const answer = await tool('get_run').handler({ run_id: 'run-abc1234' });
    expect(answer).toContain('Run run-abc1234 — ROAD-116 · Investigate');
    expect(answer).toContain('Status: needs-review');
    expect(answer).toContain('Intent: Investigate; mode: plan');
    // W5c: the verdict and the PR, when the run has them.
    expect(answer).toContain('Verdict: root cause found');
    expect(answer).toContain('Pull request: https://github.com/o/r/pull/3');
    expect(answer).toContain('Branch: agent/ROAD-116 from main');
    expect(answer).toContain('Filed: comment (proposed)');
    expect(answer).toContain(
      'Closing message:\nThe root cause is X.\nEvidence: a.ts:12.',
    );
    expect(answer).not.toContain('unrelated');
  });

  it("by ticket: the ticket's runs newest first, or that it has none", async () => {
    const older = run({
      id: 'run-old00001',
      createdAt: '2026-09-11T00:00:00.000Z',
      title: 'ROAD-116 · Fix',
      intent: 'fix',
    });
    const { tool } = harness({ runs: [older, run()], proposals });
    const answer = await tool('get_run').handler({ ticket: 'ROAD-116' });
    expect(answer.indexOf('run-abc1234')).toBeLessThan(
      answer.indexOf('run-old00001'),
    );
    const none = harness();
    expect(await none.tool('get_run').handler({ ticket: 'ROAD-116' })).toBe(
      'ROAD-116 has no runs yet.',
    );
  });

  it('refuses without an argument, and an unknown run', async () => {
    const { tool } = harness();
    await expect(tool('get_run').handler({})).rejects.toThrow(
      'Pass run_id or ticket.',
    );
    await expect(
      tool('get_run').handler({ run_id: 'run-nope0001' }),
    ).rejects.toThrow('No run run-nope0001.');
    await expect(tool('get_run').handler({ run_id: '../etc' })).rejects.toThrow(
      /Not a run id/,
    );
  });
});

describe('open_pull_request', () => {
  it("publishes the ticket's latest writing run, or says the PR is already open", async () => {
    const openPullRequest = jest.fn(async () => ({
      kind: 'opened' as const,
      url: 'https://github.com/o/r/pull/61',
    }));
    const fix = run({
      id: 'run-fix00001',
      intent: 'fix',
      modeId: 'bypassPermissions',
      title: 'ROAD-116 · Fix',
      status: 'done',
      branch: 'agent/ROAD-116',
    });
    const { tool } = harness({ runs: [run(), fix], openPullRequest });
    const answer = await tool('open_pull_request').handler({
      ticket: 'ROAD-116',
    });
    expect(openPullRequest).toHaveBeenCalledWith('run-fix00001');
    expect(answer).toContain('https://github.com/o/r/pull/61');

    const already = harness({
      runs: [{ ...fix, prUrl: 'https://github.com/o/r/pull/7' }],
      openPullRequest,
    });
    expect(
      await already
        .tool('open_pull_request')
        .handler({ run_id: 'run-fix00001' }),
    ).toContain('already open');
    expect(openPullRequest).toHaveBeenCalledTimes(1);
  });

  it('refuses a plan-mode-only ticket, a run still running, a failed publish, and no engine', async () => {
    const openPullRequest = jest.fn(async () => ({
      kind: 'failed' as const,
      stage: 'push' as const,
      message: 'denied',
    }));
    const { tool } = harness({ runs: [run()], openPullRequest });
    await expect(
      tool('open_pull_request').handler({ ticket: 'ROAD-116' }),
    ).rejects.toThrow(/no writing session/);
    const running = harness({
      runs: [
        run({
          id: 'run-fix00001',
          intent: 'fix',
          modeId: null,
          status: 'running',
          branch: 'agent/x',
        }),
      ],
      openPullRequest,
    });
    await expect(
      running.tool('open_pull_request').handler({ run_id: 'run-fix00001' }),
    ).rejects.toThrow(/is running/);
    const failing = harness({
      runs: [
        run({
          id: 'run-fix00001',
          intent: 'fix',
          modeId: null,
          status: 'done',
          branch: 'agent/x',
        }),
      ],
      openPullRequest,
    });
    await expect(
      failing.tool('open_pull_request').handler({ run_id: 'run-fix00001' }),
    ).rejects.toThrow(/push failed: denied/);
    const noEngine = harness({ runs: [run()] });
    await expect(
      noEngine.tool('open_pull_request').handler({ ticket: 'ROAD-116' }),
    ).rejects.toThrow(/not available/);
  });
});
