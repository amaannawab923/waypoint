import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { AcpPermissionRequest, ChatState } from '@emdash/chat-ui';
import type {
  SessionConfigState,
  SessionUsage,
} from '@emdash/core/runtimes/acp/api/client' with {
  'resolution-mode': 'import',
};
import { getChatUiRuntime } from '@/components/chat/chatUiRuntime';
import { getAgentRunTranscript, listAgentRunEvents } from '@/data/api';
import {
  engineSessionBridge,
  listPendingPrompts,
  onEngineStatusChanged,
  onRunChanged,
} from '@/data/engineApi';
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
import type { AgentRunEvent, PendingPrompt } from '@/types/agentRuns';
import { briefTurnSeq, foldBrief, foldTurn } from './briefFold';
import { deriveMarkers, overlayMarkers, type Marker } from './markerFold';

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
  /** The provider's mode / model / effort options and what is selected — the composer's selectors. */
  config: LiveFollower<SessionConfigState | null>;
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
  /**
   * Never-lock (design §5): the label the markers name the run by
   * ("Completed ROAD-116 · Fix …"). Markers are drawn from the run's
   * ledger events, laid over every history seed; null draws none.
   */
  markerLabel?: string | null;
}

export function useSessionTranscript(
  runId: string,
  options: SessionTranscriptOptions = {},
) {
  const {
    awaitingSession = false,
    bridge = engineSessionBridge,
    foldBrief: fold = null,
    markerLabel = null,
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
  // Never-lock: the ledger's events → markers, and the run's outbox →
  // pending rows. Both are read on unit creation and again whenever main
  // says the run changed (a finalize, a resume, a delivery); the markers
  // are laid over the turns on every seed (below), the pending rows are
  // the caller's to show (SessionTranscript's outbox strip).
  const markersRef = useRef<Marker[]>([]);
  const markerLabelRef = useRef<string | null>(markerLabel);
  markerLabelRef.current = markerLabel;
  const [pending, setPending] = useState<PendingPrompt[]>([]);

  // The same last-write-wins guard `refreshMarkers` has (below), found
  // missing here in review (round 4): `loadHistory` is reached from
  // three uncoordinated triggers on one live unit — the first connect,
  // every turn commit, and `onRunChanged`'s re-seed — and two of those
  // routinely coincide (a send or finalize lands with a commit). Without
  // a token, an older read resolving after a newer one re-seeds the
  // transcript with stale turns, visibly winding it back.
  const historyTokenRef = useRef(0);
  const loadHistory = useCallback(async (target: TranscriptUnit) => {
    historyTokenRef.current += 1;
    const myToken = historyTokenRef.current;
    const stale = () =>
      unitRef.current !== target || historyTokenRef.current !== myToken;
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
    if (stale()) return;
    if (!turns) {
      try {
        const kept = await getAgentRunTranscript(target.runId);
        if (stale()) return;
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
    // Then the markers (never-lock, design §5.3): after the fold, before
    // the seed, so every commit and every restart re-applies them.
    seeded = overlayMarkers(seeded, markersRef.current);
    // `seed` replaces the committed history AND resets the active turn
    // (chat-ui's ChatHistory contract). Found live: a turn in flight
    // vanished from the pane the moment history landed after the live
    // snapshot. So the follower's current turn is put back right after.
    // The pending prompt goes BEFORE the seed. chat-ui builds a row's
    // component once, by role; a seed that adds a row where the pending
    // prompt's user card stood recycles that card for the new row —
    // found live (never-lock): a marker drawn as a user bubble, the
    // person's own message painted over it.
    target.state.session.setPendingPrompt(null);
    target.state.transcript.history.seed(seeded);
    target.state.transcript.activeTurn.set(
      foldActive(target.source.activeTurn.getSnapshot() ?? null),
    );
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

  // Two overlapping calls on the SAME live unit — `onRunChanged` can fire
  // several times back-to-back (design §7's own note: a 3-event burst
  // during an outbox drain) — race if left unguarded: whichever resolves
  // LAST wins even when it started first, so an older read can overwrite
  // a newer one (found in review). `unitRef.current !== target` alone
  // only catches a torn-down/replaced unit, not this; a call token does.
  const refreshTokenRef = useRef(0);
  // The events and the outbox, fresh; a change in the markers re-seeds
  // the current history so the new line shows where it belongs.
  const refreshMarkers = useCallback(async (target: TranscriptUnit) => {
    refreshTokenRef.current += 1;
    const myToken = refreshTokenRef.current;
    const [events, rows] = await Promise.all([
      markerLabelRef.current
        ? listAgentRunEvents(target.runId).catch((): AgentRunEvent[] => [])
        : Promise.resolve<AgentRunEvent[]>([]),
      listPendingPrompts(target.runId).catch((): PendingPrompt[] => []),
    ]);
    if (unitRef.current !== target || refreshTokenRef.current !== myToken) {
      return false;
    }
    setPending(
      rows.filter(
        (row) => row.state !== 'delivered' && row.state !== 'dropped',
      ),
    );
    const next = markerLabelRef.current
      ? deriveMarkers(events, markerLabelRef.current)
      : [];
    const changed =
      next.length !== markersRef.current.length ||
      next.some(
        (m, i) =>
          m.id !== markersRef.current[i].id ||
          m.text !== markersRef.current[i].text,
      );
    markersRef.current = next;
    return changed;
  }, []);

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
      config: createLiveFollower<SessionConfigState | null>(
        sessionTopic('config', runId),
        bridge,
      ),
    };
    unitRef.current = created;
    setUnit(created);
    setHistoryStatus({ kind: 'loading' });
    setTurnCount(0);
    setBrief(null);
    briefSeqRef.current = null;
    markersRef.current = [];
    setPending([]);

    // History first, then the live connection — emdash's own order
    // (acp-chat-store.ts's _runBootstrap): connectSession's first sync
    // then lays the follower's active turn over a seeded history, rather
    // than a later seed wiping it. A commit re-seeds through loadHistory,
    // which restores the active turn itself.
    let disconnect: (() => void) | null = null;
    let gone = false;
    const connectAfterHistory = async () => {
      // Markers first, so the first seed already carries them; then the
      // history (loadHistory never rejects — a failure becomes
      // historyStatus).
      await refreshMarkers(created).catch(() => {});
      if (gone) return;
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
        created.config.reconnect();
      }
    });
    // A finalize, a resume, a delivery: main wrote the ledger — the
    // markers and the outbox may have changed; a changed marker set
    // re-seeds so the new line lands in the transcript now, not at the
    // next commit.
    const offRun = onRunChanged((change) => {
      if (change.runId !== runId || gone) return;
      refreshMarkers(created)
        .then((changed) => {
          if (changed && !gone) return loadHistory(created);
          return undefined;
        })
        .catch(() => {});
    });
    return () => {
      gone = true;
      if (unitRef.current === created) unitRef.current = null;
      offEngine();
      offRun();
      disconnect?.();
      created.usage.dispose();
      created.config.dispose();
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
  const config = useSyncExternalStore(
    unit ? (l) => unit.config.subscribe(l) : noop,
    () => unit?.config.getSnapshot() ?? null,
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
  // Enter during a turn lands here, not in the transcript, until the turn
  // ends — the strip says so.
  const queuedCount = useSyncExternalStore(
    unit ? (l) => unit.source.sessionState.subscribe(l) : noop,
    () => unit?.source.sessionState.getSnapshot()?.queuedPrompts?.length ?? 0,
    () => 0,
  );
  // Whether the daemon currently has a turn in flight for this run — a
  // signal separate from `turnCount` (committed history only). Found in
  // review: a run stopped mid-first-turn can flip its ledger status to
  // non-live before the turn's own commit → loadHistory round trip lands,
  // so `turnCount` alone would read as "nothing ever happened" over
  // content that's still on screen.
  const activeTurn = useSyncExternalStore(
    unit ? (l) => unit.source.activeTurn.subscribe(l) : noop,
    () => unit?.source.activeTurn.getSnapshot() ?? null,
    () => null,
  );

  return {
    context,
    /** null for the first frame, before the effect created this run's unit. */
    state: unit && unit.runId === runId ? unit.state : null,
    historyStatus,
    turnCount,
    hasActiveTurn: activeTurn !== null,
    /** The folded first prompt (W5a), when `foldBrief` was asked and history had one. */
    brief,
    pendingPermissions,
    usage,
    /** null until the config snapshot lands, or when the provider offers no selectors. */
    config,
    liveStatus,
    isGenerating,
    queuedCount,
    reloadHistory: () => (unit ? loadHistory(unit) : Promise.resolve()),
    /** The run's outbox: messages accepted but not yet with the daemon (never-lock, §2.4). */
    pending,
    /** Re-read the events and the outbox now (after a send, a retry, a drop). */
    refreshPending: () =>
      unit
        ? refreshMarkers(unit)
            .then((changed) => (changed ? loadHistory(unit) : undefined))
            .catch(() => {})
        : Promise.resolve(),
    // A message-triggered resume (ROAD-XXX) keeps this same unit alive
    // (awaitingSession suppressed, see SessionTranscript.tsx's `resuming`)
    // so the daemon's new session never runs this effect's own creation
    // path — the one place `source.reconnect()`/`usage.reconnect()` are
    // otherwise called. Exposed so the caller can reconnect explicitly
    // once that resume's daemon call actually resolves, the same way
    // `onEngineStatusChanged`'s "running" case already does for an engine
    // restart; the followers are keyed by runId, so a reconnect picks up
    // whatever live session the daemon now has for it either way.
    reconnect: () => {
      unit?.source.reconnect();
      unit?.usage.reconnect();
      unit?.config.reconnect();
    },
  };
}
