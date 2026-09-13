import { createRunNotifications, notificationFor } from './notifications';
import type { AgentRun } from './runs/ledgerClient';

// Only the two transitions notify (docs/design/w5a-investigate-fix.md §1.5).

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-abc1234',
    projectId: 'proj-1',
    ticketId: null,
    ownerMemberId: 'mem-1',
    agentId: null,
    entry: 'independent',
    providerId: 'claude',
    title: 'Rename the dialog',
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
    branch: 'session/abc1234',
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

describe('notificationFor', () => {
  it("blocked: the run's name and the reason", () => {
    expect(
      notificationFor(
        run({ status: 'blocked', blockedReason: 'Wants to run pnpm test' }),
        'running',
      ),
    ).toEqual({
      title: 'Rename the dialog needs you',
      body: 'Wants to run pnpm test',
    });
  });
  it("needs-review: the run's name and its summary", () => {
    expect(
      notificationFor(
        run({ status: 'needs-review', summary: 'The root cause is X.\nmore' }),
        'finishing',
      ),
    ).toEqual({
      title: 'Rename the dialog finished',
      body: 'The root cause is X.',
    });
  });
  it('falls back to the branch, then the id, for a name', () => {
    expect(
      notificationFor(run({ status: 'blocked', title: null }), 'running')
        ?.title,
    ).toBe('session/abc1234 needs you');
    expect(
      notificationFor(
        run({ status: 'blocked', title: null, branch: null }),
        'running',
      )?.title,
    ).toBe('run-abc1234 needs you');
  });
  it.each([
    'running',
    'finishing',
    'done',
    'failed',
    'cancelled',
    'interrupted',
    'provisioning',
  ] as const)('nothing for %s', (status) => {
    expect(notificationFor(run({ status }), 'running')).toBeNull();
  });
  it('nothing for a re-write of the same status', () => {
    expect(notificationFor(run({ status: 'blocked' }), 'blocked')).toBeNull();
  });
});

describe('createRunNotifications', () => {
  function harness(supported = true) {
    const shown: Array<{ title: string; body: string; click: () => void }> = [];
    const focusRun = jest.fn();
    const warn = jest.fn();
    const notifications = createRunNotifications({
      host: {
        isSupported: () => supported,
        show: (n, onClick) => shown.push({ ...n, click: onClick }),
      },
      focusRun,
      logger: { warn },
    });
    return { notifications, shown, focusRun, warn };
  }

  it('shows the notification and focuses the run on click', () => {
    const { notifications, shown, focusRun } = harness();
    notifications.onRunStatus(
      run({ status: 'blocked', blockedReason: 'Wants to edit a.ts' }),
      'running',
    );
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('Rename the dialog needs you');
    shown[0].click();
    expect(focusRun).toHaveBeenCalledWith('run-abc1234');
  });

  it('shows nothing when the OS cannot', () => {
    const { notifications, shown } = harness(false);
    notifications.onRunStatus(run({ status: 'needs-review' }), 'finishing');
    expect(shown).toHaveLength(0);
  });

  it('a host that throws is a warning, not a crash', () => {
    const warn = jest.fn();
    const notifications = createRunNotifications({
      host: {
        isSupported: () => true,
        show: () => {
          throw new Error('no notification center');
        },
      },
      focusRun: jest.fn(),
      logger: { warn },
    });
    expect(() =>
      notifications.onRunStatus(run({ status: 'blocked' }), 'running'),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'engine: notification not shown',
      expect.objectContaining({ runId: 'run-abc1234' }),
    );
  });
});
