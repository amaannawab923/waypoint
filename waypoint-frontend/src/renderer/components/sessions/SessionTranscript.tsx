import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { ChatView } from '@emdash/chat-ui';
import { ChatTranscript } from '@/components/chat/ChatTranscript';
import {
  cancelTurn,
  dropPendingPrompt,
  resolvePermission,
  retryPendingPrompt,
  sendPrompt,
  warmRun,
} from '@/data/engineApi';
import { refreshSessions, useSessionsSnapshot } from '@/lib/sessionsStore';
import { showErrorToast } from '@/lib/toast';
import type { AgentRun, PendingPrompt } from '@/types/agentRuns';
import { ImageViewer, type ViewerImage } from './ImageViewer';
import { collectTranscriptImages } from './transcriptImages';
import { PermissionBand } from './PermissionBand';
import { SessionComposer } from './SessionComposer';
import {
  intentView,
  pendingReasonSentence,
  runTitle,
  statusView,
  worktreeRecreatedNotice,
} from './sessionStatus';
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

/** The outbox strip's second line, per row state — never a nested ternary. */
function outboxRowSentence(
  row: PendingPrompt,
  run: Pick<AgentRun, 'cwd' | 'worktreePath'>,
): string {
  if (row.state === 'unresolved') {
    return 'Waypoint could not tell whether this reached the agent — check the transcript, then resend or discard it.';
  }
  if (row.state === 'sending') {
    // A host that restarted mid-turn leaves a row claimed this way
    // while the agent may still be working on it (never-lock,
    // outbox.ts's resolveStale) — not the row's own `reason`, which is
    // stale once it's gotten this far.
    return 'Checking whether this reached the agent…';
  }
  return pendingReasonSentence(row.reason, {
    cwd: run.cwd ?? run.worktreePath,
    lastError: row.lastError,
  });
}

/**
 * The outbox strip (never-lock, design §2.4): every message the person
 * sent that is not with the daemon yet — accepted, kept in the ledger,
 * and delivered when its reason clears — one row each, with the reason
 * and the two things a person can do about it. Sits above the composer
 * so the box is never the thing that says "not now".
 */
