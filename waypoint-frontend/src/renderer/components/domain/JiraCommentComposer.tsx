import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  postJiraComment,
  searchJiraAssignableUsers,
  uploadJiraAttachment,
} from '@/data/jiraApi';
import type { JiraMentionSpan } from '@/data/jiraApi';
import { showErrorToast } from '@/lib/toast';
import { useJiraConnection } from '@/lib/jiraStore';
import { useFloatingPanel } from '@/components/ui/useFloatingPanel';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import { JIRA_COMMENT_EMOJI } from '@/components/domain/jiraCommentEmoji';
import type {
  JiraAttachment,
  JiraComment,
  JiraTicket,
  JiraUserOption,
} from '@/types/jira';

// Plain `<textarea>`, not a contentEditable div — a deliberate deviation from
// the mockup's contentEditable + styled `<span class="mention">` chips, and
// still true even now that this composer has a real @-mention picker and a
// formatting toolbar. This app's one other real comment composer
// (TicketDetailPage.tsx) is a plain textarea, and a `<textarea>` can
// represent structure just fine as long as something other than the DOM
// tracks it: a mention is a `JiraMentionSpan` (start/end/accountId/
// displayName), and formatting is a small markdown-lite subset the toolbar
// writes as literal characters — **bold**, "- " for a bullet, a ``` fence —
// which `buildCommentAdf` (data/jiraApi.ts) parses into real ADF only at
// the moment of posting. Nothing here renders bold text while typing it;
// the toolbar shows you what you typed, the same way a `.md` file's own
// editor usually does.
//
// The @-mention picker used to be the one thing missing here (see git
// history): typing "@Sam Lee" into a plain-text body produced eleven
// literal characters that notified nobody, and offering autocomplete for
// that would have been the app claiming a mention that never happened.
// Selecting a suggestion records a `JiraMentionSpan` instead, and
// `buildCommentAdf` turns a valid one into a real ADF `mention` node
// carrying an accountId before the comment ever reaches Jira.

const SEARCH_DEBOUNCE_MS = 250;
const POPOVER_WIDTH = 240;
const POPOVER_MAX_VISIBLE_ROWS = 6;
const POPOVER_ROW_HEIGHT = 34;
const EMOJI_PANEL_WIDTH = 264;
const EMOJI_PANEL_HEIGHT = 260;

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

interface LineInfo {
  start: number;
  end: number;
  text: string;
}

function linesOf(text: string): LineInfo[] {
  let offset = 0;
  return text.split('\n').map((t) => {
    const start = offset;
    const end = start + t.length;
    offset = end + 1; // +1 skips the '\n' String.split consumed
    return { start, end, text: t };
  });
}

type BlockKind = 'heading' | 'bullet' | 'ordered' | 'quote';

const BLOCK_PREFIX_PATTERN: Record<BlockKind, RegExp> = {
  heading: /^#{1,3}\s+/,
  bullet: /^[-*]\s+/,
  ordered: /^\d+\.\s+/,
  quote: /^>\s?/,
};

const BLOCK_PREFIX: Record<BlockKind, string> = {
  heading: '## ',
  bullet: '- ',
  ordered: '1. ',
  quote: '> ',
};

/** One toolbar button's inline-mark behavior: the delimiter pair a
 * selection gets wrapped in, matching `jiraApi.ts`'s `buildCommentAdf`
 * pattern set exactly — a button here that used a delimiter that parser
 * doesn't recognize would silently fail to format anything. */
const INLINE_WRAP: {
  code: [string, string];
  strong: [string, string];
  em: [string, string];
  strike: [string, string];
} = {
  code: ['`', '`'],
  strong: ['**', '**'],
  em: ['_', '_'],
  strike: ['~~', '~~'],
};

/** One toolbar button: a glyph rather than an SVG icon, since none of these
 * marks have an icon in this app's existing set and adding one just for
 * this toolbar would be its own small dependency decision. `aria-label`
 * carries the real name; the glyph is decorative. `onMouseDown` with
 * `preventDefault`, not `onClick`: a click fires after the textarea has
 * already blurred and its selection cleared, which every caller above
 * relies on still being there. */
function ToolbarButton({
  label,
  glyph,
  glyphClassName,
  active,
  disabled,
  onClick,
  ref,
}: {
  label: string;
  glyph: string;
  glyphClassName?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={`flex h-6 min-w-6 shrink-0 items-center justify-center rounded px-1 text-[11.5px] text-text-secondary hover:bg-surface-2 hover:text-text disabled:opacity-50 ${
        active ? 'bg-surface-2 text-text' : ''
      } ${glyphClassName ?? ''}`}
    >
      {glyph}
    </button>
  );
}

