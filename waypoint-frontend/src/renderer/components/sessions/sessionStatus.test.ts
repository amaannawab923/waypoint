import type { AgentRun, AgentRunStatus } from '@/types/agentRuns';
import {
  providerView,
  runTitle,
  shortRunId,
  STATUS_VIEW,
  waitingReason,
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
    for (const status of ALL) {
      const view = STATUS_VIEW[status];
      expect(view.label).toBeTruthy();
      expect(view.sentence).toMatch(/\.$/);
      expect(view.dotClass).toMatch(/^bg-/);
    }
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
