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
import { getAgentRunTranscript } from '@/data/api';
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
import { briefTurnSeq, foldBrief, foldTurn } from './briefFold';

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
export interface SessionTranscriptOptions {
  /**
   * The run has no session yet (queued, provisioning — W4): nothing to
   * follow or read, so no unit is made until this turns false. A resume
   * passes through provisioning too, and gets fresh followers and a fresh
   * history read on the far side, which is what a resumed session needs.
   */
  awaitingSession?: boolean;
  bridge?: SessionBridge;
  /**
   * W5a: fold the first prompt (a dispatched run's brief) to one line in
   * the transcript and hand it back as `brief` for the bar above
   * (briefFold.ts). The label names the run in the placeholder.
   */
  foldBrief?: { label: string } | null;
}

export function useSessionTranscript(
  runId: string,
  options: SessionTranscriptOptions = {},
) {
  const {
    awaitingSession = false,
    bridge = engineSessionBridge,
    foldBrief: fold = null,
  } = options;
  const foldLabel = fold?.label ?? null;
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
  // The folded first prompt, for the Brief bar; null until history says.
  const [brief, setBrief] = useState<string | null>(null);
  const briefSeqRef = useRef<number | null>(null);
  const foldLabelRef = useRef<string | null>(foldLabel);
  foldLabelRef.current = foldLabel;

  const loadHistory = useCallback(async (target: TranscriptUnit) => {
    // The daemon's history first; the ledger's snapshot when the daemon
    // has nothing (ROAD-124: a session killed at finalize or stop, or a
    // daemon restarted since) — the same turn shape, seeded the same way.
    let turns:
      Parameters<typeof target.state.transcript.history.seed>[0] | null = null;
    let daemonError: unknown = null;
    try {
      const page = await target.source.loadHistory({ limit: HISTORY_PAGE });
      if (page.turns.length > 0) turns = page.turns;
    } catch (error) {
      daemonError = error;
    }
    if (unitRef.current !== target) return;
    if (!turns) {
      try {
        const kept = await getAgentRunTranscript(target.runId);
        if (unitRef.current !== target) return;
        if (kept && kept.turns.length > 0) {
          turns = kept.turns as NonNullable<typeof turns>;
        }
      } catch {
        // No snapshot either: the daemon's answer (or its error) stands.
      }
    }
    if (!turns && daemonError) {
      setHistoryStatus({
        kind: 'failed',
        message:
          daemonError instanceof Error
            ? daemonError.message
            : String(daemonError),
      });
      return;
    }
    // The brief folded (W5a), when asked: the earliest turn's opening
    // message becomes one line; its text goes to the bar.
    let seeded = turns ?? [];
    if (foldLabelRef.current) {
      const folded = foldBrief(seeded, foldLabelRef.current);
      seeded = folded.turns;
      briefSeqRef.current = folded.seq;
      setBrief(folded.brief);
    }
    // `seed` replaces the committed history AND resets the active turn
    // (chat-ui's ChatHistory contract). Found live: a turn in flight
    // vanished from the pane the moment history landed after the live
    // snapshot. So the follower's current turn is put back right after.
    target.state.transcript.history.seed(seeded);
    target.state.transcript.activeTurn.set(
      foldActive(target.source.activeTurn.getSnapshot() ?? null),
    );
    target.state.session.setPendingPrompt(null);
    setTurnCount(turns?.length ?? 0);
    setHistoryStatus({ kind: 'ready' });
  }, []);

  // The live active turn folded the same way: the brief is the first turn
  // while the agent works on it, before history has it committed.
  const foldActive = useCallback(
    (turn: ReturnType<SessionSource['activeTurn']['getSnapshot']> | null) => {
      const label = foldLabelRef.current;
      if (!turn || !label) return turn ?? null;
      const seq = briefSeqRef.current;
      if (seq !== null ? turn.seq !== seq : turn.seq !== 1) return turn;
      return foldTurn(turn, label);
    },
    [],
  );

  useEffect(() => {
    if (awaitingSession) {
      unitRef.current = null;
      setUnit(null);
      setHistoryStatus({ kind: 'loading' });
      setTurnCount(0);
      setBrief(null);
      briefSeqRef.current = null;
      return undefined;
    }
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
    setBrief(null);
    briefSeqRef.current = null;

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
        {
          ...created.source.connectSource,
          activeTurn: {
            getSnapshot: () =>
              foldActive(created.source.connectSource.activeTurn.getSnapshot()),
            subscribe: created.source.connectSource.activeTurn.subscribe,
          },
        },
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
    // runtime, context and bridge are process-long; the run id (and
    // whether it has a session yet) is the unit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, awaitingSession]);

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
    /** The folded first prompt (W5a), when `foldBrief` was asked and history had one. */
    brief,
    pendingPermissions,
    usage,
    liveStatus,
    isGenerating,
    queuedCount,
    reloadHistory: () => (unit ? loadHistory(unit) : Promise.resolve()),
  };
}
