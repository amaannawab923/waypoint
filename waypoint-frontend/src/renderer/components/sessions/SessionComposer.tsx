import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import type { SessionConfigState } from '@emdash/core/runtimes/acp/api/client' with {
  'resolution-mode': 'import',
};
import { IconChevron, IconReturn, IconStop } from '@/components/icons';

/**
 * The message box under the transcript (W3, ROAD-62). Text only —
 * attachments are not in W3's allowlist. Enter sends; Shift+Enter is a
 * newline (⌘/Ctrl+Enter still send, for hands used to that). It was the
 * other way round until 2026-09-21 — the founder kept pressing Enter and
 * nothing happened, which is how every chat box people already know
 * behaves. An IME composition's Enter (picking a candidate) is left to
 * the IME.
 *
 * Never-lock (2026-09-20; emdash parity): the box is NEVER disabled. A
 * person can always type into a run — done, needs-review, failed,
 * cancelled, interrupted, provisioning, engine down — and the draft is
 * kept. Only the Send button is held back, and only while the engine is
 * not running (`sendBlockedReason`, said in the placeholder) or a send
 * is in flight (a moment: main answers at hand-off, not at turn end).
 * Where the message goes is main's business (sendPrompt.ts): straight to
 * the session, queued for the next turn, a resume first, or the run's
 * outbox until the obstacle clears — every send lands somewhere.
 *
 * Under the box (2026-09-21, founder): the session's own selectors —
 * mode (its permission policy: auto-approve or ask), model, and effort
 * when the provider offers one — read from the daemon's `config` state
 * and written back with acp.setModeOption / acp.setModelOption; and the
 * send button becomes Stop (a square in a spinning ring) while the agent
 * is generating, cancelling the turn. A provider that advertises no
 * option shows no selector.
 *
 * W4 (ROAD-68): the unsent text is a draft per run, kept on this device
 * (`localStorage`, `DRAFT_PREFIX + run id`) so switching runs — or
 * restarting Waypoint — does not lose it. Written after a short pause,
 * removed on send. Never cleared by a status change: a draft outlives
 * every status, since every status can be messaged.
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

/**
 * A send that failed after its composer was gone hands the text back
 * here (round 4 and 5 of review): to the draft in storage, for the next
 * composer to mount for this run — and to any composer ALREADY mounted
 * for it, which would otherwise never learn of it and, on its next
 * debounced write, overwrite the draft with its own text. One or the
 * other always exists; a message a person typed is never simply gone.
 */
const recoveries = new Map<string, Set<(text: string) => void>>();

function onDraftRecovered(key: string, listener: (text: string) => void) {
  const set = recoveries.get(key) ?? new Set();
  set.add(listener);
  recoveries.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) recoveries.delete(key);
  };
}

function recoverDraft(key: string, text: string): void {
  const mounted = recoveries.get(key);
  if (mounted && mounted.size > 0) {
    mounted.forEach((listener) => listener(text));
    return;
  }
  const stored = readSessionDraft(key);
  writeSessionDraft(key, stored.trim() ? `${text}\n${stored}` : text);
}

