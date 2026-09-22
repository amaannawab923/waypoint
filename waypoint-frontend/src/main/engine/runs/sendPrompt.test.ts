import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DaemonRunsApi } from './daemonApi';
import type { AgentRun, LedgerClient } from './ledgerClient';
import { clearWarmed, warmRun } from './warm';
import {
  arrivalEntriesForTests,
  deliverPendingAfterFinalize,
  drainIfLive,
  dropPendingPrompt,
  recordArrival,
  retryPendingPrompt,
  sendRunPrompt,
  waitingBefore,
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
    // B4: resumeRunCore's "was this worktree deliberately closed"
    // check (startRun.ts's wasClosedByRunsClose) reads events; no test
    // here models a closed run, so an empty history is always correct.
    listEvents: jest.fn(async () => []),
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
    createConversation: jest.fn(async () => ({ mismatch: [] })),
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

  it('a live-status run the daemon has no session for is registered in the conversation index, then started, then sent — even when the index refuses', async () => {
    const { ledger } = fakeLedger([run({ status: 'running' })]);
    const daemon = fakeDaemon({
      createConversation: jest.fn(async () => {
        throw new Error('index down');
      }),
    });
    const deps = depsWith(ledger, daemon);

    await sendRunPrompt(deps, { runId: 'run-abc1234', text: 'still there?' });
    expect(daemon.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'run-abc1234' }),
    );
    expect(daemon.createConversation.mock.invocationCallOrder[0]).toBeLessThan(
      daemon.startSession.mock.invocationCallOrder[0],
    );
    expect(daemon.startSession).toHaveBeenCalledTimes(1);
    expect(daemon.sendPrompt).toHaveBeenCalledWith(
      'run-abc1234',
      'still there?',
      undefined,
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'engine: conversation registration failed',
      expect.objectContaining({ runId: 'run-abc1234', message: 'index down' }),
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

  // Round 5 of review: all three resume-then-deliver paths guessed
  // `{providerSessionId, loaded: true}` the moment the daemon listed a
  // session — and after a warm-up it always does — so warm.ts's own
  // answer (the provider REPLACED the session) was thrown away: the send
  // said `loaded`, no context-lost note reached the agent, and the ledger
  // kept the dead session id. One helper decides now, warm-up first.
  describe('a warm-up that lost the conversation is honored by every path that sends next', () => {
    const warmedReplaced = async () => {
      const { ledger, rows, pending } = fakeLedger([
        deadRun({ status: 'done', providerSessionId: 'sess-old' }),
      ]);
      const daemon = fakeDaemon({
        // The provider could not restore sess-old: a fresh session.
        startSession: jest.fn(async () => ({ sessionId: 'sess-new' })),
        listSessions: jest.fn(async () => ({})),
      });
      const deps = depsWith(ledger, daemon);
      await expect(warmRun(deps, 'run-abc1234')).resolves.toMatchObject({
        kind: 'warmed',
        loaded: false,
      });
      // From here on the daemon lists the warmed session as live.
      daemon.listSessions.mockImplementation(async () => live('run-abc1234'));
      daemon.startSession.mockClear();
      return { ledger, rows, pending, daemon, deps };
    };

    it('sendRunPrompt: replaced-by-new, the note rides along, the new id is recorded', async () => {
      const { rows, daemon, deps } = await warmedReplaced();
      const result = await sendRunPrompt(deps, {
        runId: 'run-abc1234',
        text: 'go on',
      });
      expect(result).toMatchObject({
        outcome: 'continued',
        resume: 'replaced-by-new',
      });
      expect(daemon.startSession).not.toHaveBeenCalled();
      const [, , hidden] = daemon.sendPrompt.mock.calls[0];
      expect(hidden).toMatch(/could not be restored|fresh session/i);
      expect(rows.get('run-abc1234')?.providerSessionId).toBe('sess-new');
    });

    it('retryPendingPrompt: the same', async () => {
      const { ledger, rows, daemon, deps } = await warmedReplaced();
      await ledger.createPendingPrompt('run-abc1234', {
        text: 'again',
        reason: 'finishing',
      });
      const result = await retryPendingPrompt(deps, { runId: 'run-abc1234' });
      expect(result).toMatchObject({ resume: 'replaced-by-new' });
      expect(daemon.startSession).not.toHaveBeenCalled();
      expect(rows.get('run-abc1234')?.providerSessionId).toBe('sess-new');
    });

    it('deliverPendingAfterFinalize: the same', async () => {
      const { ledger, rows, daemon, deps } = await warmedReplaced();
      await ledger.createPendingPrompt('run-abc1234', {
        text: 'after',
        reason: 'finishing',
      });
      await deliverPendingAfterFinalize(deps, 'run-abc1234');
      expect(daemon.startSession).not.toHaveBeenCalled();
      const [, , hidden] = daemon.sendPrompt.mock.calls[0];
      expect(hidden).toMatch(/could not be restored|fresh session/i);
      expect(rows.get('run-abc1234')?.providerSessionId).toBe('sess-new');
    });
  });

  // Found in review: the arrival tracker that decides FIFO order for a
  // busy-outboxed row is a process-wide table, one entry per message
  // ever outboxed via the busy path, for the process's whole lifetime —
  // unbounded unless pruned. Pruning it by "not in THIS run's open
  // rows", done naively (a flat `Map<pendingId, arrival>`), would delete
  // another run's still-open entry too, since pending ids carry no run
  // of their own to check against — the fix nests the table by runId so
  // pruning stays correctly scoped. Tested directly against
  // `waitingBefore` (the one place the table is read and pruned) rather
  // than through a full send/warm-up/deliver choreography — the table's
  // own bookkeeping has nothing to do with the daemon or the lock, and a
  // direct test is deterministic where an end-to-end one would be at the
  // mercy of the busy path's own fire-and-forget background drain.
  describe('the arrival table (waitingBefore)', () => {
    const depsFor = (rows: PendingPrompt[]) =>
      depsWith(
        {
          listPendingPrompts: jest.fn(async () => rows),
        } as unknown as LedgerClient,
        fakeDaemon(),
      );
    const row = (id: string, seq: number): PendingPrompt =>
      ({
        id,
        runId: 'irrelevant-to-waitingBefore',
        seq,
        byMemberId: 'mem-1',
        text: 'x',
        reason: 'starting',
        state: 'queued',
        autoAttempts: 0,
        lastError: null,
        claimedAt: null,
        resolvedAt: null,
        createdAt: '2026-09-20T00:00:00.000Z',
      }) as PendingPrompt;

    it('prunes an entry the instant its row is no longer open, and never before', async () => {
      recordArrival('run-a', 'pp-1', 0);
      expect(arrivalEntriesForTests('run-a')).toBe(1);

      // Still open: not pruned.
      await waitingBefore(depsFor([row('pp-1', 1)]), 'run-a', 99);
      expect(arrivalEntriesForTests('run-a')).toBe(1);

      // Delivered now (excluded by openRows): pruned on the very next read.
      await waitingBefore(depsFor([]), 'run-a', 100);
      expect(arrivalEntriesForTests('run-a')).toBe(0);
    });

    it("never touches another run's entries — the direct regression for the naive flat-map bug", async () => {
      recordArrival('run-a', 'pp-a1', 0);
      recordArrival('run-b', 'pp-b1', 1);
      expect(arrivalEntriesForTests('run-a')).toBe(1);
      expect(arrivalEntriesForTests('run-b')).toBe(1);

      // run-b's own row settles and its own waitingBefore call prunes it —
      // run-a is never named here at all.
      await waitingBefore(depsFor([]), 'run-b', 50);
      expect(arrivalEntriesForTests('run-b')).toBe(0);
      // A naive flat map, pruned by "not in run-b's open rows", would
      // have deleted 'pp-a1' too — it is still here.
      expect(arrivalEntriesForTests('run-a')).toBe(1);
    });

    // Found in review, round 2: pruning only ever ran inside
    // `waitingBefore`, reached only by a plain (non-busy) send. A row
    // outboxed while the run was busy — recorded via `recordArrival` at
    // its `sendRunPrompt` call site — settles through the busy path's own
    // follow-up drain (or a Retry, a Drop, finalize's delivery), never
    // through another plain send for that run: its entry orphaned
    // indefinitely. `drainIfLive` is exactly that follow-up drain (mount,
    // focus, boot, and the busy path's own fire-and-forget call all reach
    // it), so it now prunes too, even on a run that no longer exists —
    // the prune runs before the rest of the function has anything to do.
    it('drainIfLive prunes a settled entry too — the follow-up path a busy send actually takes, not just a later plain send', async () => {
      recordArrival('run-c', 'pp-c1', 0);
      expect(arrivalEntriesForTests('run-c')).toBe(1);

      // The row already delivered/dropped elsewhere; the run itself no
      // longer resolves — the prune still has to run before any of that
      // is known, since it happens first.
      const deps = depsWith(
        {
          listPendingPrompts: jest.fn(async () => []),
          getRun: jest.fn(async () => undefined),
        } as unknown as LedgerClient,
        fakeDaemon(),
      );
      await drainIfLive(deps, 'run-c');
      expect(arrivalEntriesForTests('run-c')).toBe(0);
    });

    it('dropPendingPrompt prunes the exact row it drops, without waiting for any drain', async () => {
      recordArrival('run-d', 'pp-d1', 0);
      const deps = depsWith(
        {
          updatePendingPrompt: jest.fn(async () => ({}) as PendingPrompt),
        } as unknown as LedgerClient,
        fakeDaemon(),
      );
      await dropPendingPrompt(deps, { runId: 'run-d', pendingId: 'pp-d1' });
      expect(arrivalEntriesForTests('run-d')).toBe(0);
    });
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

  // Found in review, round 4: of the three resume-then-deliver paths,
  // this one alone never handed the daemon's live session to the resume.
  // A done/needs-review run whose session finalize kept alive is not LIVE
  // (running/blocked), and warm.ts never warms an already-live session,
  // so `takeWarmed` was empty — resumeRunCore took the session for cold
  // and asked the daemon to start a conversation it already had.
  it('a retry on a finished run whose session is still alive continues it — never a second startSession', async () => {
    const { ledger, pending } = fakeLedger([
      deadRun({ status: 'done', providerSessionId: 'sess-old' }),
    ]);
    const row = await ledger.createPendingPrompt('run-abc1234', {
      text: 'again',
      reason: 'finishing',
    });
    const daemon = fakeDaemon({
      listSessions: jest.fn(async () => live('run-abc1234')),
    });
    const result = await retryPendingPrompt(depsWith(ledger, daemon), {
      runId: 'run-abc1234',
    });
    expect(daemon.startSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'resumed-and-sent' });
    expect(pending.get(row.id)?.state).toBe('delivered');
    expect(daemon.sendPrompt).toHaveBeenCalledWith(
      'run-abc1234',
      'again',
      undefined,
    );
  });
});
