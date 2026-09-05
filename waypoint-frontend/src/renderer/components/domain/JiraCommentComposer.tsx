import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { postJiraComment, searchJiraAssignableUsers } from '@/data/jiraApi';
import type { JiraMentionSpan } from '@/data/jiraApi';
import { showErrorToast } from '@/lib/toast';
import { useJiraConnection } from '@/lib/jiraStore';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import type { JiraComment, JiraUserOption } from '@/types/jira';

// Plain `<textarea>`, not a contentEditable div — a deliberate deviation from
// the mockup's contentEditable + styled `<span class="mention">` chips, and
// still true even now that this composer has a real @-mention picker. This
// app's one other real comment composer (TicketDetailPage.tsx) is a plain
// textarea, and a `<textarea>` can represent a mention just fine as long as
// something other than the DOM tracks *where* one is — which is what
// `JiraMentionSpan` is for (see data/jiraApi.ts's `buildCommentAdf`): a
// start/end/accountId/displayName record kept alongside the plain string,
// reconciled against it on every edit, and turned into a real ADF `mention`
// node only at the moment of posting.
//
// This used to have no picker at all: typing "@Sam Lee" into a plain-text
// body produced eleven literal characters that notified nobody, and offering
// autocomplete for that would have been the app claiming a mention that
// never happened. What makes this version honest is that selecting a
// suggestion here doesn't just splice text in — it records a
// `JiraMentionSpan`, and `buildCommentAdf` is what turns that into a real
// ADF `mention` node carrying an accountId before the comment ever reaches
// Jira. Typing "@Sam Lee" by hand, without picking it from the list, still
// posts as plain text — same as before — because there is no accountId to
// attach to it.

const SEARCH_DEBOUNCE_MS = 250;
const POPOVER_WIDTH = 240;
const POPOVER_MAX_VISIBLE_ROWS = 6;
const POPOVER_ROW_HEIGHT = 34;

/** Where in `text` an active "@query" run starts, and what's been typed
 * after the "@" so far — or null when the caret isn't inside one.
 *
 * An "@" only starts a mention run when it opens a word: at the very start
 * of the draft, or right after whitespace. That's what keeps "user@example"
 * from popping the picker open on every email address typed into a comment.
 * The run ends at the first whitespace after the "@", which is also where
 * scanning bails out with no match if no "@" is found first — so pasting a
 * long line of prose with an "@" three paragraphs up never fires either.
 */
