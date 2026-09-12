import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Switch } from '@/components/ui/Switch';
import { IconFolder, IconGitBranch } from '@/components/icons';
import { getWorkspace } from '@/data/api';
import { CURRENT_USER_ID } from '@/data/currentUser';
import { dispatchRun, getBriefPreview } from '@/data/engineApi';
import { workspaceDefaultProvider } from '@/lib/sessionProviders';
import type {
  AgentRun,
  BriefPreview,
  BriefPreviewInput,
  RunIntent,
  SupportedProviderId,
} from '@/types/agentRuns';

/**
 * The brief preview — W5a, ROAD-119 (docs/design/w5a-investigate-fix.md
 * §1.3). What the session will be told, as editable text, built in main
 * from the ledger's view of the ticket; under it the facts: the
 * repository, the worktree's branch and base, the mode the verb implies,
 * and for a writing session the auto-approve switch. Start (⌘⏎)
 * dispatches and opens the run.
 *
 * Opened from the ticket's verbs (TicketRunsSection) and from Copilot's
 * slash commands and offers (CopilotPanel); both hand in a
 * `BriefPreviewInput` and, from Copilot, the conversation the run's
 * notes go back to. Nothing here names a path: the repository arrives
 * described, as a folder handle main minted.
 */

export const INTENT_LABEL: Record<RunIntent, string> = {
  investigate: 'Investigate',
  fix: 'Fix',
  custom: 'Something else…',
};

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'ready'; preview: BriefPreview }
  | { kind: 'error'; message: string };

const fieldClass =
  'h-8 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2 text-xs text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60';

