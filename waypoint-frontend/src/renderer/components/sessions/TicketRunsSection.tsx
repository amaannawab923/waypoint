import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { listTicketAgentRuns } from '@/data/api';
import { onRunChanged } from '@/data/engineApi';
import { formatRelativeTime } from '@/lib/copilotSessions';
import { SESSIONS_ENABLED } from '@/lib/featureFlags';
import { IconGitBranch } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import type { AgentRun, BriefPreviewInput } from '@/types/agentRuns';
import { BriefPreviewDialog } from './BriefPreviewDialog';
import { IntentChip, ProviderChip } from './SessionRow';
import { SessionStatusPill } from './SessionStatusPill';
import { waitingReason } from './sessionStatus';

/**
 * A ticket's sessions, on the ticket page and in its drawer — W3 (ROAD-65)
 * for the runs, W5a (ROAD-119, docs/design/w5a-investigate-fix.md §1.1)
 * for the three verbs above them: **Investigate** (find the root cause,
 * change nothing), **Fix** (implement it), **Something else…** (the
 * person's own instruction, with one switch: may change files). Each
 * opens the brief preview; Start dispatches through main and opens the
 * run. The verbs are there with or without runs — the section is the
 * door into a session on this ticket; the history below it is only shown
 * when there is one.
 *
 * Re-read whenever main reports a run changed, so a run going blocked or
 * needs-review shows here as it does in the panel. Renders nothing with
 * the feature flag off — there is no panel to open a session in.
 */
export function TicketRunsSection({ ticketId }: { ticketId: string }) {
  if (!SESSIONS_ENABLED) return null;
  return <TicketRuns ticketId={ticketId} />;
}

/** The most a *Something else…* instruction may be — main's MAX_INSTRUCTIONS_CHARS, mirrored. */
export const INSTRUCTIONS_MAX = 4_000;

function TicketRuns({ ticketId }: { ticketId: string }) {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [request, setRequest] = useState<BriefPreviewInput | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [mayChangeFiles, setMayChangeFiles] = useState(false);

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

  // A different ticket: a fresh field.
  useEffect(() => {
    setCustomOpen(false);
    setInstructions('');
    setMayChangeFiles(false);
    setRequest(null);
  }, [ticketId]);

  const openCustom = () => {
    const text = instructions.trim();
    if (!text) return;
    setRequest({
      ticketId,
      intent: 'custom',
      instructions: text,
      mayChangeFiles,
    });
  };

  return (
    <div className="mt-6 px-6 md:px-8" data-ticket-runs>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-sm font-medium text-text">
          Sessions{runs && runs.length > 0 ? ` (${runs.length})` : ''}
        </h3>
        <div className="flex items-center gap-1.5" data-ticket-verbs>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setRequest({ ticketId, intent: 'investigate' })}
            title="Find the root cause in a fresh worktree; changes nothing"
          >
            Investigate
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setRequest({ ticketId, intent: 'fix' })}
            title="Implement the fix on a branch in a fresh worktree"
          >
            Fix
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={customOpen}
            onClick={() => setCustomOpen((v) => !v)}
            className={clsx(customOpen && 'bg-surface-2')}
          >
            Something else…
          </Button>
        </div>
      </div>

      {customOpen && (
        <div
          className="mb-3 flex flex-col gap-2 rounded-[var(--radius-sm)] border border-border bg-bg-inset p-3"
          data-ticket-custom
        >
          <textarea
            aria-label="What the session should do"
            value={instructions}
            maxLength={INSTRUCTIONS_MAX}
            onChange={(e) => setInstructions(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                openCustom();
              }
            }}
            rows={3}
            placeholder="Tell the session what to do on this ticket — it gets the ticket and its comments too."
            className="thin-scroll resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Switch
                id={`ticket-custom-may-change-${ticketId}`}
                label="May change files"
                checked={mayChangeFiles}
                onChange={setMayChangeFiles}
              />
              <label
                htmlFor={`ticket-custom-may-change-${ticketId}`}
                className="text-xs text-text-secondary"
              >
                {mayChangeFiles
                  ? 'May change files — a writing session on a branch'
                  : 'Reads only — plan mode, changes nothing'}
              </label>
            </div>
            <Button
              size="sm"
              variant="primary"
              onClick={openCustom}
              disabled={instructions.trim().length === 0}
            >
              Preview brief…
            </Button>
          </div>
        </div>
      )}

      {runs && runs.length > 0 && (
        <div className="flex flex-col gap-2">
          {runs.map((run) => {
            const reason = waitingReason(run);
            return (
              <div
                key={run.id}
                className="flex items-center gap-2.5 rounded-[var(--radius)] border border-border bg-surface px-3 py-2 text-xs"
              >
                <SessionStatusPill status={run.status} />
                {run.entry === 'dispatched' ? (
                  <IntentChip run={run} />
                ) : (
                  <ProviderChip providerId={run.providerId} />
                )}
                <span className="min-w-0 flex-1 truncate text-text-secondary">
                  {run.branch ? (
                    <span className="inline-flex items-center gap-1 font-mono">
                      <IconGitBranch size={10} />
                      {run.branch}
                    </span>
                  ) : (
                    <span className="font-mono">{run.id}</span>
                  )}
                  {reason && (
                    <span className="ml-2 text-warning">{reason}</span>
                  )}
                  {!reason && run.summary && (
                    <span className="ml-2 text-text-muted">{run.summary}</span>
                  )}
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
      )}

      <BriefPreviewDialog request={request} onClose={() => setRequest(null)} />
    </div>
  );
}
