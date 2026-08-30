import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { ArrowLeft, Plus, Send, X } from 'lucide-react';
import {
  useCopilotSessions,
  type CopilotSessionMessageRole,
} from '@/lib/copilotSessions';
import { IconButton } from '@/components/ui/Button';
import { CopilotSessionList } from './CopilotSessionList';

function MessageBubble({
  message,
}: {
  message: { role: CopilotSessionMessageRole; content: string };
}) {
  return (
    <div
      className={clsx(
        'flex flex-col gap-1',
        message.role === 'user' ? 'items-end' : 'items-start',
      )}
    >
      <div
        className={clsx(
          'max-w-[85%] rounded-[var(--radius)] px-3.5 py-2.5 text-sm leading-relaxed break-words',
          message.role === 'user'
            ? 'bg-accent text-on-accent'
            : 'border border-border bg-surface-2 text-text',
        )}
      >
        {message.content}
      </div>
    </div>
  );
}

function Composer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (content: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);

  async function submit() {
    const content = value.trim();
    if (!content || disabled || sending) return;
    setSending(true);
    try {
      await onSend(content);
      setValue('');
    } catch {
      // A rejected send (network error, validation) already surfaces via
      // httpClient.ts's toast — the important thing here is what NOT to
      // do: don't clear the draft. It previously cleared unconditionally
      // before knowing whether the send even succeeded, silently
      // discarding what the user typed on any failure.
    } finally {
      setSending(false);
    }
  }

  const composerDisabled = disabled || sending;

  return (
    <div className="flex items-end gap-2 border-t border-border px-4 py-3">
      <textarea
        value={value}
        disabled={composerDisabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder="Ask Copilot…"
        className="thin-scroll max-h-28 min-h-9 flex-1 resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
      />
      <IconButton
        label="Send"
        onClick={submit}
        disabled={composerDisabled || !value.trim()}
        className="mb-0.5 disabled:opacity-40"
      >
        <Send size={16} />
      </IconButton>
    </div>
  );
}

/**
 * Persistent right-hand chat panel — conditionally mounted by AppShell.tsx
 * (only while `copilotOpen`), with NO backdrop, unlike Modal.tsx/
 * WorkItemDrawer.tsx's portal convention this otherwise mirrors — the rest
 * of the app stays interactive while this is open. Positioned below the
 * topbar (not inset-y-0, which would run under it) so the topbar —
 * including the toggle that opened this panel — stays visible and
 * clickable, not hidden behind the panel's own z-index.
 *
 * Holds two views in one panel (issue #11): a session list and a chat, both
 * ~400px wide, swapped in place rather than via a separate sidebar or route
 * — see CopilotSessionList.tsx for the list. Session data now lives in
 * localStorage via lib/copilotSessions.ts, not the backend's single-
 * conversation `copilot/conversation` endpoints (mock/api.ts's
 * getCopilotConversation/postCopilotUserMessage/postCopilotAssistantMessage)
 * — the backend's `copilot_conversations` table still has a unique
 * constraint on `memberId` and structurally cannot hold more than one
 * conversation per user yet. Those endpoints are left untouched, unused by
 * this component, for a later backend-backed migration. The real
 * `window.electron.copilot.runPrompt` streaming flow (issue #7) is
 * unchanged — only where its result gets persisted has moved.
 */
