import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DaemonRunsApi } from './daemonApi';
import type { AgentRun, LedgerClient } from './ledgerClient';
import { clearWarmed, warmRun } from './warm';
import {
  deliverPendingAfterFinalize,
  retryPendingPrompt,
  sendRunPrompt,
  type SendPromptDeps,
} from './sendPrompt';
import type { PendingPrompt } from '../types';
import { ENGINE_NOT_RUNNING } from './startRun';

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

/** A dead run with a real worktree directory on disk, so resumeRunCore's fs checks pass. */
function deadRun(overrides: Partial<AgentRun> = {}): AgentRun {
  const worktreePath = path.join(worktreesDir, overrides.id ?? 'run-abc1234');
  fs.mkdirSync(worktreePath, { recursive: true });
  return run({ worktreePath, ...overrides });
}

function fakeLedger(seed: AgentRun[] = []) {
  const rows = new Map(seed.map((r) => [r.id, r]));
  const pending = new Map<string, PendingPrompt>();
  const ledger = {
    // A missing worktree's reprovision path (resumeRunCore, ROAD-XXX)
    // reads the run's project for a repoPath to recreate from — proj-1
    // has one (so a missing worktree recovers); proj-nolink does not (so
    // it still genuinely refuses).
    getProject: jest.fn(async (id: string) => {
      if (id === 'proj-1')
        return { id, name: 'Waypoint', repoPath: worktreesDir };
      if (id === 'proj-nolink') return { id, name: 'Docs', repoPath: null };
      return null;
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
    reopenRun: jest.fn(async (id: string) => {
      const current = rows.get(id);
      if (!current) throw new Error(`no row ${id}`);
      const from = current.status;
      const next = { ...current, status: 'provisioning' } as AgentRun;
      rows.set(id, next);
      return { run: next, from };
    }),
    appendEvent: jest.fn(async () => ({}) as never),
    getTranscript: jest.fn(async () => null),
    // Never-lock: the per-run outbox, in memory, with the backend's own
    // state rules.
    listPendingPrompts: jest.fn(async (id: string) =>
      [...pending.values()]
        .filter((p) => p.runId === id)
        .sort((a, b) => a.seq - b.seq),
    ),
    createPendingPrompt: jest.fn(
      async (id: string, input: { text: string; reason: string }) => {
        const seq =
          [...pending.values()].filter((p) => p.runId === id).length + 1;
        const row: PendingPrompt = {
          id: `pp-${id}-${seq}`,
          runId: id,
          seq,
          byMemberId: 'mem-1',
          text: input.text,
          reason: input.reason as PendingPrompt['reason'],
          state: 'queued',
          autoAttempts: 0,
          lastError: null,
          claimedAt: null,
          resolvedAt: null,
          createdAt: '2026-09-20T00:00:00.000Z',
        };
        pending.set(row.id, row);
        return row;
      },
    ),
    updatePendingPrompt: jest.fn(
      async (_id: string, pendingId: string, patch: Partial<PendingPrompt>) => {
        const row = pending.get(pendingId);
        if (!row) throw new Error(`no pending ${pendingId}`);
        const next = { ...row, ...patch } as PendingPrompt;
        pending.set(pendingId, next);
        return next;
      },
    ),
  } as unknown as jest.Mocked<LedgerClient>;
  return { ledger, rows, pending };
}

function fakeDaemon(
  overrides: Partial<Record<keyof DaemonRunsApi, unknown>> = {},
) {
  return {
    startSession: jest.fn(async () => ({ sessionId: 'sess-old' })),
    sendPrompt: jest.fn(async () => {}),
    // The daemon's live sessions — none unless a test says so.
    listSessions: jest.fn(async () => ({})),
    getHistory: jest.fn(async () => []),
    // Only exercised by a resume that needs to reprovision a missing
    // worktree (ROAD-XXX) — a plain, present worktree never reaches these.
    registerRepository: jest.fn(async (id: string, p: string) => ({
      id,
      kind: 'repository' as const,
      path: p,
      parentId: null,
      observedStatus: 'present' as const,
      creation: null,
      lastCreateOutcome: null,
    })),
    disableArtifactCopy: jest.fn(async () => {}),
    listLocalBranches: jest.fn(async () => ['main']),
    deleteWorktree: jest.fn(async () => {}),
    createWorktree: jest.fn(async (req: { workspaceId: string }) => ({
      id: req.workspaceId,
      kind: 'worktree' as const,
      path: path.join(worktreesDir, req.workspaceId),
      parentId: 'repo-1',
      observedStatus: 'present' as const,
      creation: {
        branch: 'session/abc1234',
        baseRef: 'main',
        requestedPath: '',
      },
      lastCreateOutcome: { status: 'succeeded' as const, at: 1 },
    })),
    ...overrides,
  } as unknown as jest.Mocked<DaemonRunsApi>;
}

function depsWith(
  ledger: LedgerClient,
  daemon: DaemonRunsApi | null,
  extra: Partial<SendPromptDeps> = {},
): SendPromptDeps {
  return {
    currentMemberId: () => 'mem-1',
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

/** A session the daemon holds for the run, idle or working. */
const live = (id: string, working = false) => ({
  [id]: {
    conversationId: id,
    providerId: 'claude',
    lifecycle: 'ready',
    isGenerating: working,
    pendingPermissionCount: 0,
    updatedAt: 1,
  },
});

beforeEach(() => clearWarmed());

// Never-lock (2026-09-20, design §2.3): every send lands somewhere.
describe('sendRunPrompt', () => {
  it('sends straight through when the run is live and idle — no reopen', async () => {
    const { ledger } = fakeLedger([run({ status: 'running' })]);
    const daemon = fakeDaemon({
      listSessions: jest.fn(async () => live('run-abc1234')),
    });
    const deps = depsWith(ledger, daemon);

    await expect(
      sendRunPrompt(deps, { runId: 'run-abc1234', text: 'what next?' }),
    ).resolves.toEqual({ outcome: 'sent', status: 'running' });
    expect(daemon.sendPrompt).toHaveBeenCalledWith(
      'run-abc1234',
      'what next?',
      undefined,
    );
    expect(ledger.reopenRun).not.toHaveBeenCalled();
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'prompt_sent',
      expect.objectContaining({ by: 'user', kind: 'message' }),
    );
  });

  it('while the agent is working the daemon queues it: `queued`, still delivered, never refused', async () => {
    const { ledger } = fakeLedger([run({ status: 'running' })]);
    const daemon = fakeDaemon({
      listSessions: jest.fn(async () => live('run-abc1234', true)),
    });
    await expect(
      sendRunPrompt(depsWith(ledger, daemon), {
        runId: 'run-abc1234',
        text: 'and also',
      }),
    ).resolves.toEqual({ outcome: 'queued', status: 'running' });
    expect(daemon.sendPrompt).toHaveBeenCalledWith(
      'run-abc1234',
      'and also',
      undefined,
    );
  });

  it('finishing: outboxed under `finishing` — finalize holds the row; the text leaves the box', async () => {
    const { ledger, pending } = fakeLedger([run({ status: 'finishing' })]);
    const daemon = fakeDaemon({
      listSessions: jest.fn(async () => live('run-abc1234')),
    });
    const result = await sendRunPrompt(depsWith(ledger, daemon), {
      runId: 'run-abc1234',
      text: 'one more thing',
    });
    expect(result).toMatchObject({
      outcome: 'outboxed',
      status: 'finishing',
      pending: { reason: 'finishing', text: 'one more thing' },
    });
    expect(daemon.sendPrompt).not.toHaveBeenCalled();
    expect([...pending.values()]).toHaveLength(1);
  });

  it.each(['queued', 'provisioning'] as const)(
    '%s: a start is on its way — outboxed under `starting`, no second start',
    async (status) => {
      const { ledger } = fakeLedger([run({ status })]);
      const daemon = fakeDaemon();
      const result = await sendRunPrompt(depsWith(ledger, daemon), {
        runId: 'run-abc1234',
        text: 'hi',
      });
      expect(result).toMatchObject({
        outcome: 'outboxed',
        status,
        pending: { reason: 'starting' },
      });
      expect(daemon.startSession).not.toHaveBeenCalled();
      expect(ledger.reopenRun).not.toHaveBeenCalled();
    },
  );

  it('a finished run whose session is still alive is `continued` in one step: reopen, running, the message with the continuation note', async () => {
    const { ledger, rows } = fakeLedger([
      deadRun({
        status: 'done',
        entry: 'dispatched',
        finalizeCount: 1,
        verdict: 'fixed',
        ticketId: 'wi-1',
      }),
    ]);
    const daemon = fakeDaemon({
      listSessions: jest.fn(async () => live('run-abc1234')),
    });
    const result = await sendRunPrompt(depsWith(ledger, daemon), {
      runId: 'run-abc1234',
      text: 'why setDate?',
    });
    expect(result).toMatchObject({
      outcome: 'continued',
      status: 'running',
      resume: 'loaded',
    });
    expect(ledger.reopenRun).toHaveBeenCalledTimes(1);
    expect(daemon.startSession).not.toHaveBeenCalled();
    expect(daemon.sendPrompt).toHaveBeenCalledTimes(1);
    const [, text, hidden] = daemon.sendPrompt.mock.calls[0];
    expect(text).toBe('why setDate?');
    expect(hidden).toMatch(/last report was already filed/);
    expect(rows.get('run-abc1234')?.status).toBe('running');
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-abc1234',
      'prompt_sent',
      expect.objectContaining({ continued: true, from: 'done' }),
    );
  });

  it("a dead run with no session is resumed, then sent — the user's own text, no note when the session loaded", async () => {
    const { ledger } = fakeLedger([deadRun()]);
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
    expect(daemon.sendPrompt).toHaveBeenCalledTimes(1);
    expect(daemon.sendPrompt).toHaveBeenCalledWith(
      'run-abc1234',
      'still there?',
      undefined,
    );
  });

  it('when context could not be restored, the branch-state note rides on the message as hiddenContext — one prompt, not two', async () => {
    const { ledger } = fakeLedger([deadRun()]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => ({ sessionId: 'sess-fresh' })),
    });
    const git = jest.fn(async (args: string[]) => ({
      stdout: args[0] === 'log' ? 'abc first\n' : '',
      code: 0,
    }));
    const result = await sendRunPrompt(depsWith(ledger, daemon, { git }), {
      runId: 'run-abc1234',
      text: 'where were we?',
    });
    expect(result).toMatchObject({
      outcome: 'resumed-and-sent',
      resume: 'replaced-by-new',
    });
    expect(daemon.sendPrompt).toHaveBeenCalledTimes(1);
    const [, text, hidden] = daemon.sendPrompt.mock.calls[0];
    expect(text).toBe('where were we?');
    expect(hidden).toContain('could not be restored');
    expect(hidden).toContain('abc first');
  });

  it('done and needs-review are continued like any other status (never-lock)', async () => {
    const { ledger, rows } = fakeLedger([deadRun({ status: 'needs-review' })]);
    const daemon = fakeDaemon();
    await expect(
      sendRunPrompt(depsWith(ledger, daemon), {
        runId: 'run-abc1234',
        text: 'a question',
      }),
    ).resolves.toMatchObject({
      outcome: 'resumed-and-sent',
      status: 'running',
    });
    expect(rows.get('run-abc1234')?.status).toBe('running');
  });

  it('no repository to recreate the worktree from: outboxed under `repository-missing`, nothing reopened, nothing sent', async () => {
    const { ledger } = fakeLedger([
      run({
        status: 'failed',
        projectId: 'proj-nolink',
        worktreePath: path.join(worktreesDir, 'never-made'),
      }),
    ]);
    const daemon = fakeDaemon();
    const result = await sendRunPrompt(depsWith(ledger, daemon), {
      runId: 'run-abc1234',
      text: 'hello?',
    });
    expect(result).toMatchObject({
      outcome: 'outboxed',
      status: 'failed',
      pending: { reason: 'repository-missing', text: 'hello?' },
    });
    expect(daemon.sendPrompt).not.toHaveBeenCalled();
    expect(ledger.reopenRun).not.toHaveBeenCalled();
  });

  it('a missing worktree with a real repo is recreated, then sent', async () => {
    const { ledger } = fakeLedger([
      run({
        status: 'failed',
        worktreePath: path.join(worktreesDir, 'never-made'),
      }),
    ]);
    const daemon = fakeDaemon();
    await expect(
      sendRunPrompt(depsWith(ledger, daemon), {
        runId: 'run-abc1234',
        text: 'still there?',
      }),
    ).resolves.toMatchObject({
      outcome: 'resumed-and-sent',
      resume: 'loaded',
      worktreeRecreated: true,
      branchReused: false,
    });
    expect(daemon.createWorktree).toHaveBeenCalled();
    expect(daemon.sendPrompt).toHaveBeenCalledWith(
      'run-abc1234',
      'still there?',
      expect.stringContaining('worktree'),
    );
  });

  it('a spawn that fails: the run is back where it was and the message waits in the outbox under `spawn-failed`', async () => {
    const { ledger, rows } = fakeLedger([deadRun()]);
    const daemon = fakeDaemon({
      startSession: jest.fn(async () => {
        throw new Error('spawn-failed: no provider');
      }),
    });
    const result = await sendRunPrompt(depsWith(ledger, daemon), {
      runId: 'run-abc1234',
      text: 'hello',
    });
    expect(result).toMatchObject({
      outcome: 'outboxed',
      pending: { reason: 'spawn-failed' },
    });
    expect(rows.get('run-abc1234')?.status).toBe('failed');
  });

  it('a Stop landing mid-resume hands the text back: cancelled-mid-resume, nothing outboxed', async () => {
    const { ledger, rows, pending } = fakeLedger([deadRun()]);
    // reopenRun moves to provisioning; a Stop lands before startSession.
    (ledger.reopenRun as jest.Mock).mockImplementationOnce(
      async (id: string) => {
        const current = rows.get(id)!;
        rows.set(id, { ...current, status: 'cancelled' });
        return {
          run: { ...current, status: 'provisioning' },
          from: current.status,
        };
      },
    );
    const daemon = fakeDaemon();
    await expect(
      sendRunPrompt(depsWith(ledger, daemon), {
        runId: 'run-abc1234',
        text: 'wait',
      }),
    ).resolves.toEqual({
      outcome: 'cancelled-mid-resume',
      status: 'cancelled',
    });
    expect(daemon.sendPrompt).not.toHaveBeenCalled();
    expect(pending.size).toBe(0);
  });

  it("another member's run: outboxed under `owner-offline` for the owner's Waypoint to deliver", async () => {
    const { ledger } = fakeLedger([deadRun({ ownerMemberId: 'mem-2' })]);
    const daemon = fakeDaemon();
    const result = await sendRunPrompt(depsWith(ledger, daemon), {
      runId: 'run-abc1234',
      text: 'from me',
    });
    expect(result).toMatchObject({
      outcome: 'outboxed',
      pending: { reason: 'owner-offline' },
    });
    expect(ledger.reopenRun).not.toHaveBeenCalled();
  });

  it('a send while the run lock is busy (a warm-up in flight) is outboxed at once and delivered when the lock frees', async () => {
    const { ledger, pending } = fakeLedger([deadRun({ status: 'done' })]);
    let release!: () => void;
    const held = new Promise<{ sessionId: string }>((resolve) => {
      release = () => resolve({ sessionId: 'sess-old' });
    });
    const daemon = fakeDaemon({
      startSession: jest.fn(() => held),
      listSessions: jest.fn(async () => ({})),
    });
    const deps = depsWith(ledger, daemon);
    const warming = warmRun(deps, 'run-abc1234'); // holds the run lock until `held` resolves
    const result = await sendRunPrompt(deps, {
      runId: 'run-abc1234',
      text: 'typed mid-warm-up',
    });
    expect(result).toMatchObject({
      outcome: 'outboxed',
      pending: { reason: 'starting' },
    });
    expect(daemon.sendPrompt).not.toHaveBeenCalled();
    // The warm-up lands; the daemon now has the session; the queued drain delivers.
    daemon.listSessions.mockImplementation(async () => live('run-abc1234'));
    release();
    await warming;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    // Not delivered by drainIfLive alone: the run is still `done` (a warm-up
    // never touches the ledger) — it is the next send or finalize that
    // continues it. The row is intact, queued.
    expect([...pending.values()][0]).toMatchObject({
      state: 'queued',
      reason: 'starting',
    });
    const next = await sendRunPrompt(deps, {
      runId: 'run-abc1234',
      text: 'and this',
    });
    expect(next).toMatchObject({ outcome: 'continued' });
    // FIFO: the pending row went first, then the new message.
    expect(daemon.sendPrompt.mock.calls.map((c) => c[1])).toEqual([
      'typed mid-warm-up',
      'and this',
    ]);
    expect([...pending.values()][0].state).toBe('delivered');
  });

  it('two concurrent sends to one dead run produce exactly one reopen and both messages, in order', async () => {
    const { ledger } = fakeLedger([deadRun()]);
    const daemon = fakeDaemon();
    const deps = depsWith(ledger, daemon);
    const [a, b] = await Promise.all([
      sendRunPrompt(deps, { runId: 'run-abc1234', text: 'first' }),
      sendRunPrompt(deps, { runId: 'run-abc1234', text: 'second' }),
    ]);
    expect(ledger.reopenRun).toHaveBeenCalledTimes(1);
    expect(daemon.startSession).toHaveBeenCalledTimes(1);
    expect([a.outcome, b.outcome].sort()).toEqual([
      'outboxed',
      'resumed-and-sent',
    ]);
    // The second was outboxed (lock busy) and drained behind the first.
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
    expect(ledger.createPendingPrompt).not.toHaveBeenCalled();
  });
});

