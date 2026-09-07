import { act, renderHook } from '@testing-library/react';
import { ensureJiraSynced, getJiraConnectionStatus } from '@/data/jiraApi';
import type { JiraConnectionStatus } from '@/types/jira';
import {
  resetJiraStoreForTests,
  setJiraConnection,
  subscribeJiraConnection,
  useJiraConnection,
  useLoadedJiraConnection,
} from './jiraStore';

jest.mock('@/data/jiraApi', () => ({
  getJiraConnectionStatus: jest.fn(),
  ensureJiraSynced: jest.fn(),
}));

function status(
  overrides: Partial<JiraConnectionStatus> = {},
): JiraConnectionStatus {
  return {
    connected: true,
    accountName: 'Max Chen',
    accountEmail: 'max@northwind.dev',
    accountId: '5f8a',
    site: 'northwind.atlassian.net',
    lastSyncAt: '2026-01-01T00:00:00.000Z',
    issueCount: 6,
    projectCount: 3,
    countsTruncated: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetJiraStoreForTests();
});

describe('jiraStore', () => {
  it('useJiraConnection reads undefined until something feeds the store', () => {
    const { result } = renderHook(() => useJiraConnection());
    expect(result.current).toBeUndefined();
  });

  it('setJiraConnection feeds the store and notifies every subscriber', () => {
    const listenerA = jest.fn();
    const listenerB = jest.fn();
    const unsubA = subscribeJiraConnection(listenerA);
    const unsubB = subscribeJiraConnection(listenerB);

    setJiraConnection(status());

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });

  it('unsubscribe stops further notifications to that listener only', () => {
    const listenerA = jest.fn();
    const listenerB = jest.fn();
    const unsubA = subscribeJiraConnection(listenerA);
    subscribeJiraConnection(listenerB);
    unsubA();

    setJiraConnection(status());

    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  // The mechanism the whole feature leans on: the sidebar's MyJiraNavItem
  // and MyJiraPage both call useLoadedJiraConnection/useJiraConnection —
  // approving a wizard connect or a Connection-tab disconnect from one must
  // show up in the other immediately, with no refetch.
  it('a value fed by one consumer is visible in a second, independently-mounted consumer with no refetch', () => {
    const sidebar = renderHook(() => useJiraConnection());
    const page = renderHook(() => useJiraConnection());

    act(() => {
      setJiraConnection(status({ connected: false }));
    });

    expect(sidebar.result.current?.connected).toBe(false);
    expect(page.result.current?.connected).toBe(false);
  });

  it('resetJiraStoreForTests clears the store back to undefined', () => {
    setJiraConnection(status());

    resetJiraStoreForTests();

    const { result } = renderHook(() => useJiraConnection());
    expect(result.current).toBeUndefined();
  });

  it('useLoadedJiraConnection fetches once on mount and feeds the shared store', async () => {
    jest
      .mocked(getJiraConnectionStatus)
      .mockResolvedValue(status({ issueCount: 9 }));

    const { result } = renderHook(() => useLoadedJiraConnection());
    await act(async () => {});

    expect(getJiraConnectionStatus).toHaveBeenCalledTimes(1);
    expect(result.current?.issueCount).toBe(9);
  });

  it('two mounted useLoadedJiraConnection callers each fetch, but both converge on the last write (no fighting)', async () => {
    jest
      .mocked(getJiraConnectionStatus)
      .mockResolvedValueOnce(status({ issueCount: 1 }))
      .mockResolvedValueOnce(status({ issueCount: 2 }));

    const first = renderHook(() => useLoadedJiraConnection());
    const second = renderHook(() => useLoadedJiraConnection());
    await act(async () => {});

    expect(getJiraConnectionStatus).toHaveBeenCalledTimes(2);
    expect(first.result.current?.issueCount).toBe(2);
    expect(second.result.current?.issueCount).toBe(2);
  });

  // Found in review: a connected account with real tickets showed "0
  // issues" / "not synced yet" on the All Projects page's Jira tile
  // indefinitely, because that tile's only read was the fast status
  // check — which can correctly answer connected:true while never having
  // triggered a real ticket read at all. These three pin the fix.
  describe('useLoadedJiraConnection — ensures a real sync when connected but never synced', () => {
    it('calls ensureJiraSynced and adopts its result when connected with no lastSyncAt yet', async () => {
      jest
        .mocked(getJiraConnectionStatus)
        .mockResolvedValue(status({ connected: true, lastSyncAt: null, issueCount: 0 }));
      jest
        .mocked(ensureJiraSynced)
        .mockResolvedValue(status({ connected: true, lastSyncAt: '2026-01-01T00:00:00.000Z', issueCount: 12 }));

      const { result } = renderHook(() => useLoadedJiraConnection());
      await act(async () => {});

      expect(ensureJiraSynced).toHaveBeenCalledTimes(1);
      expect(result.current?.issueCount).toBe(12);
      expect(result.current?.lastSyncAt).not.toBeNull();
    });

    it('does not call ensureJiraSynced when the fast status already carries a real sync', async () => {
      jest
        .mocked(getJiraConnectionStatus)
        .mockResolvedValue(status({ connected: true, lastSyncAt: '2026-01-01T00:00:00.000Z' }));

      renderHook(() => useLoadedJiraConnection());
      await act(async () => {});

      expect(ensureJiraSynced).not.toHaveBeenCalled();
    });

    it('does not call ensureJiraSynced when nothing is connected', async () => {
      jest
        .mocked(getJiraConnectionStatus)
        .mockResolvedValue(status({ connected: false, lastSyncAt: null }));

      renderHook(() => useLoadedJiraConnection());
      await act(async () => {});

      expect(ensureJiraSynced).not.toHaveBeenCalled();
    });
  });
});
