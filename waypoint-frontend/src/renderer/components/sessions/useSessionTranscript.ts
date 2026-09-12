import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { AcpPermissionRequest, ChatState } from '@emdash/chat-ui';
import type { SessionUsage } from '@emdash/core/runtimes/acp/api/client' with {
  'resolution-mode': 'import',
};
import { getChatUiRuntime } from '@/components/chat/chatUiRuntime';
import { engineSessionBridge, onEngineStatusChanged } from '@/data/engineApi';
import {
  createLiveFollower,
  type FollowerStatus,
  type LiveFollower,
} from '@/data/live/liveFollower';
import {
  createSessionSource,
  sessionTopic,
  type SessionBridge,
  type SessionSource,
} from '@/data/live/sessionSource';
import { getSharedChatContext } from '@/lib/chatContext';

/** How the transcript's history read stands. */
export type HistoryStatus =
  { kind: 'loading' } | { kind: 'ready' } | { kind: 'failed'; message: string };

const HISTORY_PAGE = 100;

/** One run's transcript resources, created and disposed as a unit. */
interface TranscriptUnit {
  runId: string;
  state: ChatState;
  source: SessionSource;
  usage: LiveFollower<SessionUsage | null>;
}

const EMPTY_PERMISSIONS: readonly AcpPermissionRequest[] = [];
const CONNECTING: FollowerStatus = { kind: 'connecting' };
const noop = () => () => {};

/**
 * One run's transcript, as a hook (W3, ROAD-62): a `ChatState` seeded from
 * `acp.getHistory`, `connectSession`'d to the run's live followers
 * (activeTurn, plan, state), re-seeded whenever a turn commits, and a
 * fourth follower for `acp.session.usage` — all created in an effect when
 * the run id changes and disposed when it changes again or the pane
 * unmounts (so nothing is created during render, and nothing leaks). The
 * followers are re-subscribed when the engine reports running again, so
 * an engine restart is one reconnect, not a stuck "closed".
 *
 * Returns what the pane renders from: the state for the ChatTranscript
 * (`null` for the first frame, before the effect ran), the pending
 * permissions (the band), the usage (the strip) and the live status.
 */
export function useSessionTranscript(
  runId: string,
  bridge: SessionBridge = engineSessionBridge,
) {
  const runtime = getChatUiRuntime();
  const context = getSharedChatContext();
  const [unit, setUnit] = useState<TranscriptUnit | null>(null);
  const unitRef = useRef<TranscriptUnit | null>(null);
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>({
    kind: 'loading',
  });
  // Committed turns in the loaded history — the transcript's own count.
  // The ledger's turnCount is the orchestrator's to maintain (W4/W5) and
  // says 0 until then, so the pane counts what it can see.
  const [turnCount, setTurnCount] = useState(0);

  const loadHistory = useCallback(async (target: TranscriptUnit) => {
    try {
      const page = await target.source.loadHistory({ limit: HISTORY_PAGE });
      if (unitRef.current !== target) return;
      // `seed` replaces the committed history AND resets the active turn
      // (chat-ui's ChatHistory contract). Found live: a turn in flight
      // vanished from the pane the moment history landed after the live
      // snapshot. So the follower's current turn is put back right after.
      target.state.transcript.history.seed(page.turns);
      target.state.transcript.activeTurn.set(
        target.source.activeTurn.getSnapshot() ?? null,
      );
      target.state.session.setPendingPrompt(null);
      setTurnCount(page.turns.length);
      setHistoryStatus({ kind: 'ready' });
    } catch (error) {
      if (unitRef.current !== target) return;
      setHistoryStatus({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    const created: TranscriptUnit = {
      runId,
      state: runtime.createChatState(context, { uri: `run:${runId}` }),
      source: createSessionSource(runId, bridge),
      usage: createLiveFollower<SessionUsage | null>(
        sessionTopic('usage', runId),
        bridge,
      ),
    };
    unitRef.current = created;
    setUnit(created);
    setHistoryStatus({ kind: 'loading' });
    setTurnCount(0);

    // History first, then the live connection — emdash's own order
    // (acp-chat-store.ts's _runBootstrap): connectSession's first sync
    // then lays the follower's active turn over a seeded history, rather
    // than a later seed wiping it. A commit re-seeds through loadHistory,
    // which restores the active turn itself.
    let disconnect: (() => void) | null = null;
    let gone = false;
    const connectAfterHistory = async () => {
      // loadHistory never rejects (a failure becomes historyStatus).
      await loadHistory(created);
      if (gone) return;
      disconnect = runtime.connectSession(
        created.state,
        created.source.connectSource,
        {
          onTurnCommitted: () => {
            loadHistory(created).catch(() => {});
          },
        },
      );
    };
    connectAfterHistory().catch(() => {});
    const offEngine = onEngineStatusChanged((status) => {
      if (status.kind === 'running') {
        created.source.reconnect();
        created.usage.reconnect();
      }
    });
    return () => {
      gone = true;
      if (unitRef.current === created) unitRef.current = null;
      offEngine();
      disconnect?.();
      created.usage.dispose();
      created.source.dispose();
      created.state.dispose();
    };
    // runtime, context and bridge are process-long; the run id is the unit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const pendingPermissions = useSyncExternalStore(
    unit ? (l) => unit.source.sessionState.subscribe(l) : noop,
    () =>
      unit?.source.sessionState.getSnapshot()?.pendingPermissions ??
      EMPTY_PERMISSIONS,
    () => EMPTY_PERMISSIONS,
  );
  const usage = useSyncExternalStore(
    unit ? (l) => unit.usage.subscribe(l) : noop,
    () => unit?.usage.getSnapshot() ?? null,
    () => null,
  );
  const liveStatus = useSyncExternalStore(
    unit ? (l) => unit.source.activeTurn.subscribe(l) : noop,
    () => unit?.source.activeTurn.getStatus() ?? CONNECTING,
    () => CONNECTING,
  );
  const isGenerating = useSyncExternalStore(
    unit ? (l) => unit.source.sessionState.subscribe(l) : noop,
    () => unit?.source.sessionState.getSnapshot()?.isGenerating ?? false,
    () => false,
  );
  // Prompts the daemon holds for the agent's next turn (W4, ROAD-68): a
  // ⌘↵ during a turn lands here, not in the transcript, until the turn
  // ends — the strip says so.
  const queuedCount = useSyncExternalStore(
    unit ? (l) => unit.source.sessionState.subscribe(l) : noop,
    () => unit?.source.sessionState.getSnapshot()?.queuedPrompts?.length ?? 0,
    () => 0,
  );

  return {
    context,
    /** null for the first frame, before the effect created this run's unit. */
    state: unit && unit.runId === runId ? unit.state : null,
    historyStatus,
    turnCount,
    pendingPermissions,
    usage,
    liveStatus,
    isGenerating,
    queuedCount,
    reloadHistory: () => (unit ? loadHistory(unit) : Promise.resolve()),
  };
}
