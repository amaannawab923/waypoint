import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { Button, IconButton } from '@/components/ui/Button';
import { IconChevron, IconGitBranch, IconFolder } from '@/components/icons';
import { resumeRun, revealRunWorktree, stopRun } from '@/data/engineApi';
import { formatRelativeTime } from '@/lib/copilotSessions';
import { patchSessionRun, refreshSessions } from '@/lib/sessionsStore';
import { useTicketSummary } from '@/lib/useTicketLabel';
import { showErrorToast } from '@/lib/toast';
import type { AgentRun } from '@/types/agentRuns';
import { ProviderChip } from './SessionRow';
import { SessionStatusPill } from './SessionStatusPill';
import { providerView, runTitle, statusView } from './sessionStatus';
import { SessionTranscript } from './SessionTranscript';
import { DiffPane } from './DiffPane';

export type SessionTab = 'transcript' | 'diff';

/** The ledger's error_kind vocabulary, as a person reads it. */
const ERROR_KIND_LABEL: Record<string, string> = {
  provision: 'Worktree',
  start: 'Session start',
  resume: 'Resume',
  session: 'Session',
};

/**
 * Everything right of the session list (W3, docs/design/w3-sessions-rail.md
 * §1.5): the header — title, status pill, provider, branch ← base, age,
 * Stop, open worktree, ticket link — the Transcript | Diff tabs, and the
 * body each tab owns. The diff is a tab that replaces the transcript in
 * place, never a side inspector (§1.8), so the transcript keeps the whole
 * width while it is the thing being read. Mounted with `key={run.id}` by
 * the page, so a different run is a fresh pane (tab, counts, in-flight
 * stop) by construction.
 */
