import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DaemonRunsApi } from './daemonApi';
import type { AgentRun, LedgerClient } from './ledgerClient';
import { sendRunPrompt } from './sendPrompt';
import { ENGINE_NOT_RUNNING, type StartRunDeps } from './startRun';

// sendRunPrompt's transparent-resume branch goes through resumeRunCore,
// which does real fs checks (assertUnder, a directory stat) — same
// worktree-on-disk setup as startRun.test.ts's own resumeRun suite.
let worktreesDir: string;
beforeAll(() => {
  worktreesDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wp-sendprompt-')),
  );
});
afterAll(() => {
  fs.rmSync(worktreesDir, { recursive: true, force: true });
});

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-abc1234',
    projectId: 'proj-1',
    ticketId: null,
    ownerMemberId: 'mem-1',
    agentId: null,
    entry: 'independent',
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
    providerSessionId: 'sess-old',
    worktreePath: null,
    branch: 'session/abc1234',
    baseRef: 'main',
    prUrl: null,
    status: 'failed',
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
    createdAt: '2026-09-12T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

/** A dead run with a real worktree directory on disk, so resumeRunCore's fs checks pass. */
function deadRun(overrides: Partial<AgentRun> = {}): AgentRun {
  const worktreePath = path.join(worktreesDir, overrides.id ?? 'run-abc1234');
  fs.mkdirSync(worktreePath, { recursive: true });
  return run({ worktreePath, ...overrides });
}

function fakeLedger(seed: AgentRun[] = []) {
  const rows = new Map(seed.map((r) => [r.id, r]));
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
    reopenRun: jest.fn(async (id: string) => {
      const current = rows.get(id);
      if (!current) throw new Error(`no row ${id}`);
      const from = current.status;
      const next = { ...current, status: 'provisioning' } as AgentRun;
      rows.set(id, next);
      return { run: next, from };
    }),
    appendEvent: jest.fn(async () => ({}) as never),
  } as unknown as jest.Mocked<LedgerClient>;
  return { ledger, rows };
}

function fakeDaemon(
  overrides: Partial<Record<keyof DaemonRunsApi, unknown>> = {},
) {
  return {
    startSession: jest.fn(async () => ({ sessionId: 'sess-old' })),
    sendPrompt: jest.fn(async () => {}),
    ...overrides,
  } as unknown as jest.Mocked<DaemonRunsApi>;
}

function depsWith(
  ledger: LedgerClient,
  daemon: DaemonRunsApi | null,
  extra: Partial<StartRunDeps> = {},
): StartRunDeps {
  return {
    ledger,
    daemon: () => daemon,
    worktreesDir,
    git: jest.fn(async () => ({ stdout: '', code: 0 })),
    assertWorktreeGitDir: jest.fn(async () => {}),
    folders: {
      registry: { resolve: jest.fn(), mint: jest.fn() } as never,
      recentsFile: path.join(worktreesDir, 'recent-folders.json'),
      listProjects: jest.fn(async () => []),
    },
    notify: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn() },
    ...extra,
  };
}

