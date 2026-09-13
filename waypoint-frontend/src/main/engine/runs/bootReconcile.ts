import type { EngineSupervisor } from '../supervisor';
import type { Unsubscribe } from '../types';
import { createDaemonRunsApi } from './daemonApi';
import { createLedgerClient, type LedgerClient } from './ledgerClient';
import { reconcileRunsAtBoot, type ReconcileReport } from './reconcile';

/**
 * Runs ROAD-57's reconcile once for every connection the supervisor makes
 * to the daemon — at boot, and again after any reconnect — never
 * periodically. `running.since` is the connection's identity: the same
 * connection reported twice (a status listener re-fire, a MachinePage
 * remount) reconciles once.
 *
 * Failures never reach the supervisor: a backend that is not up yet when
 * the daemon is (the common boot order in development — the daemon
 * outlived the last Waypoint, the backend is `npm run dev` a moment
 * later) is a warning in the log and a few spaced retries, then a retry
 * on the next connection. Never an engine that reports `failed` for
 * something that is not the engine's.
 */
export interface BootReconcileDeps {
  supervisor: EngineSupervisor;
  ledger?: LedgerClient;
  logger: {
    info: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
  /** Test seam: observe each reconcile's outcome. */
  onReport?: (report: ReconcileReport) => void;
  /** Test seam: retry spacing. */
  retryDelayMs?: number;
}

/** A failed reconcile is retried this many times, `RETRY_DELAY_MS` apart, before waiting for the next connection. */
export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 15_000;

export function registerBootReconcile(deps: BootReconcileDeps): Unsubscribe {
  const ledger = deps.ledger ?? createLedgerClient();
  const retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
  let reconciledSince: number | null = null;
  let inFlight: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retriesLeft = MAX_RETRIES;
  // The connection that most recently asked. A reconnect that lands while
  // a reconcile is still running is not reconciled by that run (it read
  // the old connection's sessions), so it is remembered and re-run once
  // the in-flight one settles (review round 2).
  let latestSince: number | null = null;

  const cancelRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = (message: string, retriesLeftNow: number) => {
    deps.logger.warn('engine: boot reconcile did not run; retrying', {
      message,
      inMs: retryDelayMs,
      retriesLeft: retriesLeftNow,
    });
    cancelRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const status = deps.supervisor.getStatus();
      if (status.kind === 'running') reconcile(status.since);
    }, retryDelayMs);
  };

  const reconcile = (since: number): void => {
    latestSince = since;
    if (reconciledSince === since || inFlight) return;
    const client = deps.supervisor.client();
    if (!client) return;
    reconciledSince = since;
    inFlight = reconcileRunsAtBoot({
      daemon: createDaemonRunsApi(client),
      ledger,
      logger: deps.logger,
    })
      .then((report) => {
        deps.onReport?.(report);
        // A plan that ran but could not apply every action (the backend
        // restarted between the read and the writes, say) is not done:
        // the rows it could not fix would sit wrong for the life of a
        // connection that may never drop. Retried like a failed read
        // (review round 2).
        if (report.failures.length > 0 && retriesLeft > 0) {
          reconciledSince = null;
          retriesLeft -= 1;
          scheduleRetry(
            `${report.failures.length} action(s) failed`,
            retriesLeft,
          );
          return;
        }
        retriesLeft = MAX_RETRIES;
      })
      .catch((error) => {
        reconciledSince = null;
        const message = error instanceof Error ? error.message : String(error);
        if (retriesLeft > 0) {
          retriesLeft -= 1;
          scheduleRetry(message, retriesLeft);
        } else {
          deps.logger.warn(
            'engine: boot reconcile did not run; will try on the next connection',
            { message },
          );
        }
      })
      .finally(() => {
        inFlight = null;
        // A newer connection asked while this one ran: its turn. Compared
        // against the connection THIS run was for, not `reconciledSince`
        // (a failure resets that to null, which must not re-run the same
        // connection outside the retry budget).
        if (latestSince !== null && latestSince !== since) {
          const status = deps.supervisor.getStatus();
          if (status.kind === 'running' && status.since === latestSince)
            reconcile(latestSince);
        }
      });
  };

  const current = deps.supervisor.getStatus();
  if (current.kind === 'running') reconcile(current.since);
  const unsubscribe = deps.supervisor.onStatusChange((status) => {
    if (status.kind === 'running') {
      reconcile(status.since);
    } else {
      // A connection that went away takes its pending retry with it; the
      // next `running` is a fresh start with a full retry budget.
      cancelRetry();
      retriesLeft = MAX_RETRIES;
    }
  });
  return () => {
    cancelRetry();
    unsubscribe();
  };
}
