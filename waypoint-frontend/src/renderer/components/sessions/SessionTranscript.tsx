import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatView } from '@emdash/chat-ui';
import { ChatTranscript } from '@/components/chat/ChatTranscript';
import { cancelTurn, resolvePermission, sendPrompt } from '@/data/engineApi';
import { refreshSessions, useSessionsSnapshot } from '@/lib/sessionsStore';
import { showErrorToast } from '@/lib/toast';
import type { AgentRun } from '@/types/agentRuns';
import { PermissionBand } from './PermissionBand';
import { SessionComposer } from './SessionComposer';
import { statusView } from './sessionStatus';
import { UsageStrip } from './UsageStrip';
import { useSessionTranscript } from './useSessionTranscript';

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
    pendingPermissions,
    usage,
    liveStatus,
    isGenerating,
    reloadHistory,
  } = useSessionTranscript(run.id);
  const { engine } = useSessionsSnapshot();
  const [view, setView] = useState<ChatView | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const status = statusView(run.status);

  const engineDown = engine !== undefined && engine.kind !== 'running';
  let disabledReason: string | null = null;
  if (engineDown) disabledReason = 'The agent engine is not running.';
  else if (!status.live)
    disabledReason = `This session has ended (${status.label.toLowerCase()}).`;

  const onSend = async (text: string) => {
    try {
      await sendPrompt(run.id, text);
      await refreshSessions();
    } catch (error) {
      showErrorToast(
        error instanceof Error ? error.message : 'The prompt was not sent.',
      );
      throw error;
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
      <div className="min-h-0 flex-1">
        {state ? (
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
        ) : (
          <div className="p-4 text-xs text-text-muted">Connecting…</div>
        )}
      </div>
      {view?.composerSlot ? createPortal(dock, view.composerSlot) : null}
      <UsageStrip
        turnCount={turnCount}
        usage={usage}
        live={liveStatus.kind}
        generating={isGenerating}
      />
    </div>
  );
}
