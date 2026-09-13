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
    turnCount: 3,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    retryOfRunId: null,
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
      getTicketByIdentifier: jest.fn(async (key: string) =>
        key === 'ROAD-116' ? ticket : null,
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
      },
    ]);
    expect(answer).toContain(
      'showing the person the session options for ROAD-116',
    );
    expect(answer).toContain('You suggested Investigate');
    expect(answer).toContain('Nothing has started');
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
    const { tool } = harness({ runs: [run()], proposals });
    const answer = await tool('get_run').handler({ run_id: 'run-abc1234' });
    expect(answer).toContain('Run run-abc1234 — ROAD-116 · Investigate');
    expect(answer).toContain('Status: needs-review');
    expect(answer).toContain('Intent: Investigate; mode: plan');
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
