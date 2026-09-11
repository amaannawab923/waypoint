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

  const cancelRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const reconcile = (since: number): void => {
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
        retriesLeft = MAX_RETRIES;
        deps.onReport?.(report);
      })
      .catch((error) => {
        reconciledSince = null;
        const message = error instanceof Error ? error.message : String(error);
        if (retriesLeft > 0) {
          retriesLeft -= 1;
          deps.logger.warn('engine: boot reconcile did not run; retrying', {
            message,
            inMs: retryDelayMs,
            retriesLeft,
          });
          cancelRetry();
          retryTimer = setTimeout(() => {
            retryTimer = null;
            const status = deps.supervisor.getStatus();
            if (status.kind === 'running') reconcile(status.since);
          }, retryDelayMs);
        } else {
          deps.logger.warn(
            'engine: boot reconcile did not run; will try on the next connection',
            { message },
          );
        }
      })
      .finally(() => {
        inFlight = null;
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