export function CopilotPanel({ onClose }: { onClose: () => void }) {
  const [visible, setVisible] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const sessionStore = useCopilotSessions();
  const { sessions } = sessionStore;

  // null = session-list view. Always starts on the list on open — this
  // panel is conditionally (un)mounted by AppShell, so "closing and
  // reopening" always lands back on the list rather than trying to restore
  // whatever chat happened to be open last time.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSession = activeSessionId
    ? (sessions.find((s) => s.id === activeSessionId) ?? null)
    : null;

  // A run's progressive text and any run-level error, each tagged with the
  // session they belong to — not just component-level state — so that
  // navigating back to the list mid-run (and possibly into a *different*
  // chat) can never show one session's in-flight reply under another's
  // header. null `streaming` means no run in progress; '' text means a run
  // just started with no tokens yet.
  const [streaming, setStreaming] = useState<{
    sessionId: string;
    text: string;
  } | null>(null);
  const [runError, setRunError] = useState<{
    sessionId: string;
    message: string;
  } | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const unsubscribeStreamRef = useRef<(() => void) | null>(null);
  // Bumped, per session, at the start of every runAndPersist call for that
  // session; each call's onChunk/onDone/onError closures capture the value
  // current at their own start and compare against the ref before touching
  // any state. A run's own process can outlive the run logically
  // "finishing" on this side (e.g. an auth_error is reported immediately
  // while the CLI is still mid-retry internally, or the user hits "Try
  // again" on a run that never actually exited) — without this guard, a
  // late chunk from that stale run would land in the same `streaming` state
  // a newer run is now writing to, interleaving two replies into one
  // bubble.
  //
  // Keyed by sessionId, not a single shared counter: multi-session means a
  // user can plausibly start a run in session A, switch away, and start a
  // second run in session B while A's is still in flight — a single global
  // counter would mark A's own, still-legitimate run stale the moment B's
  // starts, silently discarding A's real reply (and the subscription usage
  // spent generating it) with no error, no retry, nothing. Each session
  // tracks its own generation so concurrent runs across different sessions
  // can complete independently, while a superseded run *within the same*
  // session is still correctly ignored.
  const runGenerationRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // If the active session ever disappears from under the chat view (e.g.
  // localStorage was cleared in another tab/window), fall back to the list
  // instead of rendering a chat header/composer for a session that no
  // longer exists.
  useEffect(() => {
    if (activeSessionId && !sessions.some((s) => s.id === activeSessionId)) {
      setActiveSessionId(null);
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Only close (and only let the focus-restore effect below fire) if
      // focus is actually inside this panel. Without this check, Escape
      // fired regardless of what had focus — keydown bubbles to `document`
      // no matter where the user's actual focus is — so pressing Escape
      // while typing in, say, the global search input closed Copilot AND
      // yanked focus away from that unrelated input to restore it to the
      // topbar toggle instead.
      if (
        panelRef.current &&
        !panelRef.current.contains(document.activeElement)
      )
        return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // AppShell conditionally mounts this component only while open, so a
  // plain mount/unmount effect lines up exactly with open/close either way
  // (Escape or the topbar toggle) — no need for Modal.tsx's `[open]`-only
  // variant of this same fix, since that component stays mounted and
  // toggles its own visibility instead. Without this, closing via Escape
  // dropped focus to <body> with nothing to return it to the topbar
  // toggle — the same loss-of-place bug Modal.tsx already fixed once (see
  // its previousFocusRef comment) for keyboard and screen-reader users.
  // Safe to always restore here (no "was focus inside the panel" guard
  // needed on this side) because the Escape listener above already
  // guarantees Escape-triggered closes only happen when focus was inside;
  // the other close paths (the panel's own × button, the topbar toggle)
  // are direct clicks, which already leave focus exactly where restoring
  // would put it anyway.
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, []);

  // Unsubscribes from any in-flight run's IPC listener on unmount, but does
  // NOT cancel the main-process subprocess itself — the run is left to
  // finish and its result is simply dropped if the panel is gone. Killing
  // it would waste a turn Claude Code already spent tokens on, and would
  // orphan Claude Code's own --resume state for no benefit.
  useEffect(() => {
    return () => {
      unsubscribeStreamRef.current?.();
    };
  }, []);

  async function runAndPersist(
    sessionId: string,
    content: string,
    resumeSessionId: string | undefined,
  ) {
    const generation = (runGenerationRef.current.get(sessionId) ?? 0) + 1;
    runGenerationRef.current.set(sessionId, generation);
    const isStale = () =>
      runGenerationRef.current.get(sessionId) !== generation;

    setStreaming({ sessionId, text: '' });
    setRunError(null);
    setLastFailedPrompt(null);

    await new Promise<void>((resolve) => {
      // Guarded explicitly, not left to throw past this function: a throw
      // here (e.g. the preload bridge itself failed to load, so
      // window.electron.copilot is missing) previously left the streaming
      // bubble stuck forever — nothing else in this function would ever
      // clear it, since only onChunk/onDone/onError do, and none of those
      // get a chance to run. Treated the same as a reported run failure.
      try {
        const unsubscribe = window.electron.copilot.runPrompt(
          { prompt: content, resumeSessionId },
          {
            onChunk: (text) => {
              if (isStale()) return;
              setStreaming((prev) =>
                prev && prev.sessionId === sessionId
                  ? { sessionId, text: prev.text + text }
                  : prev,
              );
            },
            onDone: ({ fullText, sessionId: claudeSessionId }) => {
              if (isStale()) return;
              setStreaming(null);
              // An empty (or whitespace-only) reply isn't a real answer to
              // keep — persisting it would leave a session with a blank
              // assistant bubble and nothing to retry but re-running the
              // whole prompt. "Try again" re-runs the prompt from scratch.
              if (!fullText.trim()) {
                setRunError({
                  sessionId,
                  message: "Copilot didn't return a reply — try again.",
                });
                setLastFailedPrompt(content);
                resolve();
                return;
              }
              sessionStore.appendMessage(sessionId, {
                role: 'assistant',
                content: fullText,
              });
              if (claudeSessionId)
                sessionStore.setClaudeSessionId(sessionId, claudeSessionId);
              resolve();
            },
            onError: (err) => {
              if (isStale()) return;
              setStreaming(null);
              setRunError({ sessionId, message: err.message });
              setLastFailedPrompt(content);
              resolve();
            },
          },
        );
        unsubscribeStreamRef.current = unsubscribe;
      } catch (err) {
        setStreaming(null);
        setRunError({
          sessionId,
          message: `Couldn't reach Copilot's runtime — ${err instanceof Error ? err.message : String(err)}`,
        });
        setLastFailedPrompt(content);
        resolve();
      }
    });
  }

  async function handleSend(content: string) {
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    const resumeSessionId = activeSession?.claudeSessionId ?? undefined;
    // Synchronous, local — the message is in `sessions` (and localStorage)
    // before this call returns, so unlike the old backend-backed flow there
    // is no separate "transient bubble while the POST is in flight" state
    // to manage here.
    sessionStore.appendMessage(sessionId, { role: 'user', content });
    await runAndPersist(sessionId, content, resumeSessionId);
  }

  function handleCreateSession() {
    const created = sessionStore.createSession();
    setActiveSessionId(created.id);
  }

  function retryRun() {
    if (!runError || !lastFailedPrompt) return;
    const { sessionId } = runError;
    const resumeSessionId =
      sessions.find((s) => s.id === sessionId)?.claudeSessionId ?? undefined;
    runAndPersist(sessionId, lastFailedPrompt, resumeSessionId);
  }

  const isStreamingHere =
    streaming !== null && streaming.sessionId === activeSessionId;
  const runErrorHere =
    runError && runError.sessionId === activeSessionId ? runError : null;
  const isEmpty =
    !!activeSession && activeSession.messages.length === 0 && !isStreamingHere;

  return createPortal(
    <div
      ref={panelRef}
      className="fixed top-12 right-0 bottom-0 z-40 flex w-full max-w-[400px] flex-col border-l border-border bg-surface shadow-2xl transition-transform duration-200 ease-out"
      style={{ transform: visible ? 'translateX(0)' : 'translateX(100%)' }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-1">
          {activeSession && (
            <IconButton
              label="Back to sessions"
              onClick={() => setActiveSessionId(null)}
              className="-ml-1.5 shrink-0"
            >
              <ArrowLeft size={16} />
            </IconButton>
          )}
          <h2 className="truncate font-display text-sm font-medium text-text">
            {activeSession ? activeSession.title : 'Copilot'}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!activeSession && (
            <IconButton label="New session" onClick={handleCreateSession}>
              <Plus size={16} />
            </IconButton>
          )}
          <IconButton label="Close panel" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </div>

      {!activeSession && (
        <CopilotSessionList
          sessions={sessions}
          onOpen={setActiveSessionId}
          onCreate={handleCreateSession}
          onRename={sessionStore.renameSession}
          onTogglePin={sessionStore.togglePinSession}
          onDelete={sessionStore.deleteSession}
          onReorder={sessionStore.reorderSessionsWithinGroup}
        />
      )}

      {activeSession && (
        <>
          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {isEmpty && (
              <p className="mt-6 text-center text-sm text-text-muted">
                Ask Copilot anything — it can help with your tickets.
              </p>
            )}
            <div className="flex flex-col gap-3">
              {activeSession.messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
              {isStreamingHere && (
                <MessageBubble
                  message={{
                    role: 'assistant',
                    content: streaming?.text || '…',
                  }}
                />
              )}
            </div>
            {runErrorHere && lastFailedPrompt && (
              <div className="mt-3 flex flex-col items-center gap-1 text-center">
                <p className="text-xs text-text-muted">
                  {runErrorHere.message}
                </p>
                <button
                  type="button"
                  onClick={retryRun}
                  className="text-xs font-medium text-accent-soft-text hover:underline"
                >
                  Try again
                </button>
              </div>
            )}
          </div>

          <Composer disabled={isStreamingHere} onSend={handleSend} />
        </>
      )}
    </div>,
    document.body,
  );
}
