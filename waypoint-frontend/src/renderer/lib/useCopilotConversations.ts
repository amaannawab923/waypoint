import { useCallback, useState } from 'react';
import {
  listCopilotConversations,
  createCopilotConversation,
  getCopilotConversation,
  renameCopilotConversation,
  deleteCopilotConversation,
} from '@/data/api';
import type { CopilotConversationSummary } from '@/types/entities';
import { useAsync } from './useAsync';
import type {
  CopilotSession,
  CopilotSessionMessage,
  CopilotSessionGroupKey,
} from './copilotSessions';
import {
  loadMeta,
  saveMeta,
  getMeta,
  removeMeta,
  togglePin,
  reorderWithinGroup,
  type CopilotSessionMetaMap,
} from './copilotSessionMeta';

export interface UseCopilotConversationsResult {
  sessions: CopilotSession[];
  loading: boolean;
  /** Set when the list fetch itself failed — distinct from an empty-but-successful list, so the panel can show a real error instead of a misleading "No sessions yet". */
  error: Error | null;
  reload: () => Promise<void>;
  createSession: () => Promise<CopilotSession>;
  /** Lazily fetches a conversation's messages into the local cache (a no-op if already cached this app-session). */
  openSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  togglePinSession: (id: string) => void;
  reorderSessionsWithinGroup: (
    sourceId: string,
    targetId: string,
    group: CopilotSessionGroupKey,
  ) => void;
  appendMessageLocal: (
    sessionId: string,
    message: CopilotSessionMessage,
  ) => void;
  /** Rolls back an optimistic appendMessageLocal — used when its backing POST fails. */
  removeMessageLocal: (sessionId: string, messageId: string) => void;
  /** Merges a patch (e.g. a fresh updatedAt, a newly-learned claudeSessionId) into the cached conversation summary, without a refetch. */
  patchConversationLocal: (
    sessionId: string,
    patch: Partial<
      Pick<CopilotConversationSummary, 'updatedAt' | 'claudeSessionId'>
    >,
  ) => void;
}

/**
 * Fetches the member's Copilot conversations from the backend (issue #11)
 * and merges in local-only pin/order metadata (copilotSessionMeta.ts) to
 * produce the CopilotSession[] view-model CopilotSessionList.tsx and
 * CopilotPanel.tsx already consume — this is the one place the two data
 * sources combine; neither component needs to know two sources exist.
 *
 * Messages aren't part of the list response (kept light — see
 * data/api.ts's listCopilotConversations) — they're fetched lazily per
 * conversation via openSession() into a local cache, since the list view
 * never needs them and the chat view only ever needs the one conversation
 * that's open.
 */
export function useCopilotConversations(): UseCopilotConversationsResult {
  const {
    data: conversations,
    loading,
    error,
    reload,
    setData,
  } = useAsync(() => listCopilotConversations(), []);
  const [meta, setMetaState] = useState<CopilotSessionMetaMap>(() =>
    loadMeta(),
  );
  const [messagesById, setMessagesById] = useState<
    Record<string, CopilotSessionMessage[]>
  >({});

  const persistMeta = useCallback((next: CopilotSessionMetaMap) => {
    setMetaState(next);
    saveMeta(next);
  }, []);

  const sessions: CopilotSession[] = (conversations ?? []).map(
    (c: CopilotConversationSummary) => {
      const m = getMeta(meta, c.id);
      return {
        id: c.id,
        title: c.title,
        claudeSessionId: c.claudeSessionId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        pinned: m.pinned,
        order: m.order,
        messages: messagesById[c.id] ?? [],
      };
    },
  );

  const createSessionAction = useCallback(async (): Promise<CopilotSession> => {
    const created = await createCopilotConversation();
    setData((prev) => [created, ...(prev ?? [])]);
    return {
      id: created.id,
      title: created.title,
      claudeSessionId: created.claudeSessionId,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      pinned: false,
      order: 0,
      messages: [],
    };
  }, [setData]);

  const openSession = useCallback(
    async (id: string) => {
      if (messagesById[id]) return;
      const full = await getCopilotConversation(id);
      setMessagesById((prev) => ({ ...prev, [id]: full.messages }));
    },
    [messagesById],
  );

  const renameSessionAction = useCallback(
    async (id: string, title: string) => {
      const updated = await renameCopilotConversation(id, title);
      setData((prev) => (prev ?? []).map((c) => (c.id === id ? updated : c)));
    },
    [setData],
  );

  const deleteSessionAction = useCallback(
    async (id: string) => {
      await deleteCopilotConversation(id);
      setData((prev) => (prev ?? []).filter((c) => c.id !== id));
      persistMeta(removeMeta(meta, id));
      setMessagesById((prev) => {
        if (!(id in prev)) return prev;
        const { [id]: _dropped, ...rest } = prev;
        return rest;
      });
    },
    [setData, persistMeta, meta],
  );

  const togglePinSessionAction = useCallback(
    (id: string) => {
      persistMeta(togglePin(meta, sessions, id));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta, sessions, persistMeta],
  );

  const reorderAction = useCallback(
    (sourceId: string, targetId: string, group: CopilotSessionGroupKey) => {
      persistMeta(
        reorderWithinGroup(meta, sessions, sourceId, targetId, group),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta, sessions, persistMeta],
  );

  const appendMessageLocal = useCallback(
    (sessionId: string, message: CopilotSessionMessage) => {
      setMessagesById((prev) => ({
        ...prev,
        [sessionId]: [...(prev[sessionId] ?? []), message],
      }));
    },
    [],
  );

  const removeMessageLocal = useCallback(
    (sessionId: string, messageId: string) => {
      setMessagesById((prev) => {
        if (!prev[sessionId]) return prev;
        return {
          ...prev,
          [sessionId]: prev[sessionId].filter((m) => m.id !== messageId),
        };
      });
    },
    [],
  );

  const patchConversationLocal = useCallback(
    (
      sessionId: string,
      patch: Partial<
        Pick<CopilotConversationSummary, 'updatedAt' | 'claudeSessionId'>
      >,
    ) => {
      setData((prev) =>
        (prev ?? []).map((c) => (c.id === sessionId ? { ...c, ...patch } : c)),
      );
    },
    [setData],
  );

  return {
    sessions,
    loading,
    error,
    reload,
    createSession: createSessionAction,
    openSession,
    renameSession: renameSessionAction,
    deleteSession: deleteSessionAction,
    togglePinSession: togglePinSessionAction,
    reorderSessionsWithinGroup: reorderAction,
    appendMessageLocal,
    removeMessageLocal,
    patchConversationLocal,
  };
}
