import { act, renderHook } from '@testing-library/react';
import type { AgentRun } from '@/types/agentRuns';
import { listMyAgentRuns } from '@/data/api';
import {
  getEngineStatus,
  installEngine,
  onEngineStatusChanged,
  onRunChanged,
} from '@/data/engineApi';
import {
  groupRuns,
  patchSessionRun,
  refreshSessions,
  resetSessionsStoreForTests,
  useMySessions,
  useWaitingSessionsCount,
} from './sessionsStore';

// jest.mock is hoisted above the imports, so these ARE the mocked modules.
jest.mock('@/data/api', () => ({
  listMyAgentRuns: jest.fn(),
}));
jest.mock('@/data/engineApi', () => ({
  getEngineStatus: jest.fn(),
  installEngine: jest.fn(),
  onEngineStatusChanged: jest.fn(),
  onRunChanged: jest.fn(),
}));

const run = (
  id: string,
  status: AgentRun['status'],
  updatedAt: string,
): AgentRun => ({ id, status, updatedAt, title: id }) as unknown as AgentRun;

const engineListeners = new Set<(s: unknown) => void>();
const runChangedListeners = new Set<(c: unknown) => void>();

beforeEach(() => {
  jest.clearAllMocks();
  resetSessionsStoreForTests();
  engineListeners.clear();
  runChangedListeners.clear();
  (listMyAgentRuns as jest.Mock).mockResolvedValue([]);
  (installEngine as jest.Mock).mockResolvedValue({ kind: 'stopped' });
  (getEngineStatus as jest.Mock).mockResolvedValue({ kind: 'stopped' });
  (onEngineStatusChanged as jest.Mock).mockImplementation((cb) => {
    engineListeners.add(cb);
    return () => engineListeners.delete(cb);
  });
  (onRunChanged as jest.Mock).mockImplementation((cb) => {
    runChangedListeners.add(cb);
    return () => runChangedListeners.delete(cb);
  });
});

const flush = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

describe('groupRuns', () => {
  it('puts waiting first, then active, then done — each most recent first — and never lets a user reorder', () => {
    const groups = groupRuns([
      run('r-done', 'done', '2026-09-01T10:00:00Z'),
      run('r-run', 'running', '2026-09-01T09:00:00Z'),
      run('r-blocked-old', 'blocked', '2026-09-01T08:00:00Z'),
      run('r-review', 'needs-review', '2026-09-01T11:00:00Z'),
      run('r-queued', 'queued', '2026-09-01T12:00:00Z'),
      run('r-interrupted', 'interrupted', '2026-09-01T07:00:00Z'),
      run('r-failed', 'failed', '2026-09-01T13:00:00Z'),
    ]);
    expect(groups.waiting.map((r) => r.id)).toEqual([
      'r-review',
      'r-blocked-old',
    ]);
    expect(groups.active.map((r) => r.id)).toEqual(['r-queued', 'r-run']);
    expect(groups.done.map((r) => r.id)).toEqual([
      'r-failed',
      'r-done',
      'r-interrupted',
    ]);
  });
});

describe('useMySessions / useWaitingSessionsCount', () => {
  it('reads the ledger on the first subscriber, probes the engine (install, so a daemon that outlived the last Waypoint is adopted), and the badge counts blocked + needs-review', async () => {
    (listMyAgentRuns as jest.Mock).mockResolvedValue([
      run('r1', 'blocked', '2026-09-01T10:00:00Z'),
      run('r2', 'needs-review', '2026-09-01T10:00:00Z'),
      run('r3', 'running', '2026-09-01T10:00:00Z'),
    ]);
    const { result } = renderHook(() => useMySessions());
    const badge = renderHook(() => useWaitingSessionsCount());
    expect(result.current.loaded).toBe(false);
    await flush();

    expect(listMyAgentRuns).toHaveBeenCalledTimes(1);
    expect(result.current.loaded).toBe(true);
    expect(result.current.groups.waiting).toHaveLength(2);
    expect(result.current.groups.active).toHaveLength(1);
    expect(installEngine).toHaveBeenCalledTimes(1);
    expect(result.current.engine).toEqual({ kind: 'stopped' });
    expect(badge.result.current).toBe(2);
  });

  it('re-reads on a runs:changed push (once per burst) and when the engine comes up', async () => {
    jest.useFakeTimers();
    try {
      renderHook(() => useMySessions());
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      expect(listMyAgentRuns).toHaveBeenCalledTimes(1);

      // Three pushes in a burst: one read.
      runChangedListeners.forEach((cb) =>
        cb({ runId: 'r1', status: 'blocked' }),
      );
      runChangedListeners.forEach((cb) =>
        cb({ runId: 'r1', status: 'blocked' }),
      );
      runChangedListeners.forEach((cb) =>
        cb({ runId: 'r2', status: 'running' }),
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(300);
      });
      expect(listMyAgentRuns).toHaveBeenCalledTimes(2);

      engineListeners.forEach((cb) => cb({ kind: 'running', since: 1 }));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      expect(listMyAgentRuns).toHaveBeenCalledTimes(3);
      // Still running: no extra read for a repeat of the same state.
      engineListeners.forEach((cb) => cb({ kind: 'running', since: 1 }));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      expect(listMyAgentRuns).toHaveBeenCalledTimes(3);

      // The safety-net poll.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(listMyAgentRuns).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a failed read keeps the last rows and reports the sentence; a patch updates one row in place', async () => {
    (listMyAgentRuns as jest.Mock).mockResolvedValueOnce([
      run('r1', 'running', '2026-09-01T10:00:00Z'),
    ]);
    const { result } = renderHook(() => useMySessions());
    await flush();
    expect(result.current.groups.active).toHaveLength(1);

    (listMyAgentRuns as jest.Mock).mockRejectedValueOnce(
      new Error('Network error: /agent-runs'),
    );
    await act(() => refreshSessions());
    expect(result.current.error).toBe('Network error: /agent-runs');
    expect(result.current.groups.active).toHaveLength(1);

    act(() => patchSessionRun('r1', { status: 'cancelled' }));
    expect(result.current.groups.active).toHaveLength(0);
    expect(result.current.groups.done.map((r) => r.id)).toEqual(['r1']);
  });

  it('stops polling and listening a tick after the last subscriber leaves — not at once, so the sidebar ⇄ rail swap does not restart everything', async () => {
    const { unmount } = renderHook(() => useMySessions());
    await flush();
    expect(runChangedListeners.size).toBe(1);
    expect(engineListeners.size).toBe(1);
    unmount();
    // Still up in the same tick: a new subscriber (the rail's badge,
    // mounted right after the sidebar's unmounted) keeps it running.
    expect(runChangedListeners.size).toBe(1);
    const again = renderHook(() => useMySessions());
    await flush();
    expect(runChangedListeners.size).toBe(1);
    expect(listMyAgentRuns).toHaveBeenCalledTimes(1);
    again.unmount();
    await flush();
    expect(runChangedListeners.size).toBe(0);
    expect(engineListeners.size).toBe(0);
  });
});