export function SessionComposer({
  draftKey,
  onSend,
  sendBlockedReason,
  attachedToBand,
  autoFocus,
  placeholder,
  sendingLabel,
  generating = false,
  onStop,
  config = null,
  onSetMode,
  onSetModel,
  onSetEffort,
}: {
  /** The run id: what the draft is remembered under. Absent, nothing is remembered. */
  draftKey?: string;
  onSend: (text: string) => Promise<void>;
  /**
   * When set, Send is held back and this is the placeholder — the ONE
   * reason there is: the engine is not running. The box itself still
   * takes text (never-lock).
   */
  sendBlockedReason: string | null;
  /** A permission band sits directly above: square off the top corners. */
  attachedToBand: boolean;
  autoFocus?: boolean;
  /** Overrides the default placeholder — what a send will do for this run right now. */
  placeholder?: string;
  /** The placeholder while a send is in flight ("Sending…", "Resuming…"). */
  sendingLabel?: string;
  /** The agent is mid-turn: the send button is a Stop. */
  generating?: boolean;
  /** Cancels the current turn (the Stop button). */
  onStop?: () => void;
  /** The session's mode / model / effort options; null before the first snapshot. */
  config?: SessionConfigState | null;
  onSetMode?: (modeId: string) => void;
  onSetModel?: (modelId: string) => void;
  onSetEffort?: (effortId: string) => void;
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
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

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
  // The recovered text of a send that failed — ours, or an earlier
  // instance's for the same run — goes ahead of whatever is typed since,
  // and the draft effect above then writes the merged text.
  useEffect(() => {
    if (!draftKey) return undefined;
    return onDraftRecovered(draftKey, (recovered) =>
      setText((current) =>
        current.trim() ? `${recovered}\n${current}` : recovered,
      ),
    );
  }, [draftKey]);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || sendBlockedReason) return;
    setSending(true);
    // The box empties at once — the message is on its way (the transcript
    // shows it pending), and the next one can be typed while a resume
    // takes its time. A send that did not land puts the text back.
    setText('');
    if (draftKey) clearSessionDraft(draftKey);
    try {
      await onSend(trimmed);
    } catch {
      // onSend has already said why (a toast); the text comes back. This
      // composer is mounted per run, so a person who switched runs while
      // the send was in flight has already unmounted it (found in review,
      // round 4) — and may have come back to a fresh one since (round 5).
      // `recoverDraft` reaches whichever exists: this instance if still
      // mounted, a newer one for the same run, or the draft in storage.
      if (draftKey) recoverDraft(draftKey, trimmed);
      else {
        setText((current) =>
          current.trim() ? `${trimmed}\n${current}` : trimmed,
        );
      }
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send().catch(() => {});
  };

  const selectors: Array<{
    key: 'mode' | 'model' | 'effort';
    label: string;
    selected: string | null;
    available: ReadonlyArray<{ id: string; name: string }>;
    onChange: ((id: string) => void) | undefined;
  }> = [];
  if (config?.modeOptions && config.modeOptions.available.length > 0) {
    selectors.push({
      key: 'mode',
      label: 'Mode',
      selected: config.modeOptions.selected,
      available: config.modeOptions.available,
      onChange: onSetMode,
    });
  }
  if (config?.modelOptions && config.modelOptions.available.length > 0) {
    selectors.push({
      key: 'model',
      label: 'Model',
      selected: config.modelOptions.selected,
      available: config.modelOptions.available,
      onChange: onSetModel,
    });
  }
  if (config?.efforts && config.efforts.available.length > 0) {
    selectors.push({
      key: 'effort',
      label: 'Effort',
      selected: config.efforts.selected,
      available: config.efforts.available,
      onChange: onSetEffort,
    });
  }

  return (
    <div
      data-session-composer
      className={clsx(
        'mx-4 mb-4 flex shrink-0 flex-col gap-1.5 border border-border-strong bg-bg px-2.5 pb-2 pt-2',
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
        placeholder={
          sendBlockedReason ??
          (sending ? sendingLabel : undefined) ??
          placeholder ??
          'Message this session…  (↵ to send, ⇧↵ for a new line)'
        }
        aria-label="Message this session"
        rows={Math.min(6, Math.max(1, text.split('\n').length))}
        className="thin-scroll min-h-[24px] w-full resize-none bg-transparent text-[12px] leading-5 text-text outline-none placeholder:text-text-muted"
      />
      <div className="flex items-center gap-1.5">
        {selectors.map((sel) => (
          <label
            key={sel.key}
            data-composer-selector={sel.key}
            className="relative inline-flex h-6 items-center gap-1 rounded-[5px] border border-border bg-bg-inset pl-2 pr-6 text-[11px] text-text-secondary hover:border-border-strong hover:text-text focus-within:border-border-strong"
          >
            <span className="text-text-muted">{sel.label}</span>
            <select
              aria-label={sel.label}
              value={sel.selected ?? ''}
              onChange={(e) => sel.onChange?.(e.target.value)}
              disabled={!sel.onChange}
              className="appearance-none bg-transparent pr-1 text-[11px] text-text outline-none"
            >
              {sel.selected === null && <option value="">—</option>}
              {sel.available.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
            <IconChevron
              size={12}
              className="pointer-events-none absolute right-1.5 text-text-muted"
            />
          </label>
        ))}
        <span className="flex-1" />
        {generating ? (
          <button
            type="button"
            aria-label="Stop"
            title="Stop the agent's current turn"
            onClick={() => onStop?.()}
            disabled={!onStop}
            className="relative flex size-6 shrink-0 items-center justify-center rounded-full text-text disabled:opacity-40"
          >
            {/* The ring: a track plus one lit arc that circles while the
                agent works — the classic "busy" around a stop square. */}
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-full border-[1.5px] border-border-strong"
            />
            <span
              aria-hidden="true"
              className="absolute inset-0 animate-spin rounded-full border-[1.5px] border-transparent border-t-text"
            />
            <IconStop size={9} className="fill-current" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            onClick={() => send().catch(() => {})}
            disabled={!!sendBlockedReason || sending || !text.trim()}
            title={sendBlockedReason ?? 'Send (↵)'}
            className="flex size-6 shrink-0 items-center justify-center rounded-[5px] bg-accent bg-[image:var(--accent-gradient)] text-on-accent disabled:opacity-40"
          >
            <IconReturn size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
