import type { AgentRun, AgentRunStatus } from '@/types/agentRuns';
import {
  pendingReasonSentence,
  providerView,
  runTitle,
  shortRunId,
  STATUS_VIEW,
  waitingReason,
  worktreeRecreatedNotice,
} from './sessionStatus';

const ALL: AgentRunStatus[] = [
  'queued',
  'provisioning',
  'running',
  'blocked',
  'finishing',
  'needs-review',
  'done',
  'interrupted',
  'failed',
  'cancelled',
];

const run = (over: Partial<AgentRun>): AgentRun =>
  ({ id: 'run-abc1234', status: 'running', ...over }) as AgentRun;

describe('STATUS_VIEW', () => {
  it('names every agent_run_status once, with a label, a sentence and a dot colour', () => {
    ALL.forEach((status) => {
      const view = STATUS_VIEW[status];
      expect(view.label).toBeTruthy();
      expect(view.sentence).toMatch(/\.$/);
      expect(view.dotClass).toMatch(/^bg-/);
    });
  });

  it('live means the daemon should have a session; stoppable follows the status machine', () => {
    expect(ALL.filter((s) => STATUS_VIEW[s].live)).toEqual([
      'running',
      'blocked',
      'finishing',
    ]);
    // needs-review has no cancelled arrow; the three terminal states are over.
    expect(ALL.filter((s) => !STATUS_VIEW[s].stoppable)).toEqual([
      'needs-review',
      'done',
      'failed',
      'cancelled',
    ]);
  });

  // Never-lock (2026-09-20): no status view may carry a gate on the
  // composer, and no sentence may tell a person a run is over for good.
  it('has no `resumable` (or any other composer gate) and never says a session has ended or cannot be resumed', () => {
    ALL.forEach((status) => {
      const view = STATUS_VIEW[status] as unknown as Record<string, unknown>;
      expect(view).not.toHaveProperty('resumable');
      expect(view).not.toHaveProperty('canCompose');
      expect(String(view.sentence)).not.toMatch(
        /has ended|nothing to resume|cannot be resumed|can't be resumed/i,
      );
    });
    // Every status that is not live says what a message does.
    ALL.filter((s) => !STATUS_VIEW[s].live).forEach((status) => {
      expect(STATUS_VIEW[status].sentence).toMatch(
        /Message it to continue|message you send now goes/,
      );
    });
  });
});

// ROAD-XXX: the two worktree notices a resume can end in — recreated
// (what survived depends only on whether the branch did), or genuinely
// unrecoverable (which now means the recreation attempt failed, not that
// none was made). A plain folder has no branch to recreate from at all.
describe('worktree notices', () => {
  it('recreated: names what survived by whether the branch did', () => {
    expect(worktreeRecreatedNotice(true)).toMatch(/Committed work is intact/);
    expect(worktreeRecreatedNotice(true)).toMatch(/uncommitted changes.*gone/);
    expect(worktreeRecreatedNotice(false)).toMatch(/could not be recovered/);
    expect(worktreeRecreatedNotice(false)).toMatch(/fresh branch/);
  });
});

// Never-lock (design §2.4): the outbox's own sentences — a message that
// is waiting is never a message that was refused.
describe('pendingReasonSentence', () => {
  it('says when Waypoint sends it, per reason, and never reads as a refusal', () => {
    const reasons = [
      'starting',
      'finishing',
      'folder-missing',
      'repository-missing',
      'spawn-failed',
      'owner-offline',
    ] as const;
    reasons.forEach((reason) => {
      const text = pendingReasonSentence(reason, {
        cwd: '/w/run',
        lastError: 'boom',
        ownerName: 'Ana',
      });
      expect(text).toMatch(/Waiting to send|Queued for/);
      expect(text).not.toMatch(/not sent|refused|cannot send|has ended/i);
    });
    expect(pendingReasonSentence('folder-missing', { cwd: '/w/run' })).toMatch(
      /at \/w\/run/,
    );
    expect(
      pendingReasonSentence('spawn-failed', { lastError: 'boom' }),
    ).toMatch(/\(boom\)/);
    expect(
      pendingReasonSentence('owner-offline', { ownerName: 'Ana' }),
    ).toMatch(/Ana's Waypoint/);
    expect(pendingReasonSentence('owner-offline')).toMatch(/the run owner/);
  });

  // B4 (PR #88 review): unlike every reason above, `closed` never clears
  // on its own — runs:close already deleted the worktree and branch on
  // purpose — so it is deliberately left out of the "Waiting to send"
  // sweep above rather than dressed up as one more thing Waypoint will
  // eventually retry.
  it("names 'closed' as a dead end, not a retry", () => {
    const text = pendingReasonSentence('closed');
    expect(text).toMatch(/new session/i);
    expect(text).not.toMatch(/Waiting to send|press Resend/i);
  });
});

describe('waitingReason', () => {
  it('is the ledger’s reason for a blocked run, a fixed sentence for needs-review, nothing otherwise', () => {
    expect(
      waitingReason(
        run({ status: 'blocked', blockedReason: 'Wants to run pnpm test' }),
      ),
    ).toBe('Wants to run pnpm test');
    expect(waitingReason(run({ status: 'blocked', blockedReason: null }))).toBe(
      'Waiting for your permission',
    );
    expect(waitingReason(run({ status: 'needs-review' }))).toBe(
      'Proposals need your review',
    );
    expect(waitingReason(run({ status: 'running' }))).toBeNull();
    expect(waitingReason(run({ status: 'done' }))).toBeNull();
  });
});

describe('runTitle', () => {
  it('prefers the ticket, then the branch, then the id', () => {
    expect(runTitle(run({ branch: 'feat/x' }), 'ROAD-61 · Session list')).toBe(
      'ROAD-61 · Session list',
    );
    expect(runTitle(run({ branch: 'feat/x' }), null)).toBe('feat/x');
    expect(runTitle(run({ branch: null }), undefined)).toBe('Session abc1234');
    expect(shortRunId('run-abc1234')).toBe('abc1234');
  });
});

describe('providerView', () => {
  it('names the providers the plugin manifests name, and shows an unknown id as itself', () => {
    expect(providerView('claude')).toMatchObject({
      name: 'Claude Code',
      letter: 'C',
    });
    expect(providerView('codex')).toMatchObject({ name: 'Codex', letter: 'C' });
    expect(providerView('some-new-agent')).toMatchObject({
      name: 'some-new-agent',
      letter: 'S',
    });
  });
});
