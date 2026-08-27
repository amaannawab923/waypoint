import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { X, Send } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import {
  getCopilotConversation,
  postCopilotUserMessage,
  postCopilotAssistantMessage,
} from '@/mock/api';
import { IconButton } from '@/components/ui/Button';
import type { CopilotMessage } from '@/types/entities';

function MessageBubble({
  message,
}: {
  message: Pick<CopilotMessage, 'role' | 'content'>;
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
 * (only while `copilotOpen`), so closing and reopening always re-fetches
 * from Postgres rather than trying to keep client state in sync between
 * visits. Deliberately has NO backdrop, unlike Modal.tsx/WorkItemDrawer.tsx's
 * portal convention this otherwise mirrors — the rest of the app stays
 * interactive while this is open. Positioned below the topbar (not
 * inset-y-0, which would run under it) so the topbar — including the
 * toggle that opened this panel — stays visible and clickable, not hidden
 * behind the panel's own z-index.
 */
export function CopilotPanel({ onClose }: { onClose: () => void }) {
  const [visible, setVisible] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const {
    data: conversation,
    loading,
    error,
    reload,
  } = useAsync(() => getCopilotConversation(), []);
  // The user's own message, shown immediately on send. Cleared only once a
  // reload genuinely lands with fresh data (see the effect below) — kept
  // visible through the whole round trip so there's never a gap where
  // neither the transient bubble nor the real persisted message is on
  // screen.
  const [pendingContent, setPendingContent] = useState<string | null>(null);
  // Progressive text from an in-flight Claude Code run (issue #7). null
  // means no run in progress; '' means a run just started with no tokens
  // yet.
  const [streamingText, setStreamingText] = useState<string | null>(null);
  // A completed reply that hasn't been confirmed persisted yet. Shown as a
  // real (non-streaming) bubble the instant the run finishes — the user
  // sees their answer immediately, independent of whether saving it to
  // Postgres has succeeded yet.
  const [awaitingPersist, setAwaitingPersist] = useState<{
    content: string;
    sessionId: string | null;
  } | null>(null);
  const [persistError, setPersistError] = useState(false);
  // A run that failed outright (Claude Code not installed, not logged in,
  // or some other failure) — distinct from a persist failure, since no
  // reply was ever generated to save. Kept so "Try again" can retry the
  // same prompt without re-sending (and duplicating) the user's message.
  const [runError, setRunError] = useState<{ message: string } | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const unsubscribeStreamRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

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

  async function persistReply(content: string, sessionId: string | null) {
    try {
      await postCopilotAssistantMessage(content, sessionId);
    } catch {
      // Nothing else to do here — awaitingPersist stays as-is so the reply
      // remains visible, and the inline "Couldn't save" retry re-calls this
      // exact function without re-running the LLM.
      setPersistError(true);
      return;
    }
    setPersistError(false);
    // reload() never rejects (see useAsync.ts) — the existing "Couldn't
    // refresh" banner (keyed off useAsync's own `error`) already covers a
    // reload that fails after this point.
    await reload();
  }

  async function runAndPersist(
    content: string,
    resumeSessionId: string | undefined,
  ) {
    setStreamingText('');
    setRunError(null);
    setLastFailedPrompt(null);

    await new Promise<void>((resolve) => {
      // Guarded explicitly, not left to reject the surrounding promise: a
      // throw here (e.g. the preload bridge itself failed to load, so
      // window.electron.copilot is missing) previously left streamingText
      // stuck at '' forever — nothing else in this function would ever
      // clear it, since only onChunk/onDone/onError do, and none of those
      // get a chance to run. Treated the same as a reported run failure.
      try {
        const unsubscribe = window.electron.copilot.runPrompt(
          { prompt: content, resumeSessionId },
          {
            onChunk: (text) => setStreamingText((prev) => (prev ?? '') + text),
            onDone: async ({ fullText, sessionId }) => {
              setStreamingText(null);
              setAwaitingPersist({ content: fullText, sessionId });
              await persistReply(fullText, sessionId);
              resolve();
            },
            onError: (err) => {
              setStreamingText(null);
              setRunError({ message: err.message });
              setLastFailedPrompt(content);
              resolve();
            },
          },
        );
        unsubscribeStreamRef.current = unsubscribe;
      } catch (err) {
        setStreamingText(null);
        setRunError({
          message: `Couldn't reach Copilot's runtime — ${err instanceof Error ? err.message : String(err)}`,
        });
        setLastFailedPrompt(content);
        resolve();
      }
    });
  }

  async function handleSend(content: string) {
    setPendingContent(content);
    try {
      await postCopilotUserMessage(content);
    } catch (err) {
      // Nothing was persisted — clear the transient bubble immediately and
      // rethrow so Composer's catch leaves the draft in place instead of
      // discarding it.
      setPendingContent(null);
      throw err;
    }
    // The user's message IS persisted at this point — everything from here
    // on (the model run, saving the reply) fails independently of it, so
    // this function does not rethrow past this point. Composer will clear
    // the draft either way; failures beyond here surface via runError /
    // persistError instead of Composer's "keep the draft" path, since
    // there's no draft left to protect.
    await runAndPersist(
      content,
      awaitingPersist?.sessionId ?? conversation?.claudeSessionId ?? undefined,
    );
  }

  // Clears the transient user bubble and any unpersisted reply once — and
  // only once — a fetch actually completes successfully with fresh data.
  // Deliberately keyed on `conversation` alone, not `[conversation, error]`
  // — a retry starting clears `error` to null immediately (before its
  // fetch has resolved), which would otherwise fire this early against
  // still-stale data.
  useEffect(() => {
    if (!error) {
      setPendingContent(null);
      setAwaitingPersist(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation]);

  const isEmpty =
    conversation &&
    conversation.messages.length === 0 &&
    !pendingContent &&
    streamingText === null &&
    !awaitingPersist;

  return createPortal(
    <div
      ref={panelRef}
      className="fixed top-12 right-0 bottom-0 z-40 flex w-full max-w-[400px] flex-col border-l border-border bg-surface shadow-2xl transition-transform duration-200 ease-out"
      style={{ transform: visible ? 'translateX(0)' : 'translateX(100%)' }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3.5">
        <h2 className="font-display text-sm font-medium text-text">Copilot</h2>
        <IconButton label="Close panel" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading && !conversation && (
          <p className="text-center text-sm text-text-muted">Loading…</p>
        )}
        {error && !conversation && (
          // httpClient.ts already toasts the same failure — this is for
          // whoever misses (or dismisses) the toast and is left looking at
          // the panel itself, which otherwise rendered nothing at all here
          // with no indication anything had gone wrong.
          <div className="mt-6 flex flex-col items-center gap-2 text-center">
            <p className="text-sm text-text-muted">
              Couldn&apos;t load Copilot.
            </p>
            <button
              type="button"
              onClick={() => reload()}
              className="text-sm font-medium text-accent-soft-text hover:underline"
            >
              Try again
            </button>
          </div>
        )}
        {isEmpty && (
          <p className="mt-6 text-center text-sm text-text-muted">
            Ask Copilot anything — it can help with your tickets.
          </p>
        )}
        <div className="flex flex-col gap-3">
          {conversation?.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {pendingContent && (
            <MessageBubble
              message={{ role: 'user', content: pendingContent }}
            />
          )}
          {streamingText !== null && (
            <MessageBubble
              message={{ role: 'assistant', content: streamingText || '…' }}
            />
          )}
          {awaitingPersist && (
            <MessageBubble
              message={{ role: 'assistant', content: awaitingPersist.content }}
            />
          )}
        </div>
        {error && conversation && (
          // A reload after a successful send (or any other refresh) failed
          // — the message the user just sent DID persist server-side, so
          // this must not read as "your message failed" (that's the
          // !conversation branch above). Inline and small, next to the
          // existing messages rather than replacing them.
          <div className="mt-3 flex flex-col items-center gap-1 text-center">
            <p className="text-xs text-text-muted">Couldn&apos;t refresh.</p>
            <button
              type="button"
              onClick={() => reload()}
              className="text-xs font-medium text-accent-soft-text hover:underline"
            >
              Try again
            </button>
          </div>
        )}
        {runError && lastFailedPrompt && (
          <div className="mt-3 flex flex-col items-center gap-1 text-center">
            <p className="text-xs text-text-muted">{runError.message}</p>
            <button
              type="button"
              onClick={() => {
                const prompt = lastFailedPrompt;
                runAndPersist(
                  prompt,
                  conversation?.claudeSessionId ?? undefined,
                );
              }}
              className="text-xs font-medium text-accent-soft-text hover:underline"
            >
              Try again
            </button>
          </div>
        )}
        {persistError && awaitingPersist && (
          <div className="mt-3 flex flex-col items-center gap-1 text-center">
            <p className="text-xs text-text-muted">
              Couldn&apos;t save this reply.
            </p>
            <button
              type="button"
              onClick={() => {
                const reply = awaitingPersist;
                persistReply(reply.content, reply.sessionId);
              }}
              className="text-xs font-medium text-accent-soft-text hover:underline"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      <Composer
        disabled={!conversation || awaitingPersist !== null}
        onSend={handleSend}
      />
    </div>,
    document.body,
  );
}
