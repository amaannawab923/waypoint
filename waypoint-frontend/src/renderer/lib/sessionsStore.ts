import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { listMyAgentRuns } from '@/data/api';
import {
  getEngineStatus,
  installEngine,
  onEngineStatusChanged,
  onRunChanged,
} from '@/data/engineApi';
import type { AgentRun, AgentRunStatus } from '@/types/agentRuns';
import type { EngineStatus } from '@/types/engine';

/**
 * The one store behind "My sessions" — the sidebar badge, the session list
 * and every detail header read from here (W3, ROAD-61). Same Map/pub-sub
 * shape as lib/jiraStore.ts, holding two things:
 *
 *  - the user's runs, from the ledger (`listMyAgentRuns`), re-read on
 *    mount, after every run-control action, on every `runs:changed` push
 *    from main (the live follower wrote a row), and every REFRESH_MS as a
 *    safety net for writers that do not push;
 *  - the engine's status, seeded from the supervisor and updated by its
 *    push channel — so an empty list can say "the engine isn't running"
 *    rather than "no sessions", which are different claims.
 *
 * Grouping is a pure function of the ledger's status (§1 of
 * docs/design/w3-sessions-rail.md): *Waiting on you* first, then *Active*,
 * then *Done*, never user-sorted. Nothing here subscribes to the daemon's
 * session list — main holds that attachment and keeps the ledger in step
 * (main/engine/runs/liveLedgerFollower.ts).
 */

export type SessionGroup = 'waiting' | 'active' | 'done';

export interface SessionGroups {
  waiting: AgentRun[];
  active: AgentRun[];
  done: AgentRun[];
}

export interface SessionsSnapshot {
  runs: AgentRun[];
  /** undefined until the first read settled. */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  engine: EngineStatus | undefined;
}

export const REFRESH_MS = 30_000;
/** runs:changed arrives in bursts (blocked, then an event); one re-read per burst. */
const PUSH_DEBOUNCE_MS = 250;

const GROUP_OF: Record<AgentRunStatus, SessionGroup> = {
  blocked: 'waiting',
  'needs-review': 'waiting',
  queued: 'active',
  provisioning: 'active',
  running: 'active',
  finishing: 'active',
  done: 'done',
  failed: 'done',
  cancelled: 'done',
  interrupted: 'done',
};

export function groupOf(status: AgentRunStatus): SessionGroup {
  return GROUP_OF[status];
}