describe('sendRunPrompt', () => {
  it('sends straight through when the run is already live — no reopen', async () => {
    const { ledger } = fakeLedger([run({ status: 'running' })]);
    const daemon = fakeDaemon();
    const deps = depsWith(ledger, daemon);

    await expect(
      sendRunPrompt(deps, { runId: 'run-abc1234', text: 'what next?' }),
    ).resolves.toEqual({ outcome: 'sent', status: 'running' });
    expect(daemon.sendPrompt).toHaveBeenCalledWith('run-abc1234', 'what next?');
    expect(ledger.reopenRun).not.toHaveBeenCalled();
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'prompt_sent',
      expect.objectContaining({ by: 'user', kind: 'message' }),
    );
  });

  it.each(['blocked', 'finishing'] as const)(
    'also sends straight through for a %s run',
    async (status) => {
      const { ledger } = fakeLedger([run({ status })]);
      const daemon = fakeDaemon();
      await expect(
        sendRunPrompt(depsWith(ledger, daemon), {
          runId: 'run-abc1234',
          text: 'hi',
        }),
      ).resolves.toEqual({ outcome: 'sent', status });
      expect(ledger.reopenRun).not.toHaveBeenCalled();
    },
  );

  it('revives a dead run and sends the message in one turn when the session is restored', async () => {
    const { ledger, rows } = fakeLedger([deadRun()]);
    const daemon = fakeDaemon();
    const deps = depsWith(ledger, daemon);

    await expect(
      sendRunPrompt(deps, { runId: 'run-abc1234', text: 'still there?' }),
    ).resolves.toEqual({
      outcome: 'resumed-and-sent',
      status: 'running',
      resume: 'loaded',
    });
    expect(ledger.reopenRun).toHaveBeenCalledTimes(1);
    expect(daemon.startSession).toHaveBeenCalledTimes(1);
    // Exactly the user's text — no note prepended, since the session
    // actually loaded.
    expect(daemon.sendPrompt).toHaveBeenCalledTimes(1);
    expect(daemon.sendPrompt).toHaveBeenCalledWith(
      'run-abc1234',
      'still there?',
    );
    expect(rows.get('run-abc1234')?.status).toBe('running');
  });

  it('when context could not be restored, sends the resume note and the message as two separate turns — never a second daemon.sendPrompt for the same message', async () => {
    const { ledger } = fakeLedger([deadRun()]);
    // A different session id than the row's own: replaced-by-new.
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => ({ sessionId: 'sess-fresh' })),
    });
    const deps = depsWith(ledger, daemon);

    await expect(
      sendRunPrompt(deps, { runId: 'run-abc1234', text: 'still there?' }),
    ).resolves.toEqual({
      outcome: 'resumed-and-sent',
      status: 'running',
      resume: 'replaced-by-new',
    });
    // Two sendPrompt calls: the fire-and-forget resume note (from
    // resumeRunCore), then this call's own message — never combined into
    // one, and never sent twice for the same message.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(daemon.sendPrompt.mock.calls.map((c) => c[1])).toEqual([
      'still there?',
      expect.stringContaining('could not be restored'),
    ]);
  });

  it('worktree-gone: the message is NOT sent, and no reopen is attempted past the pre-flight', async () => {
    const { ledger } = fakeLedger([
      run({
        status: 'failed',
        worktreePath: path.join(worktreesDir, 'never-made'),
      }),
    ]);
    const daemon = fakeDaemon();
    const deps = depsWith(ledger, daemon);

    await expect(
      sendRunPrompt(deps, { runId: 'run-abc1234', text: 'hello?' }),
    ).resolves.toEqual({ outcome: 'worktree-gone', status: 'failed' });
    expect(daemon.sendPrompt).not.toHaveBeenCalled();
    expect(daemon.startSession).not.toHaveBeenCalled();
  });

  it('done and needs-review: not-resumable, message NOT sent', async () => {
    const { ledger } = fakeLedger([run({ status: 'done' })]);
    const daemon = fakeDaemon();
    await expect(
      sendRunPrompt(depsWith(ledger, daemon), {
        runId: 'run-abc1234',
        text: 'hi',
      }),
    ).resolves.toEqual({ outcome: 'not-resumable', status: 'done' });
    expect(daemon.sendPrompt).not.toHaveBeenCalled();
  });

  it.each(['queued', 'provisioning'] as const)(
    '%s: not-ready, message NOT sent — a session is already on its way',
    async (status) => {
      const { ledger } = fakeLedger([run({ status })]);
      const daemon = fakeDaemon();
      await expect(
        sendRunPrompt(depsWith(ledger, daemon), {
          runId: 'run-abc1234',
          text: 'hi',
        }),
      ).resolves.toEqual({ outcome: 'not-ready', status });
      expect(daemon.sendPrompt).not.toHaveBeenCalled();
      expect(ledger.reopenRun).not.toHaveBeenCalled();
    },
  );

  it('a refusal from reopenRun itself propagates, and the message is never sent', async () => {
    const { ledger } = fakeLedger([deadRun()]);
    (ledger.reopenRun as jest.Mock).mockRejectedValueOnce(
      new Error(
        'A writing session is already live on this ticket (run-live); resuming this one would make two.',
      ),
    );
    const daemon = fakeDaemon();
    await expect(
      sendRunPrompt(depsWith(ledger, daemon), {
        runId: 'run-abc1234',
        text: 'hi',
      }),
    ).rejects.toThrow(/already live on this ticket/);
    expect(daemon.sendPrompt).not.toHaveBeenCalled();
  });

  it('two concurrent sends to one dead run produce exactly one reopen', async () => {
    const { ledger } = fakeLedger([deadRun()]);
    const daemon = fakeDaemon();
    const deps = depsWith(ledger, daemon);

    await Promise.all([
      sendRunPrompt(deps, { runId: 'run-abc1234', text: 'first' }),
      sendRunPrompt(deps, { runId: 'run-abc1234', text: 'second' }),
    ]);
    // The lock serializes them: the first revives and sends; by the
    // second's turn the run is already `running`, so it just sends.
    expect(ledger.reopenRun).toHaveBeenCalledTimes(1);
    expect(daemon.sendPrompt.mock.calls.map((c) => c[1])).toEqual([
      'first',
      'second',
    ]);
  });

  it('the engine down throws before any ledger write', async () => {
    const { ledger } = fakeLedger([deadRun()]);
    await expect(
      sendRunPrompt(depsWith(ledger, null), {
        runId: 'run-abc1234',
        text: 'hi',
      }),
    ).rejects.toThrow(ENGINE_NOT_RUNNING);
    expect(ledger.reopenRun).not.toHaveBeenCalled();
    expect(ledger.updateRun).not.toHaveBeenCalled();
  });

  describe('input validation', () => {
    const deps = () => depsWith(fakeLedger().ledger, fakeDaemon());

    it('rejects a non-string run id', async () => {
      await expect(
        sendRunPrompt(deps(), { runId: 42, text: 'hi' }),
      ).rejects.toThrow('Not a run id.');
    });

    it('rejects empty or whitespace-only text', async () => {
      await expect(
        sendRunPrompt(deps(), { runId: 'run-abc1234', text: '   ' }),
      ).rejects.toThrow('The message is empty.');
    });

    it('rejects text over the character cap', async () => {
      await expect(
        sendRunPrompt(deps(), {
          runId: 'run-abc1234',
          text: 'x'.repeat(20_001),
        }),
      ).rejects.toThrow('at most 20000 characters');
    });
  });
});