describe('deliverPendingAfterFinalize', () => {
  it('a `finishing` row is delivered once the run rests: reopen, running, the message', async () => {
    const { ledger, rows } = fakeLedger([
      deadRun({ status: 'done', entry: 'dispatched', finalizeCount: 1 }),
    ]);
    await ledger.createPendingPrompt('run-abc1234', {
      text: 'typed during finalize',
      reason: 'finishing',
    });
    const daemon = fakeDaemon({
      listSessions: jest.fn(async () => live('run-abc1234')),
    });
    await deliverPendingAfterFinalize(depsWith(ledger, daemon), 'run-abc1234');
    expect(ledger.reopenRun).toHaveBeenCalledTimes(1);
    expect(rows.get('run-abc1234')?.status).toBe('running');
    expect(daemon.sendPrompt).toHaveBeenCalledWith(
      'run-abc1234',
      'typed during finalize',
      expect.any(String),
    );
  });

  it('is a no-op with nothing pending', async () => {
    const { ledger } = fakeLedger([deadRun({ status: 'done' })]);
    const daemon = fakeDaemon({
      listSessions: jest.fn(async () => live('run-abc1234')),
    });
    await deliverPendingAfterFinalize(depsWith(ledger, daemon), 'run-abc1234');
    expect(ledger.reopenRun).not.toHaveBeenCalled();
  });
});

describe('retryPendingPrompt', () => {
  it('resets automatic attempts and drains, resuming a run that is not live', async () => {
    const { ledger, pending } = fakeLedger([deadRun()]);
    const row = await ledger.createPendingPrompt('run-abc1234', {
      text: 'again',
      reason: 'spawn-failed',
    });
    await ledger.updatePendingPrompt('run-abc1234', row.id, {
      autoAttempts: 3,
    });
    const daemon = fakeDaemon();
    const result = await retryPendingPrompt(depsWith(ledger, daemon), {
      runId: 'run-abc1234',
    });
    expect(result).toMatchObject({ outcome: 'resumed-and-sent' });
    expect(pending.get(row.id)).toMatchObject({
      state: 'delivered',
      autoAttempts: 0,
    });
    expect(daemon.sendPrompt).toHaveBeenCalledWith(
      'run-abc1234',
      'again',
      undefined,
    );
  });
});
