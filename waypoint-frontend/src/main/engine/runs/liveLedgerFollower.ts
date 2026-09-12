import type { EngineSupervisor } from '../supervisor';
import type { RunChanged, Unsubscribe, WireClient } from '../types';
import { liveTopic } from '../wire/topics';
import { readSnapshot, type DaemonSessionSummary } from './daemonApi';
import {
  createLedgerClient,
  type AgentRun,
  type LedgerClient,
} from './ledgerClient';
import { RUN_ID_PREFIX } from './reconcile';

/**
 * Keeps the ledger in step with the daemon while the engine runs — W3,
 * ROAD-63's "status shows blocked while waiting".
 *
 * Boot reconcile (ROAD-57) compares the ledger with the daemon once per
 * connection. This follower does the live half: it holds the one
 * attachment a Wire client allows on `acp.sessions.list` (which is why
 * the renderer may not subscribe to that topic — types.ts) and, every time
 * the list changes, re-reads it and looks at each of our runs:
 *
 *  - a permission pending on a `running` run → `blocked`, with the tool
 *    call's title as the reason the list shows, and a
 *    `permission_requested` event;
 *  - no permission pending on a `blocked` run → `running`, and a
 *    `permission_answered` event;
 *  - a session closed or gone while its run is `running`/`blocked` →
 *    `interrupted`, after a short grace so a stop from the panel (which
 *    kills the session, then writes `cancelled`) is not raced.
 *
 * Every decision re-reads the run from the ledger first, so a row another
 * writer changed meanwhile (stop, W4's orchestrator) is judged fresh, and
 * a write the status machine refuses (a 409) is logged and dropped, never
 * retried into a loop. Turn counting and finishing are not this
 * follower's: those are the orchestrator's (W4/W5). After every write the
 * renderer is told through `notify` (RUNS_IPC.changed) so the panel
 * re-reads the ledger instead of guessing.
 */
