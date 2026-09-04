import { act, renderHook, waitFor } from '@testing-library/react';
import {
  listCopilotConversations,
  createCopilotConversation,
  getCopilotConversation,
  deleteCopilotConversation,
} from '@/data/api';
import type {
  CopilotConversationSummary,
  CopilotConversation,
} from '@/types/entities';
import { useCopilotConversations } from './useCopilotConversations';

jest.mock('@/data/api', () => ({
  listCopilotConversations: jest.fn(),
  createCopilotConversation: jest.fn(),
  getCopilotConversation: jest.fn(),
  renameCopilotConversation: jest.fn(),
  deleteCopilotConversation: jest.fn(),
}));

function summary(
  overrides: Partial<CopilotConversationSummary> = {},
): CopilotConversationSummary {
  return {
    id: 'conv-1',
    memberId: 'mem-1',
    title: 'A conversation',
    claudeSessionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  jest.mocked(listCopilotConversations).mockResolvedValue([]);
});

describe('useCopilotConversations', () => {
  it('starts loading and resolves the fetched list into sessions', async () => {
    jest
      .mocked(listCopilotConversations)
      .mockResolvedValue([summary({ id: 'a' }), summary({ id: 'b' })]);
    const { result } = renderHook(() => useCopilotConversations());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('merges in local pin/order defaults for a conversation with no stored metadata', async () => {
    jest
      .mocked(listCopilotConversations)
      .mockResolvedValue([summary({ id: 'a' })]);
    const { result } = renderHook(() => useCopilotConversations());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.sessions[0]).toMatchObject({
      pinned: false,
      order: 0,
    });
  });

  it('a freshly-fetched conversation has no messages until opened', async () => {
    jest
      .mocked(listCopilotConversations)
      .mockResolvedValue([summary({ id: 'a' })]);
    const { result } = renderHook(() => useCopilotConversations());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.sessions[0].messages).toEqual([]);
  });

  describe('createSession', () => {
    it('prepends the created conversation without a full reload', async () => {
      jest
        .mocked(listCopilotConversations)
        .mockResolvedValue([summary({ id: 'existing' })]);
      jest
        .mocked(createCopilotConversation)
        .mockResolvedValue(summary({ id: 'new', title: 'New session' }));
      const { result } = renderHook(() => useCopilotConversations());
      await waitFor(() => expect(result.current.loading).toBe(false));

      let created!: Awaited<ReturnType<typeof result.current.createSession>>;
      await act(async () => {
        created = await result.current.createSession();
      });

      expect(created.id).toBe('new');
      expect(result.current.sessions.map((s) => s.id)).toEqual([
        'new',
        'existing',
      ]);
      // listCopilotConversations only runs once (the initial mount fetch) —
      // the create isn't followed by a redundant full refetch.
      expect(listCopilotConversations).toHaveBeenCalledTimes(1);
    });
  });

  describe('openSession', () => {
    it("lazily fetches a conversation's messages into the session", async () => {
      jest
        .mocked(listCopilotConversations)
        .mockResolvedValue([summary({ id: 'a' })]);
      const full: CopilotConversation = {
        ...summary({ id: 'a' }),
        messages: [
          {
            id: 'm1',
            conversationId: 'a',
            role: 'user',
            content: 'hi',
            seq: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
      jest.mocked(getCopilotConversation).mockResolvedValue(full);
      const { result } = renderHook(() => useCopilotConversations());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.sessions[0].messages).toEqual([]);

      await act(async () => {
        await result.current.openSession('a');
      });

      expect(result.current.sessions[0].messages).toHaveLength(1);
      expect(result.current.sessions[0].messages[0].content).toBe('hi');
    });

    it('does not refetch a conversation already opened this app-session', async () => {
      jest
        .mocked(listCopilotConversations)
        .mockResolvedValue([summary({ id: 'a' })]);
      jest.mocked(getCopilotConversation).mockResolvedValue({
        ...summary({ id: 'a' }),
        messages: [],
      });
      const { result } = renderHook(() => useCopilotConversations());
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.openSession('a');
      });
      await act(async () => {
        await result.current.openSession('a');
      });

      expect(getCopilotConversation).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteSession', () => {
    it('removes the conversation from the list and its cached messages', async () => {
      jest
        .mocked(listCopilotConversations)
        .mockResolvedValue([summary({ id: 'a' }), summary({ id: 'b' })]);
      jest.mocked(deleteCopilotConversation).mockResolvedValue(undefined);
      const { result } = renderHook(() => useCopilotConversations());
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.deleteSession('a');
      });

      expect(result.current.sessions.map((s) => s.id)).toEqual(['b']);
      expect(deleteCopilotConversation).toHaveBeenCalledWith('a');
    });
  });

  describe('togglePinSession / reorderSessionsWithinGroup', () => {
    it('pinning is local-only and does not call the backend', async () => {
      jest
        .mocked(listCopilotConversations)
        .mockResolvedValue([summary({ id: 'a' })]);
      const { result } = renderHook(() => useCopilotConversations());
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => {
        result.current.togglePinSession('a');
      });

      await waitFor(() => expect(result.current.sessions[0].pinned).toBe(true));
    });

    it('persists pin state across a hook remount via the local meta store', async () => {
      jest
        .mocked(listCopilotConversations)
        .mockResolvedValue([summary({ id: 'a' })]);
      const { result, unmount } = renderHook(() => useCopilotConversations());
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => {
        result.current.togglePinSession('a');
      });
      await waitFor(() => expect(result.current.sessions[0].pinned).toBe(true));
      unmount();

      const { result: second } = renderHook(() => useCopilotConversations());
      await waitFor(() => expect(second.current.loading).toBe(false));
      expect(second.current.sessions[0].pinned).toBe(true);
    });
  });

  describe('appendMessageLocal / removeMessageLocal', () => {
    it('appends and can roll back a locally-cached message', async () => {
      jest
        .mocked(listCopilotConversations)
        .mockResolvedValue([summary({ id: 'a' })]);
      const { result } = renderHook(() => useCopilotConversations());
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => {
        result.current.appendMessageLocal('a', {
          id: 'local-1',
          role: 'user',
          content: 'hi',
          createdAt: '2026-01-01T00:00:00.000Z',
        });
      });
      expect(result.current.sessions[0].messages).toHaveLength(1);

      act(() => {
        result.current.removeMessageLocal('a', 'local-1');
      });
      expect(result.current.sessions[0].messages).toHaveLength(0);
    });
  });

  describe('patchConversationLocal', () => {
    it('merges a patch into the cached conversation without a refetch', async () => {
      jest
        .mocked(listCopilotConversations)
        .mockResolvedValue([summary({ id: 'a', claudeSessionId: null })]);
      const { result } = renderHook(() => useCopilotConversations());
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => {
        result.current.patchConversationLocal('a', {
          claudeSessionId: 'sess-xyz',
          updatedAt: '2026-02-01T00:00:00.000Z',
        });
      });

      expect(result.current.sessions[0].claudeSessionId).toBe('sess-xyz');
      expect(result.current.sessions[0].updatedAt).toBe(
        '2026-02-01T00:00:00.000Z',
      );
      expect(listCopilotConversations).toHaveBeenCalledTimes(1);
    });
  });
});