export function BriefPreviewDialog({
  request,
  copilotConversationId = null,
  onClose,
  onStarted,
}: {
  /** The verb and ticket to preview; null keeps the dialog closed. */
  request: BriefPreviewInput | null;
  /** The Copilot conversation the verb was used from, when it was. */
  copilotConversationId?: string | null;
  onClose: () => void;
  /** After the run is dispatched; defaults to opening it in the sessions panel. */
  onStarted?: (run: AgentRun) => void;
}) {
  const navigate = useNavigate();
  const open = request !== null;
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });
  const [brief, setBrief] = useState('');
  const [baseRef, setBaseRef] = useState<string | null>(null);
  // *Something else…* only: the switch, when the request came without one
  // (a slash command); null = as the request said.
  const [mayChangeFiles, setMayChangeFiles] = useState<boolean | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  // Refs, not state: read inside the load effect without re-running it.
  const autoApproveTouched = useRef(false);
  const lastRequest = useRef<BriefPreviewInput | null>(null);
  const [providerId, setProviderId] = useState<SupportedProviderId | null>(
    null,
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A request, or a base branch change: the preview afresh. The brief
  // names the base, so it is rebuilt; an edit the person made is kept
  // only while the base stands. A fresh request starts over — no base
  // override (the effect re-runs once with it cleared), the switch at
  // its default.
  useEffect(() => {
    if (!request) return undefined;
    if (lastRequest.current !== request) {
      lastRequest.current = request;
      autoApproveTouched.current = false;
      if (baseRef !== null || mayChangeFiles !== null) {
        setBaseRef(null);
        setMayChangeFiles(null);
        return undefined;
      }
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    setError(null);
    setStarting(false);
    const load = async () => {
      try {
        const preview = await getBriefPreview({
          ...request,
          ...(baseRef ? { baseRef } : {}),
          ...(mayChangeFiles !== null ? { mayChangeFiles } : {}),
        });
        if (cancelled) return;
        setState({ kind: 'ready', preview });
        setBrief(preview.brief);
        if (!autoApproveTouched.current)
          setAutoApprove(preview.autoApproveDefault);
      } catch (reason) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message:
            reason instanceof Error
              ? reason.message
              : 'The brief could not be built.',
        });
      }
    };
    load().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [request, baseRef, mayChangeFiles]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    getWorkspace()
      .then((ws) => {
        if (!cancelled)
          setProviderId(workspaceDefaultProvider(ws.defaultAgentProvider));
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setProviderId(workspaceDefaultProvider(null));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const preview = state.kind === 'ready' ? state.preview : null;
  const writing = preview?.mode === 'write';
  const blockedByWriter = !!preview && writing && !!preview.liveWriterRunId;
  const canStart =
    !!preview &&
    !!request &&
    providerId !== null &&
    brief.trim().length > 0 &&
    !!preview.baseRef &&
    !blockedByWriter &&
    !starting;

  const start = async () => {
    if (!canStart || !preview || !request || providerId === null) return;
    setStarting(true);
    setError(null);
    try {
      const run = await dispatchRun({
        ticketId: preview.ticketId,
        intent: preview.intent,
        brief,
        mayChangeFiles: mayChangeFiles ?? request.mayChangeFiles ?? false,
        autoApprove: writing ? autoApprove : false,
        baseRef: preview.baseRef ?? '',
        ownerMemberId: CURRENT_USER_ID,
        providerId,
        copilotConversationId,
      });
      onClose();
      if (onStarted) onStarted(run);
      else navigate(`/sessions/${encodeURIComponent(run.id)}`);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The session could not be started.',
      );
      setStarting(false);
    }
  };

  const title = request
    ? `${INTENT_LABEL[request.intent]}${preview ? ` · ${preview.identifier}` : ''}`
    : 'Session';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={640}
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={starting}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              start().catch(() => {});
            }}
            disabled={!canStart}
            title="⌘⏎"
          >
            {starting ? 'Starting…' : 'Start session'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-brief-preview>
        {state.kind === 'loading' && (
          <p className="text-sm text-text-muted">Building the brief…</p>
        )}
        {state.kind === 'error' && (
          <p className="text-sm text-danger" role="alert">
            {state.message}
          </p>
        )}
        {preview && (
          <>
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="brief-preview-text"
                className="flex items-baseline justify-between text-xs font-medium text-text-secondary"
              >
                <span>The brief — what the session is told first</span>
                <span className="font-normal text-text-muted">
                  {preview.title}
                </span>
              </label>
              <textarea
                id="brief-preview-text"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    start().catch(() => {});
                  }
                }}
                disabled={starting}
                rows={14}
                spellCheck={false}
                className="thin-scroll resize-y rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
              />
              {preview.seededFromRunId && (
                <p className="text-xs text-text-muted" data-seeded>
                  Seeded with the approved root cause from the latest
                  Investigate.
                </p>
              )}
            </div>

            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-[var(--radius-sm)] border border-border bg-bg-inset p-3 text-xs">
              <dt className="text-text-muted">Folder</dt>
              <dd className="inline-flex min-w-0 items-center gap-1.5 text-text">
                <IconFolder size={11} className="shrink-0 text-text-muted" />
                <span className="truncate font-mono">
                  {preview.repo.displayPath}
                </span>
                {preview.repo.projectName && (
                  <span className="shrink-0 text-text-muted">
                    · {preview.repo.projectName}
                  </span>
                )}
              </dd>
              <dt className="text-text-muted">Worktree</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-text">
                <IconGitBranch size={11} className="shrink-0 text-text-muted" />
                <span className="font-mono">{preview.branchHint}</span>
                <span className="text-text-muted">from</span>
                <select
                  aria-label="Base branch"
                  value={preview.baseRef ?? ''}
                  onChange={(e) => setBaseRef(e.target.value)}
                  disabled={starting}
                  className={fieldClass}
                >
                  {preview.branches.branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </dd>
              <dt className="text-text-muted">Mode</dt>
              <dd
                className="flex items-center gap-2.5 text-text"
                data-mode={preview.mode}
              >
                {preview.intent === 'custom' && (
                  <Switch
                    id="brief-preview-may-change"
                    label="May change files"
                    checked={writing}
                    disabled={starting}
                    onChange={(next) => setMayChangeFiles(next)}
                  />
                )}
                {writing ? (
                  <span>
                    Writing session — the agent edits files on the branch and
                    commits; it cannot push.
                  </span>
                ) : (
                  <span>Plan — reads and reports, changes nothing.</span>
                )}
              </dd>
              {writing && (
                <>
                  <dt className="text-text-muted">Auto-approve</dt>
                  <dd className="flex items-center gap-2.5">
                    <Switch
                      id="brief-preview-auto-approve"
                      label="Auto-approve"
                      checked={autoApprove}
                      disabled={starting}
                      onChange={(next) => {
                        setAutoApprove(next);
                        autoApproveTouched.current = true;
                      }}
                    />
                    <label
                      htmlFor="brief-preview-auto-approve"
                      className={clsx(
                        autoApprove ? 'text-text' : 'text-text-secondary',
                      )}
                    >
                      {autoApprove
                        ? 'The agent works in its worktree without asking; credentials are kept from it.'
                        : 'The agent asks before each edit or command.'}
                    </label>
                  </dd>
                </>
              )}
            </dl>

            {blockedByWriter && (
              <p
                className="rounded-[var(--radius-sm)] border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning"
                data-live-writer
              >
                A writing session is already live on {preview.identifier}. One
                writer per ticket at a time —{' '}
                <button
                  type="button"
                  className="font-medium underline underline-offset-2"
                  onClick={() => {
                    onClose();
                    navigate(
                      `/sessions/${encodeURIComponent(preview.liveWriterRunId ?? '')}`,
                    );
                  }}
                >
                  open it
                </button>
                , or wait for it to finish.
              </p>
            )}
          </>
        )}
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