function OutboxStrip({
  rows,
  run,
  onRetry,
  onDrop,
  busy,
}: {
  rows: PendingPrompt[];
  run: AgentRun;
  onRetry: () => void;
  onDrop: (row: PendingPrompt) => void;
  busy: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div
      data-outbox-strip
      className="mx-4 mt-2 flex flex-col gap-1 rounded-[var(--radius-sm)] border border-border bg-bg-inset px-3 py-2 text-xs"
    >
      {rows.map((row, i) => (
        <div key={row.id} className="flex items-start gap-2" data-outbox-row>
          <div className="min-w-0 flex-1">
            <div className="truncate text-text" title={row.text}>
              {row.text}
            </div>
            <div className="text-text-muted">{outboxRowSentence(row, run)}</div>
          </div>
          {i === 0 && (
            <button
              type="button"
              onClick={onRetry}
              disabled={busy}
              className="shrink-0 font-medium text-text-secondary underline-offset-2 hover:text-text hover:underline disabled:opacity-50"
            >
              Resend
            </button>
          )}
          <button
            type="button"
            onClick={() => onDrop(row)}
            disabled={busy}
            className="shrink-0 font-medium text-text-muted underline-offset-2 hover:text-text hover:underline disabled:opacity-50"
          >
            Discard
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The Transcript tab (W3, ROAD-62/63): the vendored chat-ui view for the
 * run, fed by useSessionTranscript; the permission band, the outbox strip
 * and the composer portaled into chat-ui's own sticky composer slot so
 * the transcript's bottom padding follows their height (inline below
 * the body when there is no slot yet — the composer is mounted whatever
 * the run's state); and the usage strip.
 *
 * Never-lock (2026-09-20; emdash parity, see SessionComposer): the
 * composer is open for EVERY status. What a send does is main's answer
 * (sendPrompt.ts) — sent, queued for the next turn, continued from a
 * finished run, resumed first, or held in the run's outbox until the
 * obstacle clears — and this pane only reports it. Nothing here decides
 * from the status that a message cannot be sent.
 */
export function SessionTranscript({ run }: { run: AgentRun }) {
  // Set for the duration of a send: suppresses useSessionTranscript's own
  // teardown-and-rebuild for the provisioning a resume passes through
  // (below), so a message that just revived the run doesn't flash
  // "Starting the session…" over the reply that's about to arrive on the
  // very same conversation. Local, not derived from run.status.
  const [sendInFlight, setSendInFlight] = useState(false);
  const label = runTitle(run);
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
    pending,
    refreshPending,
  } = useSessionTranscript(run.id, {
    awaitingSession:
      (run.status === 'queued' || run.status === 'provisioning') &&
      !sendInFlight,
    // A dispatched run's first prompt is its brief: folded (W5a).
    foldBrief: run.entry === 'dispatched' ? { label } : null,
    markerLabel: label,
  });
  const briefLabel =
    run.entry === 'dispatched'
      ? `${label}${intentView(run)?.mode ? ` · ${intentView(run)?.mode}` : ''}`
      : null;
  const { engine } = useSessionsSnapshot();
  // The chat-ui view, remembered with the state it was built for: a
  // unit torn down (a start awaited) leaves a view whose slot is off the
  // document, and a portal into it would hide the composer — so the slot
  // only counts while its state is the current one.
  const [ready, setReady] = useState<{
    state: NonNullable<typeof state>;
    view: ChatView;
  } | null>(null);
  const composerSlot =
    state && ready?.state === state ? ready.view.composerSlot : null;
  // `dock`'s real, permanent home: one DOM node, created exactly once
  // for this component's lifetime and NEVER swapped — `createPortal`
  // below always targets this same reference, so React's own
  // reconciliation of `dock`'s subtree never sees a change at this
  // position and never has reason to remount it (found in review:
  // `composerSlot ? createPortal(dock, composerSlot) : dock` switched
  // between a bare child and a portal — a type change React can't
  // reconcile across — the instant chat-ui's slot showed up, usually a
  // beat after the first render, resetting `SessionComposer`'s focus
  // and in-progress text on essentially every session-tab open. A
  // *second* attempt — always calling `createPortal` but varying its
  // container argument — turned out to have the exact same problem:
  // verified live, in the test below, that a portal's own container
  // changing is enough to remount its children too). What moves instead
  // is this node's PARENT — a plain DOM `appendChild`, outside React
  // entirely, in the layout effect below.
  const dockHome = useRef<HTMLDivElement | null>(null);
  if (dockHome.current === null) {
    dockHome.current = document.createElement('div');
    dockHome.current.style.display = 'contents';
  }
  const localWrapper = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = composerSlot ?? localWrapper.current;
    const home = dockHome.current;
    if (target && home && home.parentElement !== target) {
      // The move itself is what a browser blurs an element for — the
      // node, its value and every hook's state survive intact, only
      // focus doesn't, so it comes right back before paint (a keystroke
      // is never lost either way; this just keeps the cursor from
      // visibly leaving the box for the one frame this takes).
      const focused =
        document.activeElement instanceof HTMLElement &&
        home.contains(document.activeElement)
          ? document.activeElement
          : null;
      target.appendChild(home);
      focused?.focus();
    }
  });
  const [answering, setAnswering] = useState<string | null>(null);
  const [outboxBusy, setOutboxBusy] = useState(false);
  const status = statusView(run.status);
  const engineDown = engine !== undefined && engine.kind !== 'running';

  // Start on open (never-lock, design §2.5; emdash's `start()` on tab
  // open): a run whose daemon session is gone is loaded again as soon as
  // the pane shows it, so the first message goes to a warm session
  // rather than waiting a cold spawn out. Daemon only — nothing about
  // the run changes for having been looked at. `warming` is only the
  // placeholder; a send during it goes to the outbox and is delivered
  // when the session is up.
  const [warming, setWarming] = useState(false);
  useEffect(() => {
    // Found in review: neither early return reset `warming` — a warm
    // cycle that was mid-flight when the run turned live/idle (a resume
    // landing right before the daemon reports `isGenerating`) could leave
    // the placeholder stuck on "Connecting…" for a session that was
    // actually already up.
    if (engineDown || status.live) {
      setWarming(false);
      return undefined;
    }
    if (run.status === 'queued' || run.status === 'provisioning') {
      setWarming(false);
      return undefined;
    }
    let gone = false;
    setWarming(true);
    const settle = () => {
      if (!gone) setWarming(false);
    };
    warmRun(run.id)
      .then(settle, settle)
      .catch(() => {});
    return () => {
      gone = true;
    };
    // `run.status` is a real dependency, not just `run.id`/`engineDown`
    // (found in review): a pane opened while `queued`/`provisioning`
    // used to warm nothing, ever, for that mount — the one invocation
    // this pair of deps got was spent on the early return above, and
    // nothing re-ran once the run actually reached a status worth
    // warming. Re-running per status change is cheap and safe: `warm.ts`
    // early-outs with no daemon call for every live status, and its own
    // `warmed` map plus already-live guard rule out a duplicate spawn.
  }, [run.id, engineDown, run.status, status.live]);

  // A run that ended without ever producing a turn (stopped while
  // provisioning, or one that never got anywhere) has nothing for
  // chat-ui's canvas to draw; the pane used to swap the whole canvas —
  // composer included — for "Nothing to show". Now it is a line above a
  // canvas that stays put, with the composer under it (ROAD-61 found the
  // blank pane; never-lock forbids the swap). `loading`/`failed` are
  // excluded so it never flashes over a fetch or a read error; live runs
  // and a turn in flight are excluded because they are not empty, only
  // early.
  const nothingYet =
    historyStatus.kind === 'ready' &&
    turnCount === 0 &&
    !hasActiveTurn &&
    pending.length === 0 &&
    !status.live &&
    run.status !== 'queued' &&
    run.status !== 'provisioning';

  // What a send will do right now — the placeholder says it, so a person
  // typing into a finished run is not surprised by what comes back.
  let placeholder: string | undefined;
  let sendingLabel = 'Sending…';
  if (isGenerating)
    placeholder = 'Add a follow-up…  (⌘↵ queues it for the next turn)';
  else if (run.status === 'queued' || run.status === 'provisioning')
    placeholder =
      'Starting the session… your message goes with it  (⌘↵ to send)';
  else if (run.status === 'finishing')
    placeholder = 'Filing the report… your message goes next  (⌘↵ to send)';
  else if (warming) placeholder = 'Connecting… you can type  (⌘↵ to send)';
  else if (!status.live) {
    placeholder = 'Message this session to continue it…  (⌘↵ to send)';
    sendingLabel = 'Resuming…';
  }

  // Awaited — safe only because main's `runs:send-prompt` handler goes
  // through daemonApi.ts's `sendPrompt` facade, which resolves at
  // hand-off (racing the daemon's own turn-end answer against a short
  // window), not at the agent's actual turn end. The prior non-await
  // here existed specifically because awaiting a RAW `acp.sendPrompt`
  // greyed the composer out for an entire turn — that regression would
  // come right back if this awaited anything without the same
  // hand-off-only contract.
  const onSend = async (text: string) => {
    const id = `pending-${Date.now()}`;
    state?.session.setPendingPrompt({ id, text });
    setSendInFlight(true);
    try {
      const result = await sendPrompt(run.id, text);
      switch (result.outcome) {
        case 'cancelled-mid-resume':
          // A Stop landed between the reopen and the session start: the
          // person overrode the send. Not an error — the text goes back.
          state?.session.setPendingPrompt(null);
          showErrorToast(
            'Stopped before your message reached the agent; it is back in the box.',
          );
          await refreshSessions();
          throw new Error('not sent');
        case 'outboxed':
          // Accepted, kept, delivered when the reason clears — the strip
          // above the composer shows it; the transcript's pending prompt
          // would claim the daemon has it, which it does not.
          state?.session.setPendingPrompt(null);
          break;
        case 'continued':
        case 'resumed-and-sent':
          // The daemon now has a session for this run again, but
          // `sendInFlight` (above) kept this unit's followers alive rather
          // than torn down, so they're still closed on the one that
          // ended — reconnect them now that it has actually landed.
          reconnect();
          break;
        default:
      }
      if (result.worktreeRecreated) {
        // Said before the conversation-restore note below when both
        // apply: files on disk are the bigger discontinuity.
        showErrorToast(worktreeRecreatedNotice(result.branchReused === true));
      }
      if (result.resume === 'replaced-by-new') {
        // The one toast channel there is; this is a warning in any case.
        showErrorToast(
          'The provider could not restore the previous conversation; your message went to a fresh session in the same worktree, with the branch state attached.',
        );
      }
      await Promise.all([refreshSessions(), refreshPending()]);
    } catch (error) {
      state?.session.setPendingPrompt(null);
      if (!(error instanceof Error && error.message === 'not sent')) {
        showErrorToast(
          error instanceof Error ? error.message : 'The prompt was not sent.',
        );
        await refreshSessions();
      }
      throw error;
    } finally {
      setSendInFlight(false);
    }
  };

  const onRetry = async () => {
    setOutboxBusy(true);
    setSendInFlight(true);
    try {
      const result = await retryPendingPrompt(run.id);
      if (
        result.outcome === 'continued' ||
        result.outcome === 'resumed-and-sent'
      )
        reconnect();
      if (result.outcome === 'outboxed' && result.pending) {
        showErrorToast(
          pendingReasonSentence(result.pending.reason, {
            cwd: run.cwd ?? run.worktreePath,
            lastError: result.pending.lastError,
          }),
        );
      }
      await Promise.all([refreshSessions(), refreshPending()]);
    } catch (error) {
      showErrorToast(
        error instanceof Error ? error.message : 'The message was not resent.',
      );
    } finally {
      setOutboxBusy(false);
      setSendInFlight(false);
    }
  };

  const onDrop = async (row: PendingPrompt) => {
    setOutboxBusy(true);
    try {
      await dropPendingPrompt(run.id, row.id);
      await refreshPending();
    } catch (error) {
      showErrorToast(
        error instanceof Error
          ? error.message
          : 'The message was not discarded.',
      );
    } finally {
      setOutboxBusy(false);
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

  // A screenshot the session took (chat-ui renders it under the tool row;
  // a click hands the image here): the viewer opens on it with every
  // other image in the transcript beside it, collected at click time —
  // the list is only needed while the viewer is open, and a run that is
  // still working may add more before the next click.
  const [viewing, setViewing] = useState<{
    images: ViewerImage[];
    initialId: string;
  } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

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
      onViewImage: ({
        attachment,
      }: {
        attachment: { id: string; name: string; dataUrl?: string };
      }) => {
        const transcript = stateRef.current?.transcript.state;
        const turns = transcript
          ? [
              ...transcript.committedTurns,
              ...(transcript.activeTurnSnapshot
                ? [transcript.activeTurnSnapshot]
                : []),
            ]
          : [];
        const images = collectTranscriptImages(turns);
        // The clicked image is always shown, even if the walk somehow
        // missed it (a shape this collector does not know yet).
        if (!images.some((i) => i.id === attachment.id) && attachment.dataUrl) {
          images.push({
            id: attachment.id,
            name: attachment.name,
            dataUrl: attachment.dataUrl,
          });
        }
        if (images.length) setViewing({ images, initialId: attachment.id });
      },
    }),
    [run.id],
  );

  let transcriptBody: ReactNode;
  if (state) {
    transcriptBody = (
      <ChatTranscript
        context={context}
        state={state}
        composer="slot"
        composerPlacement="bottom"
        // chat-ui's default content column is 42rem (672px): at a 1700px
        // window half the detail pane sat empty (Sessions UX walkthrough,
        // 2026-09-21, the founder's first caveat). 960px keeps prose lines
        // readable while using the pane; rows are measured against this
        // element's width, so the composer slot widens with it.
        contentClass="mx-auto w-full max-w-[960px] px-8"
        stickToBottom
        onReady={(view) => setReady({ state, view })}
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
      <OutboxStrip
        rows={pending}
        run={run}
        onRetry={() => {
          onRetry().catch(() => {});
        }}
        onDrop={(row) => {
          onDrop(row).catch(() => {});
        }}
        busy={outboxBusy}
      />
      <SessionComposer
        draftKey={run.id}
        onSend={onSend}
        sendBlockedReason={
          engineDown
            ? 'The agent engine is not running — your message is kept here until it is.'
            : null
        }
        attachedToBand={pendingPermissions.length > 0}
        autoFocus
        placeholder={placeholder}
        sendingLabel={sendingLabel}
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
      {nothingYet && (
        <div
          data-nothing-yet
          className="mx-4 mt-3 rounded-[var(--radius-sm)] border border-border bg-bg-inset px-3 py-2 text-xs text-text-secondary"
        >
          No activity in this session yet — {status.sentence}
        </div>
      )}
      <div className="min-h-0 flex-1">{transcriptBody}</div>
      <ImageViewer
        images={viewing?.images ?? []}
        initialId={viewing?.initialId ?? null}
        onClose={() => setViewing(null)}
      />
      {/* Where `dockHome` sits before the layout effect has anywhere
          better to put it (the very first paint) — the composer is
          mounted either way; see `dockHome`'s own comment above. */}
      <div ref={localWrapper} style={{ display: 'contents' }} />
      {createPortal(dock, dockHome.current)}
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