export interface LiveLedgerFollowerDeps {
  supervisor: EngineSupervisor;
  ledger?: LedgerClient;
  /** RUNS_IPC.changed to the renderer. */
  notify: (change: RunChanged) => void;
  logger: {
    info: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
  /** Test seams. */
  graceMs?: number;
  debounceMs?: number;
}

/** A session that vanished is given this long to be explained by a `cancelled` write. */
export const GONE_GRACE_MS = 3_000;
/** Updates arrive in bursts; the list is re-read once per burst. */
export const REREAD_DEBOUNCE_MS = 150;

const SESSIONS_TOPIC = liveTopic('acp.sessions.list');

const LIVE: ReadonlySet<AgentRun['status']> = new Set(['running', 'blocked']);

interface SessionFacts {
  pending: number;
  lifecycle: string;
}

interface PendingPermissionView {
  requestId?: string;
  toolCall?: { title?: string; kind?: string; command?: string };
}

/** "Wants to run pnpm test" / "Wants to edit src/a.ts" — from the first pending request. */
export function describePendingPermission(
  request: PendingPermissionView | undefined,
): string {
  const title = request?.toolCall?.title?.trim();
  const command = request?.toolCall?.command?.trim();
  if (request?.toolCall?.kind === 'execute-tool-call' && command)
    return `Wants to run ${command}`;
  if (title)
    return `Wants to ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
  return 'Waiting for your permission';
}

export function registerLiveLedgerFollower(
  deps: LiveLedgerFollowerDeps,
): Unsubscribe {
  const ledger = deps.ledger ?? createLedgerClient();
  const graceMs = deps.graceMs ?? GONE_GRACE_MS;
  const debounceMs = deps.debounceMs ?? REREAD_DEBOUNCE_MS;

  let client: WireClient | null = null;
  let detach: Unsubscribe | null = null;
  let attachedSince: number | null = null;
  let rereadTimer: ReturnType<typeof setTimeout> | null = null;
  let rereading: Promise<void> | null = null;
  let rereadAgain = false;
  const lastSeen = new Map<string, SessionFacts>();
  const goneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const warn = (
    message: string,
    error: unknown,
    meta: Record<string, unknown> = {},
  ) =>
    deps.logger.warn(message, {
      ...meta,
      error: error instanceof Error ? error.message : String(error),
    });

  const write = async (
    run: AgentRun,
    patch: Parameters<LedgerClient['updateRun']>[1],
    event: {
      kind: 'permission_requested' | 'permission_answered' | 'session_ended';
      payload: Record<string, unknown>;
    } | null,
  ): Promise<void> => {
    let updated: AgentRun;
    try {
      updated = await ledger.updateRun(run.id, patch);
    } catch (error) {
      // A refused move (409) is another writer having got there first —
      // stop wrote `cancelled` a moment ago, say. Dropped, not retried.
      warn('engine: live follower could not write the run', error, {
        runId: run.id,
        from: run.status,
        to: patch.status,
      });
      return;
    }
    if (event) {
      await ledger
        .appendEvent(run.id, event.kind, event.payload)
        .catch((error) =>
          warn('engine: event not recorded', error, { runId: run.id }),
        );
    }
    deps.logger.info('engine: run followed', {
      runId: run.id,
      from: run.status,
      to: updated.status,
    });
    deps.notify({ runId: run.id, status: updated.status });
  };

  const freshRun = async (runId: string): Promise<AgentRun | null> => {
    try {
      return await ledger.getRun(runId);
    } catch (error) {
      warn('engine: live follower could not read the run', error, { runId });
      return null;
    }
  };

  const reasonFor = async (
    runId: string,
  ): Promise<{ reason: string; requestId: string | null }> => {
    if (!client)
      return { reason: 'Waiting for your permission', requestId: null };
    try {
      const state = await readSnapshot<{
        pendingPermissions?: PendingPermissionView[];
      }>(client, liveTopic('acp.session.state', { conversationId: runId }));
      const first = state?.pendingPermissions?.[0];
      return {
        reason: describePendingPermission(first),
        requestId: first?.requestId ?? null,
      };
    } catch (error) {
      warn('engine: could not read the pending permission', error, { runId });
      return { reason: 'Waiting for your permission', requestId: null };
    }
  };

  const markInterrupted = async (runId: string, why: string): Promise<void> => {
    const run = await freshRun(runId);
    if (!run || !LIVE.has(run.status)) return;
    await write(
      run,
      { status: 'interrupted', reason: why },
      {
        kind: 'session_ended',
        payload: { reason: 'interrupted', detail: why },
      },
    );
  };

  const scheduleGone = (runId: string, why: string) => {
    if (goneTimers.has(runId)) return;
    goneTimers.set(
      runId,
      setTimeout(() => {
        goneTimers.delete(runId);
        if (!disposed) markInterrupted(runId, why).catch(() => {});
      }, graceMs),
    );
  };

  const cancelGone = (runId: string) => {
    const timer = goneTimers.get(runId);
    if (timer) clearTimeout(timer);
    goneTimers.delete(runId);
  };

  const judge = async (runId: string, facts: SessionFacts): Promise<void> => {
    const run = await freshRun(runId);
    if (!run || !LIVE.has(run.status)) return;
    if (facts.lifecycle === 'closed') {
      scheduleGone(runId, 'The daemon closed the session');
      return;
    }
    cancelGone(runId);
    if (facts.pending > 0 && run.status === 'running') {
      const { reason, requestId } = await reasonFor(runId);
      await write(
        run,
        {
          status: 'blocked',
          reason: 'The agent asked for a permission',
          blockedReason: reason,
        },
        { kind: 'permission_requested', payload: { requestId, reason } },
      );
    } else if (facts.pending === 0 && run.status === 'blocked') {
      await write(
        run,
        {
          status: 'running',
          reason: 'The permission was answered',
          blockedReason: null,
        },
        { kind: 'permission_answered', payload: {} },
      );
    }
  };

  const apply = async (
    sessions: Record<string, DaemonSessionSummary>,
  ): Promise<void> => {
    const present = new Set<string>();
    const ours = Object.values(sessions).filter((s) =>
      s.conversationId.startsWith(RUN_ID_PREFIX),
    );
    for (const summary of ours) {
      const facts: SessionFacts = {
        pending: summary.pendingPermissionCount,
        lifecycle: String(summary.lifecycle),
      };
      present.add(summary.conversationId);
      const before = lastSeen.get(summary.conversationId);
      lastSeen.set(summary.conversationId, facts);
      // Judged when the facts changed — and on the first sight of a session
      // (a follower that just attached), since the ledger may disagree.
      if (
        !before ||
        before.pending !== facts.pending ||
        before.lifecycle !== facts.lifecycle
      ) {
        await judge(summary.conversationId, facts);
      }
    }
    for (const runId of [...lastSeen.keys()]) {
      if (present.has(runId)) continue;
      lastSeen.delete(runId);
      scheduleGone(runId, 'The daemon no longer has the session');
    }
  };

  const reread = (): void => {
    if (rereading) {
      rereadAgain = true;
      return;
    }
    const c = client;
    if (!c) return;
    rereading = readSnapshot<Record<string, DaemonSessionSummary>>(
      c,
      SESSIONS_TOPIC,
    )
      .then((sessions) => (disposed ? undefined : apply(sessions ?? {})))
      .catch((error) =>
        warn('engine: live follower could not read the session list', error),
      )
      .finally(() => {
        rereading = null;
        if (rereadAgain) {
          rereadAgain = false;
          reread();
        }
      });
  };

  const scheduleReread = () => {
    if (rereadTimer) clearTimeout(rereadTimer);
    rereadTimer = setTimeout(() => {
      rereadTimer = null;
      reread();
    }, debounceMs);
  };

  const dropConnection = () => {
    if (rereadTimer) clearTimeout(rereadTimer);
    rereadTimer = null;
    detach?.();
    detach = null;
    client = null;
    attachedSince = null;
    lastSeen.clear();
    for (const timer of goneTimers.values()) clearTimeout(timer);
    goneTimers.clear();
  };

  const follow = (since: number) => {
    if (attachedSince === since) return;
    const c = deps.supervisor.client();
    if (!c) return;
    dropConnection();
    client = c;
    attachedSince = since;
    c.attach(SESSIONS_TOPIC, {
      onSnapshot: () => scheduleReread(),
      onUpdate: () => scheduleReread(),
      onGap: () => scheduleReread(),
      onError: (error, retrying) => {
        if (retrying) return;
        deps.logger.warn('engine: live follower lost the session list', {
          code: error.code,
          message: error.message,
        });
      },
    })
      .then((unsubscribe) => {
        if (client !== c || disposed) unsubscribe();
        else detach = unsubscribe;
        return undefined;
      })
      .catch((error) => {
        if (client !== c) return;
        warn(
          'engine: live follower could not attach to the session list',
          error,
        );
        attachedSince = null;
      });
  };

  const current = deps.supervisor.getStatus();
  if (current.kind === 'running') follow(current.since);
  const unsubscribe = deps.supervisor.onStatusChange((status) => {
    if (status.kind === 'running') follow(status.since);
    else dropConnection();
  });

  return () => {
    disposed = true;
    unsubscribe();
    dropConnection();
  };
}