export function SessionDetail({
  run,
  narrow,
  onBack,
}: {
  run: AgentRun;
  /** Under 1100 px the list is hidden behind this pane; the header grows a back chevron. */
  narrow: boolean;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const ticket = useTicketSummary(run.ticketId);
  const view = statusView(run.status);
  const provider = providerView(run.providerId);
  const [tab, setTab] = useState<SessionTab>('transcript');
  const [stopping, setStopping] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [diffCount, setDiffCount] = useState<number | null>(null);

  const stop = async () => {
    setStopping(true);
    try {
      const result = await stopRun(run.id);
      if (result.outcome === 'stopped' || result.outcome === 'ledger-only') {
        patchSessionRun(run.id, { status: 'cancelled' });
      }
      if (result.outcome === 'ledger-only') {
        showErrorToast(
          'Recorded as cancelled, but the engine did not confirm the session ended — it is killed at the next launch if it is still there.',
        );
      }
      await refreshSessions();
    } catch (error) {
      showErrorToast(
        error instanceof Error ? error.message : 'Could not stop the session.',
      );
    } finally {
      setStopping(false);
    }
  };

  // W4, ROAD-69: the daemon loads the same provider session in the same
  // worktree; when the provider cannot, main starts a fresh one there and
  // says so — here as a toast, and in the transcript as its first message.
  const resume = async () => {
    setResuming(true);
    try {
      const result = await resumeRun(run.id);
      switch (result.outcome) {
        case 'loaded':
          patchSessionRun(run.id, { status: 'running' });
          break;
        case 'replaced-by-new':
          patchSessionRun(run.id, { status: 'running' });
          // The one toast channel there is; this is a warning in any case.
          showErrorToast(
            'The provider could not restore the previous conversation; a fresh session was started in the same worktree with the branch state as its first message.',
          );
          break;
        case 'worktree-gone':
          showErrorToast(
            'This run’s worktree is no longer on disk; there is nothing to resume on.',
          );
          break;
        case 'not-resumable':
          showErrorToast(
            `This run is ${result.status}; only an interrupted run can be resumed.`,
          );
          break;
        default:
      }
      await refreshSessions();
    } catch (error) {
      showErrorToast(
        error instanceof Error
          ? error.message
          : 'Could not resume the session.',
      );
      await refreshSessions();
    } finally {
      setResuming(false);
    }
  };

  const reveal = () =>
    revealRunWorktree(run.id).catch((error: unknown) =>
      showErrorToast(
        error instanceof Error ? error.message : 'Could not open the worktree.',
      ),
    );

  const title = runTitle(run, ticket?.label);
  const startedAt = run.startedAt ?? run.createdAt;

  return (
    <section
      data-session-detail
      aria-label={title}
      className="flex h-full min-w-0 flex-1 flex-col bg-bg"
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-start gap-2">
          {narrow && (
            <IconButton
              label="Back to sessions"
              onClick={onBack}
              className="-ml-1 mt-0.5"
            >
              <IconChevron size={15} className="rotate-90" />
            </IconButton>
          )}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate font-display text-[13px] font-semibold text-text">
                {title}
              </h1>
              <SessionStatusPill status={run.status} />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px] text-text-muted">
              <span className="inline-flex items-center gap-1">
                <ProviderChip providerId={run.providerId} size={14} />
                {provider.name}
              </span>
              {run.branch && (
                <span className="inline-flex items-center gap-1">
                  <IconGitBranch size={10} />
                  <span className="font-mono">{run.branch}</span>
                  {run.baseRef && (
                    <>
                      {' '}
                      from <span className="font-mono">{run.baseRef}</span>
                    </>
                  )}
                </span>
              )}
              <span>
                {run.status === 'blocked'
                  ? `waiting ${formatRelativeTime(run.updatedAt)}`
                  : `started ${formatRelativeTime(startedAt)} ago`}
              </span>
              {ticket && run.projectId && (
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      `/projects/${run.projectId}/tickets/${ticket.identifier}`,
                    )
                  }
                  className="font-mono text-text-secondary underline-offset-2 hover:underline"
                >
                  {ticket.identifier} ↗
                </button>
              )}
              {run.prUrl && (
                <a
                  href={run.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-text-secondary underline-offset-2 hover:underline"
                >
                  Pull request ↗
                </a>
              )}
            </div>
            {run.errorMessage && (
              <p
                data-run-error
                className="mt-1 line-clamp-2 text-[11px] text-danger"
                title={run.errorMessage}
              >
                {run.errorKind
                  ? `${ERROR_KIND_LABEL[run.errorKind] ?? run.errorKind}: `
                  : ''}
                {run.errorMessage}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {run.status === 'interrupted' && (
            <Button
              size="xs"
              variant="primary"
              onClick={resume}
              disabled={resuming || !run.worktreePath}
              title={
                run.worktreePath
                  ? undefined
                  : 'This run has no worktree to resume on.'
              }
            >
              {resuming ? 'Resuming…' : 'Resume'}
            </Button>
          )}
          {view.stoppable && (
            <Button
              size="xs"
              variant={run.status === 'blocked' ? 'danger' : 'secondary'}
              onClick={stop}
              disabled={stopping}
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          )}
          {run.worktreePath && (
            <IconButton label="Show worktree in Finder" onClick={reveal}>
              <IconFolder size={14} />
            </IconButton>
          )}
        </div>
      </header>

      <div
        role="tablist"
        aria-label="Session views"
        className="flex shrink-0 gap-4 border-b border-border px-4"
      >
        {(
          [
            ['transcript', 'Transcript'],
            [
              'diff',
              diffCount === null
                ? 'Diff'
                : `Diff · ${diffCount} file${diffCount === 1 ? '' : 's'}`,
            ],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={clsx(
              '-mb-px border-b-2 py-1.5 text-[11px] font-semibold transition-colors',
              tab === key
                ? 'border-text text-text'
                : 'border-transparent text-text-muted hover:text-text-secondary',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Keyed by run: a different run is a different transcript and a
          different diff, with nothing carried over from the last one. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'transcript' ? (
          <SessionTranscript key={run.id} run={run} />
        ) : (
          <DiffPane key={run.id} run={run} onFileCount={setDiffCount} />
        )}
      </div>
    </section>
  );
}
