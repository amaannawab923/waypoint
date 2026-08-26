import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { X, Send } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import { getCopilotConversation, sendCopilotMessage } from '@/mock/api';
import { IconButton } from '@/components/ui/Button';
import type { CopilotMessage } from '@/types/entities';

function MessageBubble({ message }: { message: Pick<CopilotMessage, 'role' | 'content'> }) {
  return (
    <div className={clsx('flex flex-col gap-1', message.role === 'user' ? 'items-end' : 'items-start')}>
      <div
        className={clsx(
          'max-w-[85%] rounded-[var(--radius)] px-3.5 py-2.5 text-sm leading-relaxed break-words',
          message.role === 'user' ? 'bg-accent text-on-accent' : 'border border-border bg-surface-2 text-text',
        )}
      >
        {message.content}
      </div>
    </div>
  );
}

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (content: string) => Promise<void> }) {
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
  const { data: conversation, loading, error, reload } = useAsync(() => getCopilotConversation(), []);
  // The POST endpoint only returns the new assistant reply, not the user's
  // own persisted message (see waypoint-backend's copilot.routes.ts) — so
  // there's nothing to splice into `conversation.messages` client-side that
  // wouldn't need a second round-trip to get a real id/seq anyway. Shown as
  // a transient, non-persisted bubble instead, kept visible through the
  // post-send reload (not cleared until it settles) so there's no gap
  // where neither the transient bubble nor the real persisted message is
  // on screen — that gap is real on a slow connection, not just in theory.
  const [pendingContent, setPendingContent] = useState<string | null>(null);

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
      if (panelRef.current && !panelRef.current.contains(document.activeElement)) return;
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

  async function handleSend(content: string) {
    setPendingContent(content);
    try {
      await sendCopilotMessage(content);
    } catch (err) {
      // Nothing was persisted — clear the transient bubble immediately and
      // rethrow so Composer's catch leaves the draft in place instead of
      // discarding it.
      setPendingContent(null);
      throw err;
    }
    // reload() never rejects (see useAsync.ts), so this function has no
    // reliable way to tell success from failure after the fact — awaiting
    // it here is only to keep the transient bubble visible for the
    // duration, not to branch on the outcome. Clearing pendingContent
    // itself is handled by the effect below, keyed off `conversation`
    // actually receiving fresh data, not off this function returning.
    await reload();
  }

  // Clears the transient "sending" bubble once — and only once — a fetch
  // actually completes successfully with fresh data. Deliberately not done
  // inline in handleSend: reload() never rejects, so there's no reliable
  // success/failure signal to branch on right after awaiting it there. Also
  // deliberately keyed on `conversation` alone, not `[conversation, error]`
  // — a retry starting clears `error` to null immediately (before its
  // fetch has resolved), which would otherwise fire this early against
  // still-stale data. Keying on `conversation`'s reference means this only
  // fires when a fetch actually finished successfully (the only path that
  // calls setData), so the persisted message either shows for real or the
  // transient bubble stays up next to the "Couldn't refresh" retry.
  useEffect(() => {
    if (pendingContent && !error) setPendingContent(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation]);

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
        {loading && !conversation && <p className="text-center text-sm text-text-muted">Loading…</p>}
        {error && !conversation && (
          // httpClient.ts already toasts the same failure — this is for
          // whoever misses (or dismisses) the toast and is left looking at
          // the panel itself, which otherwise rendered nothing at all here
          // with no indication anything had gone wrong.
          <div className="mt-6 flex flex-col items-center gap-2 text-center">
            <p className="text-sm text-text-muted">Couldn't load Copilot.</p>
            <button
              type="button"
              onClick={() => reload()}
              className="text-sm font-medium text-accent-soft-text hover:underline"
            >
              Try again
            </button>
          </div>
        )}
        {conversation && conversation.messages.length === 0 && !pendingContent && (
          <p className="mt-6 text-center text-sm text-text-muted">
            Ask Copilot anything — it can help with your tickets.
          </p>
        )}
        <div className="flex flex-col gap-3">
          {conversation?.messages.map((message) => <MessageBubble key={message.id} message={message} />)}
          {pendingContent && <MessageBubble message={{ role: 'user', content: pendingContent }} />}
        </div>
        {error && conversation && (
          // A reload after a successful send (or any other refresh) failed
          // — the message the user just sent DID persist server-side, so
          // this must not read as "your message failed" (that's the
          // !conversation branch above). Inline and small, next to the
          // existing messages rather than replacing them.
          <div className="mt-3 flex flex-col items-center gap-1 text-center">
            <p className="text-xs text-text-muted">Couldn't refresh.</p>
            <button
              type="button"
              onClick={() => reload()}
              className="text-xs font-medium text-accent-soft-text hover:underline"
            >
              Try again
            </button>
          </div>
        )}
      </div>

      <Composer disabled={!conversation} onSend={handleSend} />
    </div>,
    document.body,
  );
}
