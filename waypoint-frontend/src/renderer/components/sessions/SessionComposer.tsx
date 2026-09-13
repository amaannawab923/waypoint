import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import { IconSend } from '@/components/icons';

/**
 * The message box under the transcript (W3, ROAD-62). Text only —
 * attachments are not in W3's allowlist. `⌘Enter` (or Ctrl+Enter) sends;
 * plain Enter is a newline, since a prompt to an agent is usually more
 * than one line. Disabled, with the sentence that says why, when the run
 * cannot take a prompt (ended, or the engine is down).
 */
export function SessionComposer({
  onSend,
  disabledReason,
  attachedToBand,
  autoFocus,
}: {
  onSend: (text: string) => Promise<void>;
  /** When set, the box is disabled and this is the placeholder. */
  disabledReason: string | null;
  /** A permission band sits directly above: square off the top corners. */
  attachedToBand: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && !disabledReason) ref.current?.focus();
  }, [autoFocus, disabledReason]);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabledReason) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText('');
    } catch {
      // onSend has already said why (a toast); the text stays for a retry.
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send().catch(() => {});
    }
  };

  return (
    <div
      data-session-composer
      className={clsx(
        'mx-4 mb-4 flex shrink-0 items-end gap-2 border border-border-strong bg-bg px-2.5 py-2',
        attachedToBand
          ? 'rounded-b-[var(--radius-sm)]'
          : 'mt-2 rounded-[var(--radius-sm)]',
      )}
    >
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={!!disabledReason || sending}
        placeholder={disabledReason ?? 'Message this session…  (⌘↵ to send)'}
        aria-label="Message this session"
        rows={Math.min(6, Math.max(1, text.split('\n').length))}
        className="thin-scroll min-h-[24px] flex-1 resize-none bg-transparent text-[12px] leading-5 text-text outline-none placeholder:text-text-muted disabled:cursor-not-allowed"
      />
      <button
        type="button"
        aria-label="Send"
        onClick={() => send().catch(() => {})}
        disabled={!!disabledReason || sending || !text.trim()}
        className="flex size-6 shrink-0 items-center justify-center rounded-[5px] bg-accent bg-[image:var(--accent-gradient)] text-on-accent disabled:opacity-40"
      >
        <IconSend size={12} />
      </button>
    </div>
  );
}