/**
 * The emoji popover, as its own component rather than state inline in
 * `JiraCommentComposer` — the reason is `useFloatingPanel` itself, not
 * style. That hook assumes it is mounted only while its panel is open (see
 * its own header comment): "on open" is mount, "on close" is unmount, which
 * is what lets its Escape handler unconditionally call `onClose` the moment
 * Escape fires. Calling the hook unconditionally in the composer's
 * always-mounted body would keep that capture-phase Escape listener
 * permanently active — intercepting Escape before it ever reached the
 * mention popover's own handling in the textarea, even when the emoji
 * panel was never open. This component's own render gate
 * (`{emojiOpen && <JiraCommentEmojiPicker ... />}` in the parent) is what
 * keeps the hook's real assumption true, matching exactly how
 * JiraPriorityPicker and JiraAssigneePicker are mounted only while their
 * own picker is open.
 */
function JiraCommentEmojiPicker({
  triggerRef,
  onSelect,
  onClose,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSelect: (char: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = query.trim()
    ? JIRA_COMMENT_EMOJI.filter((e) =>
        e.name.includes(query.trim().toLowerCase()),
      )
    : JIRA_COMMENT_EMOJI;

  const { panelProps } = useFloatingPanel({
    triggerRef,
    onClose,
    width: EMOJI_PANEL_WIDTH,
    estimatedHeight: EMOJI_PANEL_HEIGHT,
    align: 'right',
    label: 'Insert an emoji',
    remeasureOn: [filtered.length],
  });

  return createPortal(
    <div
      ref={panelProps.ref}
      tabIndex={panelProps.tabIndex}
      role={panelProps.role}
      aria-label={panelProps['aria-label']}
      data-shortcut-guard={panelProps['data-shortcut-guard']}
      style={{ ...panelProps.style, width: EMOJI_PANEL_WIDTH }}
      onClick={panelProps.onClick}
      className="fixed z-[60] overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface text-left shadow-2xl outline-none"
    >
      <div className="border-b border-border p-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emoji…"
          aria-label="Search emoji"
          className="w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg-inset px-2 py-1.5 text-[12.5px] text-text outline-none focus:border-accent"
        />
      </div>
      <div className="thin-scroll grid max-h-[210px] grid-cols-7 gap-0.5 overflow-y-auto p-1.5">
        {filtered.map((emoji) => (
          <button
            key={emoji.char}
            type="button"
            // Both `title` (a hover tooltip) and `aria-label` (the
            // accessible name) name the same thing deliberately: this
            // button's own text content is the emoji glyph itself, which an
            // accessible-name computation would otherwise announce as a
            // bare Unicode character rather than "thumbs up".
            title={emoji.name}
            aria-label={emoji.name}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(emoji.char);
            }}
            className="flex size-8 items-center justify-center rounded text-[17px] hover:bg-surface-2"
          >
            {emoji.char}
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="col-span-7 px-1 py-3 text-center text-xs text-text-muted">
            No matches.
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function JiraCommentComposer({
  ticketId,
  ticketKey,
  attachments,
  onPosted,
  onTicketUpdated,
}: {
  ticketId: string;
  /** Jira's assignable-user search is specified in terms of the issue KEY,
   * not its id — the same one channel `JiraAssigneePicker` already differs
   * on, for the same reason. */
  ticketKey: string;
  /** The issue's current attachments, so a file attached from this composer
   * can tell which one it just added — see `handleAttach` — without the
   * composer keeping its own second copy of the list. */
  attachments: JiraAttachment[];
  onPosted: (comment: JiraComment) => void;
  /** Attaching a file from the composer attaches it to the issue, the same
   * write `JiraTicketDrawer`'s own "Attach a file" button makes — so the
   * re-read ticket goes up through the same callback that keeps the
   * drawer's Attachments section in sync. */
  onTicketUpdated: (updated: JiraTicket) => void;
}) {
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState<JiraMentionSpan[]>([]);
  const [posting, setPosting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [trigger, setTrigger] = useState<{
    start: number;
    query: string;
  } | null>(null);
  /** Where the "@" that opened the popover sits on screen, and how tall its
   * line is. Raw caret geometry only — the panel's own placement is derived
   * from this plus its real height at render time. */
  const [caretPoint, setCaretPoint] = useState<{
    top: number;
    left: number;
    lineHeight: number;
  } | null>(null);
  const [suggestions, setSuggestions] = useState<JiraUserOption[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<Error | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const connection = useJiraConnection();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
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

  // Click-away, while the mention popover is open only. Not `useFloatingPanel`:
  // that hook anchors to a stable trigger *element* (a chip that stays put
  // once clicked); this popover has to follow a caret that moves every
  // keystroke, which is a different enough contract that reusing it would
  // mean bending one of the two shapes to fit the other. The emoji picker
  // below doesn't have this problem — its trigger is the toolbar button
  // itself, a stable element — so it uses `useFloatingPanel` directly.
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

  /** Re-derives the active mention trigger and, when one exists, where the
   * "@" itself sits on screen — called after every change that can move the
   * caret (typing, clicking, arrow-key navigation).
   *
   * Deliberately stores only the caret's own geometry, not the panel's final
   * position: the panel's height depends on how many suggestions came back,
   * which isn't known yet at this point and changes again when the search
   * resolves. Placement is derived from that real height at render time
   * instead (see `placement` below) — computing it here against a
   * worst-case estimate is what left the popover floating ~155px above the
   * caret with nothing in between, since a one-result panel is 42px tall
   * and the estimate reserved 204. */
  function syncTrigger(text: string, caret: number) {
    const next = findMentionTrigger(text, caret);
    setTrigger(next);
    if (!next) return;
    const el = textareaRef.current;
    if (!el) return;
    setCaretPoint(getOffsetCoordinates(el, next.start));
  }

  /** Shifts every tracked mention span by `delta` characters wherever an
   * edit at [editStart, editEnd) in the *previous* draft affects it — the
   * one calculation every draft-mutating action in this component needs
   * (typing, a toolbar wrap, a block-prefix toggle, an inserted emoji or
   * attachment link), pulled out once rather than five times. A span that
   * overlaps the edited range is dropped rather than guessed at; whatever
   * text ends up there is re-validated against "@" + displayName by
   * `buildCommentAdf` right before the comment is sent regardless. */
  function shiftMentionsForEdit(
    editStart: number,
    editEnd: number,
    delta: number,
  ) {
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
      // selection can shift a span's offsets slightly wrong instead; see
      // `shiftMentionsForEdit`'s own note on why that's an acceptable
      // failure mode.
      const editStart = delta > 0 ? caret - delta : caret;
      const editEnd = delta > 0 ? caret : caret - delta;
      shiftMentionsForEdit(editStart, editEnd, delta);
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

    shiftMentionsForEdit(trigger.start, caret, delta);
    setMentions((spans) => [
      ...spans,
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

  /** Wraps the current selection in a delimiter pair — **bold**, _em_,
   * ~~strike~~, `code` — or, with nothing selected, inserts an empty pair
   * with the caret left between the two delimiters, ready to type into.
   * The selected text (or the caret) is what every toolbar button beyond
   * the block-structure ones (heading/list/quote) operates on. */
  function wrapSelection(kind: keyof typeof INLINE_WRAP) {
    const el = textareaRef.current;
    if (!el) return;
    const [prefix, suffix] = INLINE_WRAP[kind];
    const selStart = el.selectionStart;
    const selEnd = el.selectionEnd;
    const selected = draft.slice(selStart, selEnd);
    const before = draft.slice(0, selStart);
    const after = draft.slice(selEnd);
    const newDraft = `${before}${prefix}${selected}${suffix}${after}`;
    const delta = prefix.length + suffix.length;

    shiftMentionsForEdit(selStart, selEnd, delta + (selEnd - selStart));
    setDraft(newDraft);
    const newSelStart = selStart + prefix.length;
    const newSelEnd = newSelStart + selected.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(newSelStart, newSelEnd);
    });
  }

  /** Wraps the current selection (or the caret) in a link: `[text](url)`,
   * with "url" pre-selected so pasting or typing a real address is the very
   * next keystroke. With no selection, "link" is inserted as the link text
   * and selected first instead, so the two-step flow (name it, then paste
   * the address) always has something sensible selected at each step. */
  function insertLink() {
    const el = textareaRef.current;
    if (!el) return;
    const selStart = el.selectionStart;
    const selEnd = el.selectionEnd;
    const hasSelection = selEnd > selStart;
    const linkText = hasSelection ? draft.slice(selStart, selEnd) : 'link';
    const insertText = `[${linkText}](url)`;
    const before = draft.slice(0, selStart);
    const after = draft.slice(selEnd);

    shiftMentionsForEdit(
      selStart,
      selEnd,
      insertText.length - (selEnd - selStart),
    );
    setDraft(before + insertText + after);

    const urlStart = selStart + `[${linkText}](`.length;
    const selectionStart = hasSelection ? urlStart : selStart + 1;
    const selectionEnd = hasSelection
      ? urlStart + 3
      : selStart + 1 + linkText.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  /** Wraps the current selection (or the caret) in a fenced code block —
   * the one toolbar action that spans whole lines rather than a run of
   * inline text, since `buildCommentAdf` only recognizes a ``` fence that
   * starts its own line. */
  function insertCodeBlock() {
    const el = textareaRef.current;
    if (!el) return;
    const selStart = el.selectionStart;
    const selEnd = el.selectionEnd;
    const selected = draft.slice(selStart, selEnd);
    const before = draft.slice(0, selStart);
    const after = draft.slice(selEnd);
    const insertText = `\`\`\`\n${selected}\n\`\`\``;
    const newDraft = `${before}${insertText}${after}`;

    shiftMentionsForEdit(
      selStart,
      selEnd,
      insertText.length - (selEnd - selStart),
    );
    setDraft(newDraft);
    const innerStart = selStart + 4; // past "```\n"
    const innerEnd = innerStart + selected.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(innerStart, innerEnd);
    });
  }

  /**
   * Toggles a line-prefix block kind (heading/bullet/ordered/quote) across
   * every line the current selection touches — adding the prefix to lines
   * that don't have one if any touched line is missing it, or stripping it
   * from all of them if every touched line already has one. Each line's own
   * length change is tracked so mention spans elsewhere in the draft shift
   * by exactly the right amount, including spans on a touched line itself
   * (see the `shift` note below).
   */
  function toggleBlockPrefix(kind: BlockKind) {
    const el = textareaRef.current;
    if (!el) return;
    const selStart = el.selectionStart;
    const selEnd = el.selectionEnd;
    const lines = linesOf(draft);
    const touched = lines.map((l) => l.start <= selEnd && l.end >= selStart);
    if (!touched.some(Boolean)) return;

    const pattern = BLOCK_PREFIX_PATTERN[kind];
    const prefix = BLOCK_PREFIX[kind];
    const allHavePrefix = lines.every(
      (l, i) => !touched[i] || pattern.test(l.text),
    );

    const rewritten = lines.map((l, i) => {
      if (!touched[i]) return { text: l.text, delta: 0 };
      const newText = allHavePrefix
        ? l.text.replace(pattern, '')
        : `${prefix}${l.text}`;
      return { text: newText, delta: newText.length - l.text.length };
    });

    // Every mention shifts by the sum of deltas from every line whose own
    // content starts at or before that mention's start — including the
    // mention's own line, since a prefix is inserted at that line's start,
    // before anything else on it.
    setMentions((spans) =>
      spans.map((s) => {
        const shift = lines.reduce(
          (sum, l, i) => (l.start <= s.start ? sum + rewritten[i].delta : sum),
          0,
        );
        return { ...s, start: s.start + shift, end: s.end + shift };
      }),
    );
    setDraft(rewritten.map((r) => r.text).join('\n'));
    requestAnimationFrame(() => el.focus());
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

  /** Uploads a file to the issue and links it into the draft, right at the
   * caret. The write is identical to the drawer's own "Attach a file"
   * button (`uploadJiraAttachment`) — this doesn't duplicate that flow, it
   * just also does something with the result: finds the attachment that
   * wasn't in `attachments` before this call and inserts a link to it, so
   * a reader of the comment itself sees what was attached rather than
   * having to go find it in the Attachments section separately. */
  async function handleAttach() {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? draft.length;
    const existingIds = new Set(
      attachments.map((a) => a.id).filter((id): id is string => id !== null),
    );
    setAttaching(true);
    try {
      const { canceled, ticket } = await uploadJiraAttachment(ticketId);
      if (canceled || !ticket) return;
      onTicketUpdated(ticket);
      const added = ticket.attachments.find(
        (a) => a.id !== null && !existingIds.has(a.id),
      );
      if (!added || !connection?.site) return;
      const url = `https://${connection.site}/rest/api/3/attachment/content/${added.id}`;
      const insertText = `[📎 ${added.fileName}](${url}) `;
      const before = draft.slice(0, caret);
      const after = draft.slice(caret);
      shiftMentionsForEdit(caret, caret, insertText.length);
      setDraft(before + insertText + after);
      const newCaret = caret + insertText.length;
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(newCaret, newCaret);
      });
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : 'Could not attach that file in Jira.',
      );
    } finally {
      setAttaching(false);
    }
  }

  function insertEmoji(emoji: string) {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? draft.length;
    const selEnd = el?.selectionEnd ?? caret;
    const before = draft.slice(0, caret);
    const after = draft.slice(selEnd);
    shiftMentionsForEdit(caret, selEnd, emoji.length - (selEnd - caret));
    setDraft(`${before}${emoji}${after}`);
    setEmojiOpen(false);
    const newCaret = caret + emoji.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(newCaret, newCaret);
    });
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

  /**
   * Where the panel actually goes, computed here rather than when the "@"
   * was typed — because only here is `popoverHeight` known, and it changes
   * as the search resolves (one "Searching teammates…" row becoming three
   * results). Placing against a fixed worst-case estimate instead is what
   * made this popover sit ~155px above the caret with a gap of nothing
   * between them: a one-result panel is 42px tall, and the estimate
   * reserved a six-row 204.
   *
   * Below the caret's own line by default; flipped above only when the
   * panel genuinely doesn't fit below, and then by its real height, so it
   * sits directly on top of the "@" rather than somewhere above it. Both
   * axes stay clamped inside the viewport — the same guarantee
   * `useFloatingPanel`'s `computeCoords` makes for the other three pickers.
   */
  const placement = caretPoint
    ? (() => {
        const belowTop = caretPoint.top + caretPoint.lineHeight + 4;
        const fitsBelow = belowTop + popoverHeight <= window.innerHeight - 8;
        const top = fitsBelow
          ? belowTop
          : Math.max(8, caretPoint.top - popoverHeight - 4);
        const left = Math.min(
          Math.max(caretPoint.left, 8),
          Math.max(8, window.innerWidth - POPOVER_WIDTH - 8),
        );
        return { top, left };
      })()
    : null;

  return (
    <div
      ref={formRef}
      tabIndex={-1}
      data-shortcut-guard
      className="relative outline-none"
    >
      <div className="rounded-[var(--radius-sm)] border border-border-strong bg-surface">
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
          <ToolbarButton
            label="Bold"
            glyph="B"
            glyphClassName="font-bold"
            onClick={() => wrapSelection('strong')}
          />
          <ToolbarButton
            label="Italic"
            glyph="I"
            glyphClassName="italic"
            onClick={() => wrapSelection('em')}
          />
          <ToolbarButton
            label="Strikethrough"
            glyph="S"
            glyphClassName="line-through"
            onClick={() => wrapSelection('strike')}
          />
          <ToolbarButton
            label="Inline code"
            glyph="</>"
            onClick={() => wrapSelection('code')}
          />
          <span className="mx-0.5 h-4.5 w-px shrink-0 bg-border" />
          <ToolbarButton
            label="Heading"
            glyph="H"
            onClick={() => toggleBlockPrefix('heading')}
          />
          <ToolbarButton
            label="Bullet list"
            glyph="•"
            onClick={() => toggleBlockPrefix('bullet')}
          />
          <ToolbarButton
            label="Numbered list"
            glyph="1."
            onClick={() => toggleBlockPrefix('ordered')}
          />
          <ToolbarButton
            label="Quote"
            glyph="❝"
            onClick={() => toggleBlockPrefix('quote')}
          />
          <ToolbarButton
            label="Code block"
            glyph="{ }"
            onClick={insertCodeBlock}
          />
          <ToolbarButton label="Link" glyph="🔗" onClick={insertLink} />
          <span className="mx-0.5 h-4.5 w-px shrink-0 bg-border" />
          <ToolbarButton
            ref={emojiButtonRef}
            label="Emoji"
            glyph="🙂"
            active={emojiOpen}
            onClick={() => setEmojiOpen((o) => !o)}
          />
          <ToolbarButton
            label="Attach a file to this comment"
            glyph="📎"
            disabled={attaching}
            onClick={handleAttach}
          />
          {attaching && (
            <span className="ml-1 text-[10.5px] text-text-muted">
              Attaching…
            </span>
          )}
        </div>
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
          className="w-full resize-none bg-transparent px-2.5 py-2 text-[12.5px] leading-relaxed text-text outline-none"
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

      {emojiOpen && (
        <JiraCommentEmojiPicker
          triggerRef={emojiButtonRef}
          onSelect={insertEmoji}
          onClose={() => setEmojiOpen(false)}
        />
      )}

      {popoverOpen &&
        placement &&
        createPortal(
          <div
            ref={popoverRef}
            role="listbox"
            aria-label={`Mention someone on ${ticketKey}`}
            style={{
              top: placement.top,
              left: placement.left,
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