function findMentionTrigger(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') {
      const precededByWordBreak = i === 0 || /\s/.test(text[i - 1]);
      return precededByWordBreak
        ? { start: i, query: text.slice(i + 1, caret) }
        : null;
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

/**
 * The on-screen pixel position of one offset into a `<textarea>`'s text,
 * relative to the viewport — what anchors the mention popover to the "@" the
 * user actually typed rather than a fixed spot under the whole box.
 *
 * The standard technique for a plain `<textarea>`, which has no API of its
 * own for this: a hidden mirror `<div>` copies every layout-affecting style
 * property, is filled with the text up to `offset`, and a marker `<span>`
 * appended after it lands exactly where that character would have — because
 * the mirror wraps text identically to the real textarea underneath it.
 */
function getOffsetCoordinates(
  textarea: HTMLTextAreaElement,
  offset: number,
): { top: number; left: number; lineHeight: number } {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const copiedProps: (keyof CSSStyleDeclaration)[] = [
    'boxSizing',
    'width',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'lineHeight',
    'textTransform',
  ];
  const mirrorStyle = mirror.style as unknown as Record<string, string>;
  const computedStyle = style as unknown as Record<string, string>;
  copiedProps.forEach((prop) => {
    // Each of these is a real string-valued CSSStyleDeclaration property;
    // the cast is for the shared iteration, not because the value is
    // actually unknown.
    mirrorStyle[prop as string] = computedStyle[prop as string];
  });
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.height = 'auto';

  mirror.textContent = textarea.value.slice(0, offset);
  const marker = document.createElement('span');
  // A trailing marker needs *some* content to have real dimensions — an
  // empty inline element collapses to zero width, which would land the
  // popover on the mirror's left edge for a caret at the very end of the
  // text, the single most common position it's ever in.
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const lineHeight = parseFloat(style.lineHeight || '18') || 18;
  const rect = textarea.getBoundingClientRect();
  const top = rect.top - textarea.scrollTop + marker.offsetTop;
  const left = rect.left - textarea.scrollLeft + marker.offsetLeft;
  document.body.removeChild(mirror);

  return { top, left, lineHeight };
}

export function JiraCommentComposer({
  ticketId,
  ticketKey,
  onPosted,
}: {
  ticketId: string;
  /** Jira's assignable-user search is specified in terms of the issue KEY,
   * not its id — the same one channel `JiraAssigneePicker` already differs
   * on, for the same reason. */
  ticketKey: string;
  onPosted: (comment: JiraComment) => void;
}) {
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState<JiraMentionSpan[]>([]);
  const [posting, setPosting] = useState(false);
  const [trigger, setTrigger] = useState<{
    start: number;
    query: string;
  } | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [suggestions, setSuggestions] = useState<JiraUserOption[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<Error | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const connection = useJiraConnection();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Stable focus target for handlePost below — same focus-guard pattern as
  // TicketDetailPage.tsx's commentFormRef: the Comment button goes
  // `disabled={posting}` below, which force-blurs a focused control the
  // instant `disabled` is applied. Landing focus here first keeps the next
  // keystroke from leaking to a global shortcut.
  const formRef = useRef<HTMLDivElement>(null);

  const popoverOpen = trigger !== null;

  // The search itself. Debounced, cancellable, and re-run per keystroke of
  // the query — the same shape as JiraAssigneePicker's own search effect,
  // reusing the exact same endpoint (searchJiraAssignableUsers): this app has
  // no separate "who can be mentioned" concept from "who can be assigned",
  // and building one would mean a second permission model for what both
  // pickers agree is the same question, "who's actually on this issue".
  useEffect(() => {
    if (!trigger) {
      setSuggestions([]);
      setSuggestionsError(null);
      return undefined;
    }
    let cancelled = false;
    setLoadingSuggestions(true);
    setSuggestionsError(null);
    const timer = setTimeout(() => {
      searchJiraAssignableUsers(ticketKey, trigger.query)
        .then((rows) => {
          if (cancelled) return;
          setSuggestions(rows);
          setHighlighted(0);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setSuggestions([]);
          setSuggestionsError(
            err instanceof Error ? err : new Error(String(err)),
          );
        })
        .finally(() => {
          if (!cancelled) setLoadingSuggestions(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Anchored on the query text and the ticket, deliberately not on
    // `trigger` itself — a new object identity on every keystroke of the
    // *position* recompute below would otherwise re-debounce a query that
    // hasn't actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger?.query, ticketKey]);

  const popoverRef = useRef<HTMLDivElement>(null);

  // Click-away, while the popover is open only. Not `useFloatingPanel`: that
  // hook anchors to a stable trigger *element* (a chip that stays put once
  // clicked); this popover has to follow a caret that moves every keystroke,
  // which is a different enough contract that reusing it would mean bending
  // one of the two shapes to fit the other.
  useEffect(() => {
    if (!popoverOpen) return undefined;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (textareaRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setTrigger(null);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [popoverOpen]);

  /** Re-derives the active mention trigger and, when one exists, the
   * popover's anchor point — called after every change that can move the
   * caret (typing, clicking, arrow-key navigation). */
  function syncTrigger(text: string, caret: number) {
    const next = findMentionTrigger(text, caret);
    setTrigger(next);
    if (!next) return;
    const el = textareaRef.current;
    if (!el) return;
    const { top, left, lineHeight } = getOffsetCoordinates(el, next.start);
    // Clamped to the viewport's right/bottom edges, the same property
    // useFloatingPanel's own `computeCoords` guarantees for the other three
    // pickers: a caret near the drawer's right edge or the window's bottom
    // must not push this popover half off-screen.
    const clampedLeft = Math.min(
      Math.max(left, 8),
      Math.max(8, window.innerWidth - POPOVER_WIDTH - 8),
    );
    const estimatedHeight = POPOVER_MAX_VISIBLE_ROWS * POPOVER_ROW_HEIGHT;
    const spaceBelow = window.innerHeight - (top + lineHeight + 4);
    const placeAbove = spaceBelow < estimatedHeight && top > spaceBelow;
    const clampedTop = placeAbove
      ? Math.max(8, top - estimatedHeight - 4)
      : top + lineHeight + 4;
    setAnchor({ top: clampedTop, left: clampedLeft });
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const newText = e.target.value;
    const oldText = draft;
    const delta = newText.length - oldText.length;
    const caret = e.target.selectionStart;

    if (delta !== 0) {
      // A single edit point, anchored on the caret's position *after* the
      // change — correct for every plain keystroke (the overwhelming
      // majority of edits to this box) and for a paste that doesn't replace
      // an existing selection. A paste that overwrites a multi-character
      // selection can shift a span's offsets slightly wrong instead; that
      // is caught, not silently trusted, by `buildCommentAdf`'s own
      // exact-substring check right before the comment is sent — so the
      // failure mode here is "occasionally has to re-mention someone after
      // a paste", never "occasionally mentions the wrong person".
      const editStart = delta > 0 ? caret - delta : caret;
      const editEnd = delta > 0 ? caret : caret - delta;
      setMentions((spans) =>
        spans
          .filter((s) => s.end <= editStart || s.start >= editEnd)
          .map((s) =>
            s.start >= editEnd
              ? { ...s, start: s.start + delta, end: s.end + delta }
              : s,
          ),
      );
    }

    setDraft(newText);
    syncTrigger(newText, caret);
  }

  function handleSelectCaret(e: SyntheticEvent<HTMLTextAreaElement>) {
    syncTrigger(draft, e.currentTarget.selectionStart);
  }

  function selectMention(option: JiraUserOption) {
    if (!trigger) return;
    const el = textareaRef.current;
    const caret =
      el?.selectionStart ?? trigger.start + 1 + trigger.query.length;
    const mentionText = `@${option.displayName}`;
    const insertText = `${mentionText} `;
    const before = draft.slice(0, trigger.start);
    const after = draft.slice(caret);
    const delta = insertText.length - (caret - trigger.start);

    setMentions((spans) => [
      ...spans
        .filter((s) => s.end <= trigger.start || s.start >= caret)
        .map((s) =>
          s.start >= caret
            ? { ...s, start: s.start + delta, end: s.end + delta }
            : s,
        ),
      {
        start: trigger.start,
        end: trigger.start + mentionText.length,
        accountId: option.accountId,
        displayName: option.displayName,
      },
    ]);
    setDraft(before + insertText + after);
    setTrigger(null);

    const newCaret = trigger.start + insertText.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(newCaret, newCaret);
    });
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (trigger && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlighted((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlighted(
          (i) => (i - 1 + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMention(suggestions[highlighted]);
        return;
      }
    }
    if (trigger && e.key === 'Escape') {
      // Stops here, at the textarea itself — the earliest point in the
      // bubble chain — rather than reaching JiraTicketDrawer's own
      // document-level Escape listener. That listener is bubble-phase with
      // no capture guard of its own, so anything that gets past this point
      // closes the whole drawer, not just this popover.
      e.preventDefault();
      e.stopPropagation();
      setTrigger(null);
    }
  }

  async function handlePost() {
    if (!draft.trim() || posting) return;
    formRef.current?.focus();
    setPosting(true);
    try {
      const comment = await postJiraComment(ticketId, draft, mentions);
      onPosted(comment);
      setDraft('');
      setMentions([]);
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : 'Could not post this comment to Jira.',
      );
    } finally {
      setPosting(false);
    }
  }

  const popoverHeight =
    Math.min(Math.max(suggestions.length, 1), POPOVER_MAX_VISIBLE_ROWS) *
      POPOVER_ROW_HEIGHT +
    (loadingSuggestions || suggestionsError || suggestions.length === 0
      ? 20
      : 8);

  return (
    <div
      ref={formRef}
      tabIndex={-1}
      data-shortcut-guard
      className="relative outline-none"
    >
      <div className="rounded-[var(--radius-sm)] border border-border-strong bg-surface">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onClick={handleSelectCaret}
          onKeyUp={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
              handleSelectCaret(e);
            }
          }}
          placeholder="Comment… (@ to mention someone)"
          rows={3}
          className="w-full resize-none rounded-t-[var(--radius-sm)] bg-transparent px-2.5 py-2 text-[12.5px] leading-relaxed text-text outline-none"
        />
        <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
          {/* The name is the connected Atlassian account's own display name,
              read from the shared connection store — this comment really is
              posted as that person, and the label has to be able to say who
              that is rather than the fixture name it used to hardcode. */}
          <span className="flex-1 text-[10.5px] text-text-muted">
            Posts to Jira as {connection?.accountName || 'you'}
          </span>
          <Button
            size="xs"
            variant="primary"
            disabled={!draft.trim() || posting}
            onClick={handlePost}
          >
            {posting ? 'Posting…' : 'Comment'}
          </Button>
        </div>
      </div>

      {popoverOpen &&
        anchor &&
        createPortal(
          <div
            ref={popoverRef}
            role="listbox"
            aria-label={`Mention someone on ${ticketKey}`}
            style={{
              top: anchor.top,
              left: anchor.left,
              height: popoverHeight,
            }}
            className="fixed z-[60] w-[240px] overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface text-left shadow-2xl"
          >
            {loadingSuggestions && (
              <div className="px-3 py-2 text-xs text-text-muted">
                Searching teammates…
              </div>
            )}
            {!loadingSuggestions && suggestionsError && (
              <JiraLoadError
                compact
                what="who can be mentioned"
                error={suggestionsError}
              />
            )}
            {!loadingSuggestions &&
              !suggestionsError &&
              suggestions.length === 0 && (
                <div className="px-3 py-2 text-xs text-text-muted">
                  {trigger?.query
                    ? `Nobody matches “${trigger.query}”.`
                    : 'No teammates found on this issue.'}
                </div>
              )}
            {!loadingSuggestions &&
              !suggestionsError &&
              suggestions.map((user, i) => (
                <button
                  key={user.accountId}
                  type="button"
                  // onMouseDown, not onClick: a click fires after the
                  // textarea has already blurred from the mousedown above,
                  // and by then `trigger` and the caret this reads are gone.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectMention(user);
                  }}
                  onMouseEnter={() => setHighlighted(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] font-medium text-text ${
                    i === highlighted ? 'bg-surface-2' : ''
                  }`}
                >
                  <span aria-hidden="true" className="flex shrink-0">
                    <Avatar name={user.displayName} size={18} />
                  </span>
                  <span className="min-w-0 truncate">{user.displayName}</span>
                </button>
              ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
