import { act, renderHook } from '@testing-library/react';
import { getJiraConnectionStatus } from '@/data/jiraApi';
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
}));

function status(
  overrides: Partial<JiraConnectionStatus> = {},
): JiraConnectionStatus {
  return {
    connected: true,
    accountName: 'Max Chen',
    accountEmail: 'max@northwind.dev',
    site: 'northwind.atlassian.net',
    lastSyncAt: '2026-01-01T00:00:00.000Z',
    issueCount: 6,
    projectCount: 3,
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
});
