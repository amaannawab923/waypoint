import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listTicketAgentRuns } from '@/data/api';
import { onRunChanged } from '@/data/engineApi';
import { formatRelativeTime } from '@/lib/copilotSessions';
import { SESSIONS_ENABLED } from '@/lib/featureFlags';
import { IconGitBranch } from '@/components/icons';
import type { AgentRun } from '@/types/agentRuns';
import { ProviderChip } from './SessionRow';
import { SessionStatusPill } from './SessionStatusPill';
import { waitingReason } from './sessionStatus';

/**
 * A ticket's runs, on the ticket page and in its drawer (W3, ROAD-65 —
 * ROAD-56's `/tickets/:id/agent-runs`): status, provider, branch, age, and
 * "Open session →" into the panel. No empty state: a ticket with no runs
 * shows no section at all, the same rule the Pending proposals section
 * beside it follows (do not imply agent activity that is not there).
 * Re-read whenever main reports a run changed, so a run going blocked
 * shows here as it does in the panel. Renders nothing with the feature
 * flag off — there is no panel to open a session in.
 */
export function TicketRunsSection({ ticketId }: { ticketId: string }) {
  if (!SESSIONS_ENABLED) return null;
  return <TicketRuns ticketId={ticketId} />;
}

function TicketRuns({ ticketId }: { ticketId: string }) {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<AgentRun[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await listTicketAgentRuns(ticketId);
        if (!cancelled) setRuns(rows);
      } catch {
        // The http client already toasted; the section stays as it was.
      }
    };
    load().catch(() => {});
    const off = onRunChanged(() => {
      load().catch(() => {});
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [ticketId]);

  if (!runs || runs.length === 0) return null;

  return (
    <div className="mt-6 px-6 md:px-8" data-ticket-runs>
      <h3 className="mb-2 font-display text-sm font-medium text-text">
        Runs ({runs.length})
      </h3>
      <div className="flex flex-col gap-2">
        {runs.map((run) => {
          const reason = waitingReason(run);
          return (
            <div
              key={run.id}
              className="flex items-center gap-2.5 rounded-[var(--radius)] border border-border bg-surface px-3 py-2 text-xs"
            >
              <SessionStatusPill status={run.status} />
              <ProviderChip providerId={run.providerId} />
              <span className="min-w-0 flex-1 truncate text-text-secondary">
                {run.branch ? (
                  <span className="inline-flex items-center gap-1 font-mono">
                    <IconGitBranch size={10} />
                    {run.branch}
                  </span>
                ) : (
                  <span className="font-mono">{run.id}</span>
                )}
                {reason && <span className="ml-2 text-warning">{reason}</span>}
              </span>
              <span className="shrink-0 text-text-muted">
                {formatRelativeTime(run.updatedAt)}
              </span>
              <button
                type="button"
                onClick={() =>
                  navigate(`/sessions/${encodeURIComponent(run.id)}`)
                }
                className="shrink-0 font-medium text-text underline-offset-2 hover:underline"
              >
                Open session →
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
