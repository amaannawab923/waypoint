import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import { IconSend } from '@/components/icons';

/**
 * The message box under the transcript (W3, ROAD-62). Text only —
 * attachments are not in W3's allowlist. `⌘Enter` (or Ctrl+Enter) sends;
 * plain Enter is a newline, since a prompt to an agent is usually more
 * than one line. Disabled, with the sentence that says why, when the run
 * cannot take a prompt (ended, or the engine is down).
 *
 * W4 (ROAD-68): the unsent text is a draft per run, kept on this device
 * (`localStorage`, `DRAFT_PREFIX + run id`) so switching runs — or
 * restarting Waypoint — does not lose it. Written after a short pause,
 * removed on send; a run's draft is also dropped when the run reaches a
 * status that cannot take a prompt (`clearSessionDraft`).
 */

export const DRAFT_PREFIX = 'waypoint:sessionDraft:';
/** Keystrokes are coalesced this long before the draft is written. */
export const DRAFT_WRITE_MS = 300;

export function readSessionDraft(key: string): string {
  try {
    return window.localStorage.getItem(DRAFT_PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

function writeSessionDraft(key: string, text: string): void {
  try {
    if (text.length === 0) window.localStorage.removeItem(DRAFT_PREFIX + key);
    else window.localStorage.setItem(DRAFT_PREFIX + key, text);
  } catch {
    // A device that refuses storage keeps the draft only in the box.
  }
}

export function clearSessionDraft(key: string): void {
  writeSessionDraft(key, '');
}

export function SessionComposer({
  draftKey,
  onSend,
  disabledReason,
  attachedToBand,
  autoFocus,
}: {
  /** The run id: what the draft is remembered under. Absent, nothing is remembered. */
  draftKey?: string;
  onSend: (text: string) => Promise<void>;
  /** When set, the box is disabled and this is the placeholder. */
  disabledReason: string | null;
  /** A permission band sits directly above: square off the top corners. */
  attachedToBand: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(() =>
    draftKey ? readSessionDraft(draftKey) : '',
  );
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    if (autoFocus && !disabledReason) ref.current?.focus();
  }, [autoFocus, disabledReason]);

  // The draft follows the text, a beat behind; unmounting flushes the
  // latest text so a switch away mid-word loses nothing. Two effects on
  // purpose: a cleanup keyed on `text` would run on every keystroke and
  // write the value from the render before (found writing the test: the
  // text sent a moment ago came back as the draft).
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    if (!draftKey) return undefined;
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(
      () => writeSessionDraft(draftKey, text),
      DRAFT_WRITE_MS,
    );
    return () => {
      if (writeTimer.current) clearTimeout(writeTimer.current);
    };
  }, [draftKey, text]);
  useEffect(() => {
    if (!draftKey) return undefined;
    return () => writeSessionDraft(draftKey, latest.current);
  }, [draftKey]);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabledReason) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText('');
      if (draftKey) clearSessionDraft(draftKey);
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