const byRecentActivity = (a: AgentRun, b: AgentRun) =>
  (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');

/** Waiting → active → done; within a group, most recent activity first. */
export function groupRuns(runs: readonly AgentRun[]): SessionGroups {
  const groups: SessionGroups = { waiting: [], active: [], done: [] };
  for (const run of runs) groups[groupOf(run.status)].push(run);
  groups.waiting.sort(byRecentActivity);
  groups.active.sort(byRecentActivity);
  groups.done.sort(byRecentActivity);
  return groups;
}

type Listener = () => void;

let snapshot: SessionsSnapshot = {
  runs: [],
  loaded: false,
  loading: false,
  error: null,
  engine: undefined,
};
const listeners = new Set<Listener>();

function emit(next: Partial<SessionsSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

let inFlight: Promise<void> | null = null;
let refreshAgain = false;

/** Re-read the user's runs from the ledger. Concurrent calls fold into one read plus one follow-up. */
export function refreshSessions(): Promise<void> {
  if (inFlight) {
    refreshAgain = true;
    return inFlight;
  }
  emit({ loading: true });
  inFlight = listMyAgentRuns()
    .then((runs) => emit({ runs, loaded: true, loading: false, error: null }))
    .catch((error: unknown) =>
      emit({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .finally(() => {
      inFlight = null;
      if (refreshAgain) {
        refreshAgain = false;
        refreshSessions().catch(() => {});
      }
    });
  return inFlight;
}

/** One row, as soon as a control action answered — before the next read lands. */
export function patchSessionRun(runId: string, patch: Partial<AgentRun>): void {
  emit({
    runs: snapshot.runs.map((run) =>
      run.id === runId ? { ...run, ...patch } : run,
    ),
  });
}

// Activity — polling, the push channels — runs only while something is
// subscribed, and starts once for the first subscriber.
let activeSubscribers = 0;
let stopActivity: (() => void) | null = null;

function startActivity(): () => void {
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const offRunChanged = onRunChanged(() => {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      refreshSessions().catch(() => {});
    }, PUSH_DEBOUNCE_MS);
  });
  const offEngine = onEngineStatusChanged((engine) => {
    const wasRunning = snapshot.engine?.kind === 'running';
    emit({ engine });
    // A daemon that came (back) up may have been reconciled against: read again.
    if (engine.kind === 'running' && !wasRunning)
      refreshSessions().catch(() => {});
  });
  // `install`, not `status`: status answers from the supervisor's last
  // observation, which at boot is nothing — a daemon that outlived the last
  // Waypoint stays unknown, and with it the boot reconcile and the live
  // follower, until someone opens This machine. The same call MachinePage
  // makes on mount: ensures the archive is extracted and verified, probes
  // the socket, adopts a running daemon. The store's first subscriber is
  // the sidebar badge, so this happens once per launch.
  installEngine()
    .then((engine) => emit({ engine }))
    .catch(() => {
      getEngineStatus()
        .then((engine) => emit({ engine }))
        .catch(() => {});
    });
  const poll = setInterval(() => {
    refreshSessions().catch(() => {});
  }, REFRESH_MS);
  refreshSessions().catch(() => {});
  return () => {
    if (pushTimer) clearTimeout(pushTimer);
    clearInterval(poll);
    offRunChanged();
    offEngine();
  };
}

let stopTimer: ReturnType<typeof setTimeout> | null = null;

export function subscribeSessions(listener: Listener): () => void {
  listeners.add(listener);
  activeSubscribers += 1;
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  if (activeSubscribers === 1 && !stopActivity) stopActivity = startActivity();
  return () => {
    listeners.delete(listener);
    activeSubscribers -= 1;
    // Stopped a tick later, not at once: the sidebar and the rail swap on
    // every entry to /sessions, and React unmounts the old badge before it
    // mounts the new one — an immediate stop restarted the poll, the push
    // listeners and the engine probe on every navigation (found in
    // review).
    if (activeSubscribers === 0 && !stopTimer) {
      stopTimer = setTimeout(() => {
        stopTimer = null;
        if (activeSubscribers === 0) {
          stopActivity?.();
          stopActivity = null;
        }
      }, 0);
    }
  };
}

export function getSessionsSnapshot(): SessionsSnapshot {
  return snapshot;
}

/** Test-only: a singleton outlives any one `it()` block. */
export function resetSessionsStoreForTests(): void {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = null;
  stopActivity?.();
  stopActivity = null;
  activeSubscribers = 0;
  snapshot = {
    runs: [],
    loaded: false,
    loading: false,
    error: null,
    engine: undefined,
  };
  inFlight = null;
  refreshAgain = false;
  for (const listener of listeners) listener();
}

export function useSessionsSnapshot(): SessionsSnapshot {
  return useSyncExternalStore(
    subscribeSessions,
    getSessionsSnapshot,
    getSessionsSnapshot,
  );
}

/** The panel's read: grouped runs plus the facts the empty states need. */
export function useMySessions() {
  const snap = useSessionsSnapshot();
  const groups = useMemo(() => groupRuns(snap.runs), [snap.runs]);
  return {
    ...snap,
    groups,
    waitingCount: groups.waiting.length,
    refresh: refreshSessions,
  };
}

/** The sidebar badge: how many runs are waiting on the user. */
export function useWaitingSessionsCount(): number {
  const snap = useSessionsSnapshot();
  return useMemo(
    () => snap.runs.filter((run) => groupOf(run.status) === 'waiting').length,
    [snap.runs],
  );
}

/** One run by id from the store, refreshed when asked for a run the store has not seen. */
export function useSessionRun(runId: string | undefined): AgentRun | undefined {
  const snap = useSessionsSnapshot();
  const run = runId ? snap.runs.find((r) => r.id === runId) : undefined;
  useEffect(() => {
    if (runId && snap.loaded && !run) refreshSessions().catch(() => {});
    // Only when the id changes or the first load lands — not on every snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, snap.loaded]);
  return run;
}
