import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ChatView } from '@emdash/chat-ui';
import { ChatTranscript } from '@/components/chat/ChatTranscript';
import { IconMessage } from '@/components/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { cancelTurn, resolvePermission, sendPrompt } from '@/data/engineApi';
import { refreshSessions, useSessionsSnapshot } from '@/lib/sessionsStore';
import { showErrorToast } from '@/lib/toast';
import type { AgentRun } from '@/types/agentRuns';
import { PermissionBand } from './PermissionBand';
import { clearSessionDraft, SessionComposer } from './SessionComposer';
import { intentView, runTitle, statusView } from './sessionStatus';
import { UsageStrip } from './UsageStrip';
import { useSessionTranscript } from './useSessionTranscript';

/**
 * The Brief bar (W5a): a dispatched run's first prompt, folded out of
 * the transcript and kept here behind "View brief" — one line by
 * default, the full text (read-only, as the session was given it) on
 * demand. Nothing to edit after Start; the preview is where it was
 * edited.
 */
function BriefBar({ brief, label }: { brief: string; label: string }) {
  const [open, setOpen] = useState(false);
  const lines = brief.split('\n').length;
  return (
    <div
      className="mx-4 mt-3 rounded-[var(--radius-sm)] border border-border bg-bg-inset text-xs"
      data-brief-bar
      data-open={open ? 'true' : 'false'}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-medium text-text">Brief</span>
        <span className="min-w-0 flex-1 truncate text-text-muted">
          {label} · what the session was told first · {lines} lines
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="shrink-0 font-medium text-text-secondary underline-offset-2 hover:text-text hover:underline"
        >
          {open ? 'Hide brief' : 'View brief'}
        </button>
      </div>
      {open && (
        <pre className="thin-scroll max-h-[40vh] overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-text-secondary">
          {brief}
        </pre>
      )}
    </div>
  );
}

/**
 * The Transcript tab (W3, ROAD-62/63): the vendored chat-ui view for the
 * run, fed by useSessionTranscript; the permission band and the composer
 * portaled into chat-ui's own sticky composer slot so the transcript's
 * bottom padding follows their height; and the usage strip. What the
 * composer may do follows the ledger's status — a run that has ended has
 * no session to prompt — and the engine's.
 */
