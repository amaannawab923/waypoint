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

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (content: string) => void }) {
  const [value, setValue] = useState('');

  function submit() {
    const content = value.trim();
    if (!content || disabled) return;
    onSend(content);
    setValue('');
  }

  return (
    <div className="flex items-end gap-2 border-t border-border px-4 py-3">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder="Ask Copilot…"
        className="thin-scroll max-h-28 min-h-9 flex-1 resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <IconButton label="Send" onClick={submit} disabled={disabled || !value.trim()} className="mb-0.5 disabled:opacity-40">
        <Send size={16} />
      </IconButton>
    </div>
  );
}

/**
 * Persistent right-hand chat panel — conditionally mounted by AppShell.tsx
 * (only while `open`), so closing and reopening always re-fetches from
 * Postgres rather than trying to keep client state in sync between visits.
 * Deliberately has NO backdrop, unlike Modal.tsx/WorkItemDrawer.tsx's
 * portal convention this otherwise mirrors — the rest of the app stays
 * interactive while this is open, closing only via the topbar toggle or Esc.
 */
export function CopilotPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [visible, setVisible] = useState(false);
  const { data: conversation, loading, error, reload } = useAsync(() => getCopilotConversation(), []);
  // The POST endpoint only returns the new assistant reply, not the user's
  // own persisted message (see waypoint-backend's copilot.routes.ts) — so
  // there's nothing to splice into `conversation.messages` client-side that
  // wouldn't need a second round-trip to get a real id/seq anyway. Shown as
  // a transient, non-persisted bubble instead, cleared once the post-send
  // reload brings back the real (now-persisted) pair.
  const [pendingContent, setPendingContent] = useState<string | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // AppShell conditionally mounts this component only while `open`, so a
  // plain mount/unmount effect lines up exactly with open/close either way
  // (Escape or the topbar toggle) — no need for Modal.tsx's `[open]`-only
  // variant of this same fix, since that component stays mounted and toggles
  // its own visibility instead. Without this, closing via Escape dropped
  // focus to <body> with nothing to return it to the topbar toggle — the
  // same loss-of-place bug Modal.tsx already fixed once (see its
  // previousFocusRef comment) for keyboard and screen-reader users.
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
      await reload();
    } finally {
      setPendingContent(null);
    }
  }

  return createPortal(
    <div
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[400px] flex-col border-l border-border bg-surface shadow-2xl transition-transform duration-200 ease-out"
      style={{ transform: visible ? 'translateX(0)' : 'translateX(100%)' }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3.5">
        <h2 className="font-display text-sm font-medium text-text">Copilot</h2>
        <IconButton label="Close Copilot" onClick={onClose}>
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
      </div>

      <Composer disabled={!conversation || pendingContent !== null} onSend={handleSend} />
    </div>,
    document.body,
  );
}
