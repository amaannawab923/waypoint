import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ChatView } from '@emdash/chat-ui';
import { ChatTranscript } from '@/components/chat/ChatTranscript';
import { IconMessage } from '@/components/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { cancelTurn, resolvePermission, sendPrompt } from '@/data/engineApi';
import { refreshSessions, useSessionsSnapshot } from '@/lib/sessionsStore';
import { showErrorToast } from '@/lib/toast';
import type { AgentRun, SendRunPromptResult } from '@/types/agentRuns';
import { PermissionBand } from './PermissionBand';
import { clearSessionDraft, SessionComposer } from './SessionComposer';
import { intentView, runTitle, statusView } from './sessionStatus';
import { UsageStrip } from './UsageStrip';
import { useSessionTranscript } from './useSessionTranscript';

/**
 * ROAD-XXX: the sentence a send that did NOT deliver the message gets —
 * worktree-gone/not-resumable/not-ready are all "nothing was sent",
 * distinguished only by why, and the composer keeps the typed text
 * regardless (SessionComposer's own catch, once onSend rethrows below).
 */
function messageForUndeliveredSend(
  result: SendRunPromptResult,
  run: AgentRun,
): string {
  if (result.outcome === 'worktree-gone') {
    return run.isolation === 'directory'
      ? "This run's folder is no longer on disk; there was nothing to resume, and your message was not sent."
      : "This run's worktree is no longer on disk; there was nothing to resume, and your message was not sent.";
  }
  if (result.outcome === 'not-ready') {
    return 'This session is still starting; try again once it is running.';
  }
  return `This run is ${result.status}; your message was not sent.`;
}

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
  // ROAD-XXX: set right before a message-triggered resume attempt and
  // cleared once it settles — suppresses useSessionTranscript's own
  // teardown-and-rebuild for exactly that transition (below), so a
  // message that just revived the run doesn't flash "Starting the
  // session…" over the reply that's about to arrive on the very same
  // conversation. Local, not derived from run.status: the button's own
  // resume (SessionDetail.tsx) is untouched by this and keeps its
  // existing teardown behavior.
  const [resuming, setResuming] = useState(false);
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
    reconnect,
    brief,
  } = useSessionTranscript(run.id, {
    awaitingSession:
      (run.status === 'queued' || run.status === 'provisioning') && !resuming,
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
  // nothing happened. Every `resumable` status (interrupted/failed/
  // cancelled, ROAD-XXX) is excluded too: none of them mean the session is
  // over for good any more — sending a message revives it — so "nothing
  // to show" would assert something none of them actually support; and
  // `queued`/`provisioning` are excluded directly (not just via
  // `awaitingSession` upstream) so a resume's one transitional render,
  // where `historyStatus`/`turnCount` are still the prior session's stale
  // values but `run.status` has already flipped, can't flash this over
  // the "Starting the session…" state that's about to replace it.
  const showEmptyTranscript =
    historyStatus.kind === 'ready' &&
    turnCount === 0 &&
    !hasActiveTurn &&
    !status.live &&
    !status.resumable &&
    run.status !== 'queued' &&
    run.status !== 'provisioning';

  // A draft outlives anything revivable (the run comes back), not a
  // genuine ending — ROAD-XXX widens "revivable" to failed/cancelled too,
  // so only done/needs-review (successful endings) still clear it.
  useEffect(() => {
    if (run.status === 'done' || run.status === 'needs-review') {
      clearSessionDraft(run.id);
    }
  }, [run.id, run.status]);

  // ROAD-XXX: a resumable run's cwd/worktree must still exist for a send
  // to have anywhere to revive into — a run that died before either was
  // ever recorded (queued straight to failed, say) has nothing to resume.
  const hasPlace = Boolean(run.cwd ?? run.worktreePath);
  const canResume = status.resumable && hasPlace;
  const canCompose = status.live || canResume;
  const engineDown = engine !== undefined && engine.kind !== 'running';
  let disabledReason: string | null = null;
  if (engineDown) disabledReason = 'The agent engine is not running.';
  else if (run.status === 'queued' || run.status === 'provisioning')
    disabledReason = 'The session is still starting.';
  else if (status.resumable && !hasPlace)
    disabledReason =
      run.isolation === 'directory'
        ? 'This run has no folder left to resume in.'
        : 'This run has no worktree left to resume on.';
  else if (!canCompose)
    disabledReason = `This session has ended (${status.label.toLowerCase()}).`;

  // ROAD-XXX: awaited now, unlike before — but only because main's own
  // `runs:send-prompt` handler goes through daemonApi.ts's `sendPrompt`
  // facade, which resolves at hand-off (racing the daemon's own turn-end
  // answer against a short window), not at the agent's actual turn end.
  // The prior non-await here existed specifically because awaiting a RAW
  // `acp.sendPrompt` greyed the composer out for an entire turn (found in
  // review) — that regression would come right back if this awaited
  // anything that didn't have the same hand-off-only contract.
  const onSend = async (text: string) => {
    if (!state) throw new Error('not connected yet');
    const id = `pending-${Date.now()}`;
    state.session.setPendingPrompt({ id, text });
    if (canResume) setResuming(true);
    try {
      const result = await sendPrompt(run.id, text);
      if (
        result.outcome === 'worktree-gone' ||
        result.outcome === 'not-resumable' ||
        result.outcome === 'not-ready'
      ) {
        state.session.setPendingPrompt(null);
        showErrorToast(messageForUndeliveredSend(result, run));
        await refreshSessions();
        // SessionComposer's own catch (below) keeps the typed text for a
        // retry rather than clearing it — the point of awaiting at all.
        throw new Error('not sent');
      }
      if (result.outcome === 'resumed-and-sent') {
        // The daemon now has a genuinely new session for this run, but
        // `resuming` (above) kept this unit's followers alive rather than
        // torn down, so they're still closed on the one that died —
        // reconnect them now that resume has actually landed. The only
        // other place this fires is `useSessionTranscript`'s own
        // `onEngineStatusChanged` handler, which covers an engine
        // restart, not a resume that leaves the engine's own status
        // untouched.
        reconnect();
      }
      if (result.resume === 'replaced-by-new') {
        // The one toast channel there is; this is a warning in any case,
        // matching SessionDetail.tsx's own resume button.
        showErrorToast(
          'The provider could not restore the previous conversation; your message was sent to a fresh session in the same worktree, with the branch state attached.',
        );
      }
      await refreshSessions();
    } catch (error) {
      state.session.setPendingPrompt(null);
      if (!(error instanceof Error && error.message === 'not sent')) {
        showErrorToast(
          error instanceof Error ? error.message : 'The prompt was not sent.',
        );
        await refreshSessions();
      }
      throw error;
    } finally {
      if (canResume) setResuming(false);
    }
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
        placeholder={
          canResume
            ? 'Sending will resume this session in the same worktree…'
            : undefined
        }
        sendingLabel={canResume ? 'Resuming…' : undefined}
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
