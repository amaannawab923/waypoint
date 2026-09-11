import type { EngineSupervisor } from '../supervisor';
import type { Unsubscribe } from '../types';
import { createDaemonRunsApi } from './daemonApi';
import { createLedgerClient, type LedgerClient } from './ledgerClient';
import { reconcileRunsAtBoot, type ReconcileReport } from './reconcile';

/**
 * Runs ROAD-57's reconcile once for every connection the supervisor makes
 * to the daemon — at boot, and again after any reconnect — never on a
 * timer. `running.since` is the connection's identity: the same
 * connection reported twice (a status listener re-fire, a MachinePage
 * remount) reconciles once.
 *
 * Failures never reach the supervisor: a backend that is down when the
 * daemon comes up is a warning in the log and a retry on the next
 * connection, not an engine that reports `failed` for something that is
 * not the engine's.
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
}

export function registerBootReconcile(deps: BootReconcileDeps): Unsubscribe {
  const ledger = deps.ledger ?? createLedgerClient();
  let reconciledSince: number | null = null;
  let inFlight: Promise<void> | null = null;

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
      .then((report) => deps.onReport?.(report))
      .catch((error) => {
        // Let the next connection try again.
        reconciledSince = null;
        deps.logger.warn('engine: boot reconcile did not run', {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const current = deps.supervisor.getStatus();
  if (current.kind === 'running') reconcile(current.since);
  return deps.supervisor.onStatusChange((status) => {
    if (status.kind === 'running') reconcile(status.since);
  });
}
