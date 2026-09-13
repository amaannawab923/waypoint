import type { AgentRun, AgentRunStatus } from './runs/ledgerClient';

/**
 * The two notifications a run sends — W5a, ROAD-120
 * (docs/design/w5a-investigate-fix.md §1.5, §3.5).
 *
 * Only two, on purpose: the run went **blocked** (the agent asked for
 * something the mode does not grant — the person is the only one who can
 * move it), and the run **needs review** (it finished; proposals wait).
 * Nothing for running, finishing, done, failed: the panel shows those,
 * and a notification that fires on every transition is one nobody reads.
 * Clicking either focuses the window and opens the run (`runs:focus`).
 *
 * The OS notification itself is behind `NotificationHost` so this module
 * is a unit test with a fake; engineIpc.ts supplies Electron's.
 */
export interface NotificationHost {
  /** False when the OS cannot show notifications (Electron's `Notification.isSupported()`). */
  isSupported(): boolean;
  /** Shows one; `onClick` is called when the person clicks it. */
  show(
    notification: { title: string; body: string },
    onClick: () => void,
  ): void;
}

export interface RunNotificationsDeps {
  host: NotificationHost;
  /** Bring the app forward and open the run: `win.show()`, `win.focus()`, then `runs:focus`. */
  focusRun: (runId: string) => void;
  logger: {
    info?: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
}

/** The most of a reason or summary a notification body carries. */
export const MAX_BODY_CHARS = 160;

function clip(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function nameOf(run: AgentRun): string {
  return run.title ?? run.branch ?? run.id;
}

/** The notification a status change deserves, or null for the ones that get none. */
export function notificationFor(
  run: AgentRun,
  previous: AgentRunStatus,
): { title: string; body: string } | null {
  if (run.status === 'blocked' && previous !== 'blocked') {
    return {
      title: `${nameOf(run)} needs you`,
      body: clip(
        run.blockedReason ?? 'The agent is waiting for your permission.',
        MAX_BODY_CHARS,
      ),
    };
  }
  if (run.status === 'needs-review' && previous !== 'needs-review') {
    return {
      title: `${nameOf(run)} finished`,
      body: clip(
        run.summary ?? 'Proposals are waiting for your review.',
        MAX_BODY_CHARS,
      ),
    };
  }
  return null;
}

export function createRunNotifications(deps: RunNotificationsDeps): {
  onRunStatus: (run: AgentRun, previous: AgentRunStatus) => void;
} {
  return {
    onRunStatus(run, previous) {
      const notification = notificationFor(run, previous);
      if (!notification) return;
      if (!deps.host.isSupported()) return;
      try {
        deps.host.show(notification, () => deps.focusRun(run.id));
        deps.logger.info?.('engine: notification shown', {
          runId: run.id,
          status: run.status,
          title: notification.title,
        });
      } catch (error) {
        deps.logger.warn('engine: notification not shown', {
          runId: run.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