export function SessionTranscript({ run }: { run: AgentRun }) {
  const {
    context,
    state,
    historyStatus,
    turnCount,
    hasActiveTurn,
    pendingPermissions,
    usage,
    liveStatus,
    isGenerating,
    queuedCount,
    reloadHistory,
    brief,
  } = useSessionTranscript(run.id, {
    awaitingSession: run.status === 'queued' || run.status === 'provisioning',
    // A dispatched run's first prompt is its brief: folded (W5a).
    foldBrief: run.entry === 'dispatched' ? { label: runTitle(run) } : null,
  });
  const briefLabel =
    run.entry === 'dispatched'
      ? `${runTitle(run)}${intentView(run)?.mode ? ` · ${intentView(run)?.mode}` : ''}`
      : null;
  const { engine } = useSessionsSnapshot();
  const [view, setView] = useState<ChatView | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const status = statusView(run.status);

  // A run that ended without ever producing a turn (stopped while
  // provisioning, or a run that genuinely never got anywhere) reads history
  // fine — the history read is `ready`, just with nothing in it — and
  // chat-ui's own canvas has nothing to draw, so the pane was rendering
  // completely blank (found in PM review: "SESS-23 stop while
  // provisioning", ROAD-61). `loading` and `failed` are excluded so this
  // never flashes over a fetch in flight or a real read error; `live` runs
  // and a run with a turn still in flight (`hasActiveTurn`) are excluded so
  // a session that has simply not produced its first *committed* turn
  // yet — still watchable, still promptable, or stopped a moment before its
  // turn's commit landed — keeps its normal canvas instead of being told
  // nothing happened. `interrupted` is excluded too: unlike `done`/`failed`/
  // `cancelled` it does not mean the session ended — the daemon or the app
  // just isn't reachable right now (sessionStatus.ts) — so "nothing to
  // show" would assert something this status doesn't support; and `queued`/
  // `provisioning` are excluded directly (not just via `awaitingSession`
  // upstream) so a resume's one transitional render, where `historyStatus`/
  // `turnCount` are still the prior session's stale values but `run.status`
  // has already flipped, can't flash this over the "Starting the
  // session…" state that's about to replace it.
  const showEmptyTranscript =
    historyStatus.kind === 'ready' &&
    turnCount === 0 &&
    !hasActiveTurn &&
    !status.live &&
    run.status !== 'interrupted' &&
    run.status !== 'queued' &&
    run.status !== 'provisioning';

  // A draft outlives an interruption (the run comes back), not an ending.
  useEffect(() => {
    if (
      run.status === 'done' ||
      run.status === 'failed' ||
      run.status === 'cancelled'
    ) {
      clearSessionDraft(run.id);
    }
  }, [run.id, run.status]);

  const engineDown = engine !== undefined && engine.kind !== 'running';
  let disabledReason: string | null = null;
  if (engineDown) disabledReason = 'The agent engine is not running.';
  else if (!status.live)
    disabledReason = `This session has ended (${status.label.toLowerCase()}).`;

  // Fire and forget, the way emdash's own composer does: the daemon
  // answers acp.sendPrompt when the agent's TURN ends, which can be
  // minutes (found in review — awaiting it greyed the composer out for
  // the whole turn). The prompt shows at once as chat-ui's pending
  // prompt; the live activeTurn replaces it when the daemon starts the
  // turn, and a refusal takes it back with the daemon's sentence.
  const onSend = async (text: string) => {
    if (!state) return;
    const id = `pending-${Date.now()}`;
    state.session.setPendingPrompt({ id, text });
    sendPrompt(run.id, text)
      .then(() => refreshSessions())
      .catch((error: unknown) => {
        state.session.setPendingPrompt(null);
        showErrorToast(
          error instanceof Error ? error.message : 'The prompt was not sent.',
        );
      });
  };

  const onAnswer = async (requestId: string, optionId: string) => {
    setAnswering(requestId);
    try {
      await resolvePermission(run.id, requestId, optionId);
      await refreshSessions();
    } catch (error) {
      showErrorToast(
        error instanceof Error
          ? error.message
          : 'The permission was not answered.',
      );
    } finally {
      setAnswering(null);
    }
  };

  // One object per run, so ChatTranscript pushes it to the view once, not
  // on every render.
  const commands = useMemo(
    () => ({
      onStop: () => {
        cancelTurn(run.id).catch((error: unknown) =>
          showErrorToast(
            error instanceof Error
              ? error.message
              : 'The turn was not cancelled.',
          ),
        );
      },
    }),
    [run.id],
  );

  let transcriptBody: ReactNode;
  if (showEmptyTranscript) {
    transcriptBody = (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<IconMessage size={28} />}
          title="Nothing to show"
          description="This session ended before any activity — there's no transcript to show."
        />
      </div>
    );
  } else if (state) {
    transcriptBody = (
      <ChatTranscript
        context={context}
        state={state}
        composer="slot"
        composerPlacement="bottom"
        stickToBottom
        onReady={setView}
        commands={commands}
        className="h-full"
      />
    );
  } else {
    transcriptBody = (
      <div className="p-4 text-xs text-text-muted">
        {run.status === 'queued' || run.status === 'provisioning'
          ? 'Starting the session…'
          : 'Connecting…'}
      </div>
    );
  }

  const dock = (
    <>
      <PermissionBand
        requests={pendingPermissions}
        onAnswer={(requestId, optionId) => {
          onAnswer(requestId, optionId).catch(() => {});
        }}
        answering={answering}
      />
      <SessionComposer
        draftKey={run.id}
        onSend={onSend}
        disabledReason={disabledReason}
        attachedToBand={pendingPermissions.length > 0}
        autoFocus
      />
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {historyStatus.kind === 'failed' && (
        <div className="mx-4 mt-3 flex items-center gap-3 rounded-[var(--radius-sm)] border border-danger bg-danger-bg px-3 py-2 text-xs text-danger">
          <span className="min-w-0 flex-1 truncate">
            The transcript could not be read: {historyStatus.message}
          </span>
          <button
            type="button"
            onClick={() => reloadHistory().catch(() => {})}
            className="shrink-0 font-semibold underline-offset-2 hover:underline"
          >
            Try again
          </button>
        </div>
      )}
      {brief && briefLabel && <BriefBar brief={brief} label={briefLabel} />}
      {liveStatus.kind === 'closed' && !engineDown && status.live && (
        <div className="mx-4 mt-3 rounded-[var(--radius-sm)] border border-border bg-bg-inset px-3 py-2 text-xs text-text-secondary">
          Live updates stopped
          {liveStatus.reason.kind === 'error' ||
          liveStatus.reason.kind === 'topic-error'
            ? `: ${liveStatus.reason.message}`
            : '.'}{' '}
          The transcript shows what was last received.
        </div>
      )}
      <div className="min-h-0 flex-1">{transcriptBody}</div>
      {/* Gated on showEmptyTranscript directly, in render, rather than
          clearing `view` from an effect — an effect-based clear lands one
          commit after ChatTranscript has already unmounted (disposing this
          same view), so the portal would still fire once into a slot that
          no longer exists before the effect catches up. */}
      {!showEmptyTranscript && view?.composerSlot
        ? createPortal(dock, view.composerSlot)
        : null}
      <UsageStrip
        turnCount={turnCount}
        usage={usage}
        live={liveStatus.kind}
        generating={isGenerating}
        queued={queuedCount}
      />
    </div>
  );
}
