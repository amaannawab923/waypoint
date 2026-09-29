import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { clsx } from 'clsx';
import {
  Bold,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Paperclip,
  Quote,
  Smile,
  Strikethrough,
  Table as TableIcon,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { MARKDOWN_SYNTAX_HINTS, renderMarkdown } from '@/lib/markdown';
import { JIRA_COMMENT_EMOJI } from '@/components/domain/jiraCommentEmoji';
import {
  continueList,
  insertCodeBlock,
  insertHorizontalRule,
  insertLink,
  insertMention,
  insertTable,
  insertText,
  toggleBlockquote,
  toggleBulletList,
  toggleHeading,
  toggleOrderedList,
  toggleTaskList,
  toggleWrap,
  type EditOutcome,
  type TextSelection,
} from './markdownTextEditing';

export interface MentionMatch {
  id: string;
  name: string;
}

export interface MarkdownEditorProps {
  /** Markdown source. Controlled — the caller owns the draft. */
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Cmd/Ctrl+Enter. */
  onSubmit?: () => void;
  /** Escape. */
  onCancel?: () => void;
  /** Files dropped on, pasted into, or picked via the toolbar's attach
   *  button. */
  onFiles?: (files: File[]) => void;
  /** When provided, typing "@" opens a member picker at the caret. Returns
   *  matches for the text typed after the "@" so far (debounced
   *  internally). Selecting one inserts plain text "@Name " — comments are
   *  markdown source, so that's the only representation a mention needs. */
  mentionSource?: (query: string) => Promise<MentionMatch[]>;
  disabled?: boolean;
  minRows?: number;
  className?: string;
  /** Accessible name for the textarea/preview region. Defaults to
   *  `placeholder`. */
  ariaLabel?: string;
  /** The composer's own action buttons (Cancel / Comment, Cancel / Save,
   *  …) — rendered in the footer's right side. This component only owns
   *  the editing surface, not what posting or canceling means to the
   *  caller. */
  footerActions?: ReactNode;
}

type Tab = 'write' | 'preview';

const MENTION_DEBOUNCE_MS = 150;

interface MentionAnchor {
  query: string;
  from: number;
  to: number;
}

function computeMentionAnchor(value: string, caret: number): MentionAnchor | null {
  const before = value.slice(0, caret);
  const match = /(?:^|\s)@(\w*)$/.exec(before);
  if (!match) return null;
  const atLength = 1 + match[1].length;
  return { query: match[1], from: caret - atLength, to: caret };
}

/** Best-effort pixel position of `position` within `textarea`, via the
 * classic "mirror div" trick: an off-screen div styled identically to the
 * textarea, filled with the text up to the caret, whose trailing span's
 * offset tells us where the real caret would render. Returns null instead
 * of guessing when the textarea isn't laid out yet (e.g. under a
 * layout-less test environment) — callers fall back to anchoring the
 * popup under the textarea instead. */
function caretPixelPosition(textarea: HTMLTextAreaElement, position: number): { top: number; left: number } | null {
  if (typeof window === 'undefined') return null;
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const props: (keyof CSSStyleDeclaration)[] = [
    'boxSizing',
    'width',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'letterSpacing',
    'lineHeight',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
  ];
  for (const prop of props) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mirror.style as any)[prop] = style[prop] as string;
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.height = 'auto';
  mirror.textContent = textarea.value.slice(0, position);
  const span = document.createElement('span');
  span.textContent = textarea.value.slice(position) || '.';
  mirror.appendChild(span);
  document.body.appendChild(mirror);
  const top = span.offsetTop;
  const left = span.offsetLeft;
  document.body.removeChild(mirror);
  if (top === 0 && left === 0 && textarea.value.slice(0, position).length > 0) {
    // jsdom (and any environment without real layout) always reports 0,0 —
    // indistinguishable from a genuine caret at the very top-left. Signal
    // "couldn't measure" rather than a misleading (0,0).
    return null;
  }
  return { top, left };
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  autoFocus,
  onSubmit,
  onCancel,
  onFiles,
  mentionSource,
  disabled,
  minRows = 3,
  className,
  ariaLabel,
  footerActions,
}: MarkdownEditorProps) {
  const [tab, setTab] = useState<Tab>('write');
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiQuery, setEmojiQuery] = useState('');
  const [mentionAnchor, setMentionAnchor] = useState<MentionAnchor | null>(null);
  const [mentionMatches, setMentionMatches] = useState<MentionMatch[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [mentionCoords, setMentionCoords] = useState<{ top: number; left: number } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const pendingSelectionRef = useRef<TextSelection | null>(null);
  const mentionRequestIdRef = useRef(0);

  // The value the caller passes back after onChange is what drives the
  // textarea (this is a controlled component) — but setting `.value`
  // programmatically resets the DOM caret to the end. Any toolbar action
  // that computes a new caret position stashes it here, and this effect
  // applies it once the new `value` has actually landed in the DOM.
  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current;
    if (!pending || !textareaRef.current) return;
    pendingSelectionRef.current = null;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(pending.start, pending.end);
  }, [value]);

  function commit(outcome: EditOutcome) {
    pendingSelectionRef.current = outcome.selection;
    onChange(outcome.value);
  }

  function currentSelection(): TextSelection {
    const el = textareaRef.current;
    if (!el) return { start: value.length, end: value.length };
    return { start: el.selectionStart ?? value.length, end: el.selectionEnd ?? value.length };
  }

  function runToolbarAction(fn: (text: string, sel: TextSelection) => EditOutcome) {
    if (tab !== 'write') setTab('write');
    commit(fn(value, currentSelection()));
  }

  // ---- mentions --------------------------------------------------------

  useEffect(() => {
    if (!mentionAnchor || !mentionSource) {
      setMentionMatches([]);
      setMentionLoading(false);
      return;
    }
    setMentionActiveIndex(0);
    setMentionLoading(true);
    const requestId = ++mentionRequestIdRef.current;
    const timer = setTimeout(() => {
      mentionSource(mentionAnchor.query)
        .then((matches) => {
          if (mentionRequestIdRef.current !== requestId) return;
          setMentionMatches(matches);
          setMentionLoading(false);
        })
        .catch(() => {
          if (mentionRequestIdRef.current !== requestId) return;
          setMentionMatches([]);
          setMentionLoading(false);
        });
    }, MENTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mentionAnchor, mentionSource]);

  function selectMention(match: MentionMatch) {
    if (!mentionAnchor) return;
    commit(insertMention(value, mentionAnchor.from, mentionAnchor.to, match.name));
    setMentionAnchor(null);
  }

  // Takes the text/caret explicitly rather than reading `value` from
  // closure — called from `handleChange` with the textarea's own
  // just-changed value and selection, which is the primary way "@x" text
  // ever appears (typing), and is reliable the instant a change event
  // fires. `handleSelect` (mouse/arrow-key caret moves with no value
  // change) passes the same pair read fresh from the DOM.
  function updateMentionAnchor(text: string, el: HTMLTextAreaElement) {
    if (!mentionSource) {
      setMentionAnchor(null);
      return;
    }
    const caret = el.selectionStart ?? 0;
    const anchor = el.selectionStart === el.selectionEnd ? computeMentionAnchor(text, caret) : null;
    setMentionAnchor(anchor);
    if (anchor) {
      const pixels = caretPixelPosition(el, anchor.to);
      const rect = el.getBoundingClientRect();
      setMentionCoords(
        pixels
          ? { top: rect.top - el.scrollTop + pixels.top + 20, left: rect.left - el.scrollLeft + pixels.left }
          : { top: rect.bottom + 4, left: rect.left },
      );
    }
  }

  // ---- keyboard ----------------------------------------------------------

  function handleKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (mentionAnchor && mentionSource) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMentionAnchor(null);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionActiveIndex((i) => (mentionMatches.length ? (i + 1) % mentionMatches.length : 0));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionActiveIndex((i) => (mentionMatches.length ? (i - 1 + mentionMatches.length) % mentionMatches.length : 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const match = mentionMatches[mentionActiveIndex];
        if (match) {
          e.preventDefault();
          selectMention(match);
          return;
        }
      }
    }

    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit?.();
      return;
    }
    if (e.key === 'Escape') {
      if (onCancel) {
        e.preventDefault();
        onCancel();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const outcome = continueList(value, currentSelection());
      if (outcome) {
        e.preventDefault();
        commit(outcome);
      }
    }
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    updateMentionAnchor(e.target.value, e.target);
  }

  // Selection-driven (not just value-driven) so moving the caret with the
  // mouse or arrow keys closes/repositions the mention popup correctly —
  // typing itself is covered by handleChange above.
  function handleSelect(e: { currentTarget: HTMLTextAreaElement }) {
    updateMentionAnchor(e.currentTarget.value, e.currentTarget);
  }

  // ---- files: paste / drop / picker --------------------------------------

  function handlePaste(e: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    onFiles?.(files);
  }

  function handleFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFiles?.(files);
    e.target.value = '';
  }

  function handleDragEnter(e: ReactDragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDropTarget(true);
  }
  function handleDragOver(e: ReactDragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
  }
  function handleDragLeave(e: ReactDragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDropTarget(false);
  }
  function handleDrop(e: ReactDragEvent) {
    dragDepthRef.current = 0;
    setIsDropTarget(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    onFiles?.(files);
  }

  const filteredEmoji = useMemo(() => {
    const q = emojiQuery.trim().toLowerCase();
    return q ? JIRA_COMMENT_EMOJI.filter((em) => em.name.includes(q)) : JIRA_COMMENT_EMOJI;
  }, [emojiQuery]);

  const minHeightStyle = { minHeight: `${Math.max(minRows, 1) * 1.6}em` };

  return (
    <div
      className={clsx(
        'flex flex-col overflow-visible rounded-[var(--radius-sm)] border bg-bg transition-colors motion-safe:duration-150',
        isDropTarget ? 'border-accent bg-accent-soft-bg/20' : 'border-border-strong',
        'focus-within:border-accent',
        disabled && 'opacity-60',
        className,
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b border-border bg-surface px-1.5 py-1">
        <div role="tablist" aria-label="Editor mode" className="flex items-center gap-0.5">
          <EditorTab label="Write" active={tab === 'write'} onClick={() => setTab('write')} />
          <EditorTab label="Preview" active={tab === 'preview'} onClick={() => setTab('preview')} />
        </div>
        <Toolbar
          disabled={disabled}
          hasFilesHandler={!!onFiles}
          onAttachClick={() => fileInputRef.current?.click()}
          onBold={() => runToolbarAction((t, s) => toggleWrap(t, s, '**'))}
          onItalic={() => runToolbarAction((t, s) => toggleWrap(t, s, '*'))}
          onStrike={() => runToolbarAction((t, s) => toggleWrap(t, s, '~~'))}
          onCode={() => runToolbarAction((t, s) => toggleWrap(t, s, '`'))}
          onH1={() => runToolbarAction((t, s) => toggleHeading(t, s, 1))}
          onH2={() => runToolbarAction((t, s) => toggleHeading(t, s, 2))}
          onH3={() => runToolbarAction((t, s) => toggleHeading(t, s, 3))}
          onLink={() => runToolbarAction(insertLink)}
          onTaskList={() => runToolbarAction(toggleTaskList)}
          onOrderedList={() => runToolbarAction(toggleOrderedList)}
          onBulletList={() => runToolbarAction(toggleBulletList)}
          onBlockquote={() => runToolbarAction(toggleBlockquote)}
          onHorizontalRule={() => runToolbarAction(insertHorizontalRule)}
          onTable={() => runToolbarAction(insertTable)}
          onCodeBlock={() => runToolbarAction(insertCodeBlock)}
          onEmoji={() => setEmojiOpen((v) => !v)}
          emojiOpen={emojiOpen}
        />
      </div>

      <div
        className="relative min-w-0"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {tab === 'write' ? (
          <textarea
            ref={textareaRef}
            value={value}
            disabled={disabled}
            autoFocus={autoFocus}
            placeholder={placeholder ?? 'Write a comment…'}
            aria-label={ariaLabel ?? placeholder ?? 'Comment'}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onSelect={handleSelect}
            onClick={handleSelect}
            onPaste={handlePaste}
            style={minHeightStyle}
            className="w-full resize-y bg-transparent px-3 py-2 text-sm text-text outline-none placeholder:text-text-muted"
          />
        ) : (
          <div style={minHeightStyle} className="px-3 py-2">
            {value.trim() === '' ? (
              <p className="text-sm text-text-muted">Nothing to preview yet.</p>
            ) : (
              <div
                className="copilot-md text-sm text-text-secondary"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }}
              />
            )}
          </div>
        )}

        {isDropTarget && (
          <div
            className="pointer-events-none absolute inset-1 flex items-center justify-center rounded-[var(--radius-sm)] border-2 border-dashed border-accent bg-bg/80 text-xs font-medium text-accent"
            aria-hidden="true"
          >
            Drop to attach
          </div>
        )}

        {mentionAnchor && mentionSource && (
          <div
            role="listbox"
            aria-label="Mention someone"
            className="fixed z-30 w-56 overflow-hidden rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg"
            style={mentionCoords ?? { top: 0, left: 0 }}
          >
            {mentionLoading ? (
              <div className="px-2 py-1.5 text-xs text-text-muted">Searching…</div>
            ) : mentionMatches.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-text-muted">No matches</div>
            ) : (
              mentionMatches.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={i === mentionActiveIndex}
                  onMouseEnter={() => setMentionActiveIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectMention(m);
                  }}
                  className={clsx(
                    'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text',
                    i === mentionActiveIndex ? 'bg-accent-soft-bg text-accent-soft-text' : 'hover:bg-surface-2',
                  )}
                >
                  {m.name}
                </button>
              ))
            )}
          </div>
        )}

        {emojiOpen && (
          <EmojiPanel
            query={emojiQuery}
            onQueryChange={setEmojiQuery}
            items={filteredEmoji}
            onSelect={(char) => {
              runToolbarAction((t, s) => insertText(t, s, char));
              setEmojiOpen(false);
              setEmojiQuery('');
            }}
            onClose={() => {
              setEmojiOpen(false);
              setEmojiQuery('');
            }}
          />
        )}
      </div>

      {onFiles && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          disabled={disabled}
          onChange={handleFileInputChange}
        />
      )}

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-2 py-1.5">
        <MarkdownTips open={tipsOpen} onToggle={() => setTipsOpen((v) => !v)} />
        <div className="flex items-center gap-2">{footerActions}</div>
      </div>
    </div>
  );
}

function EditorTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        'rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-medium transition-colors',
        active ? 'bg-surface-2 text-text' : 'text-text-muted hover:text-text-secondary',
      )}
    >
      {label}
    </button>
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        // See MarkdownEditor's toolbar comment: mousedown must not move
        // focus (and therefore the selection) out of the textarea before
        // the click handler reads it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={clsx(
          'flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          active ? 'bg-accent-soft-bg text-accent-soft-text' : 'hover:bg-surface-2 hover:text-text',
        )}
      >
        <Icon size={14} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

function ToolbarSeparator() {
  return <div className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true" />;
}

function Toolbar(props: {
  disabled?: boolean;
  hasFilesHandler: boolean;
  onAttachClick: () => void;
  onBold: () => void;
  onItalic: () => void;
  onStrike: () => void;
  onCode: () => void;
  onH1: () => void;
  onH2: () => void;
  onH3: () => void;
  onLink: () => void;
  onTaskList: () => void;
  onOrderedList: () => void;
  onBulletList: () => void;
  onBlockquote: () => void;
  onHorizontalRule: () => void;
  onTable: () => void;
  onCodeBlock: () => void;
  onEmoji: () => void;
  emojiOpen: boolean;
}) {
  const { disabled: dis } = props;
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5">
      <ToolbarButton icon={Heading1} label="Heading 1" disabled={dis} onClick={props.onH1} />
      <ToolbarButton icon={Heading2} label="Heading 2" disabled={dis} onClick={props.onH2} />
      <ToolbarButton icon={Heading3} label="Heading 3" disabled={dis} onClick={props.onH3} />
      <ToolbarSeparator />
      <ToolbarButton icon={Bold} label="Bold" disabled={dis} onClick={props.onBold} />
      <ToolbarButton icon={Italic} label="Italic" disabled={dis} onClick={props.onItalic} />
      <ToolbarButton icon={Code} label="Inline code" disabled={dis} onClick={props.onCode} />
      <ToolbarButton icon={LinkIcon} label="Link" disabled={dis} onClick={props.onLink} />
      <ToolbarSeparator />
      <ToolbarButton icon={ListChecks} label="Task list" disabled={dis} onClick={props.onTaskList} />
      <ToolbarButton icon={ListOrdered} label="Numbered list" disabled={dis} onClick={props.onOrderedList} />
      <ToolbarButton icon={List} label="Bullet list" disabled={dis} onClick={props.onBulletList} />
      <ToolbarSeparator />
      {props.hasFilesHandler && (
        <ToolbarButton icon={Paperclip} label="Attach file" disabled={dis} onClick={props.onAttachClick} />
      )}
      <ToolbarButton icon={Quote} label="Blockquote" disabled={dis} onClick={props.onBlockquote} />
      <ToolbarButton icon={Minus} label="Horizontal rule" disabled={dis} onClick={props.onHorizontalRule} />
      <ToolbarButton icon={Strikethrough} label="Strikethrough" disabled={dis} onClick={props.onStrike} />
      <ToolbarButton icon={TableIcon} label="Insert table" disabled={dis} onClick={props.onTable} />
      <ToolbarButton icon={Code2} label="Code block" disabled={dis} onClick={props.onCodeBlock} />
      <ToolbarButton icon={Smile} label="Emoji" active={props.emojiOpen} disabled={dis} onClick={props.onEmoji} />
    </div>
  );
}

function MarkdownTips({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
      >
        Markdown tips
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-64 rounded-[var(--radius-sm)] border border-border bg-surface p-2.5 text-xs text-text-secondary shadow-lg">
          {/* Driven by markdown.ts's own exported list, not a copy kept
              here. A hardcoded list was already wrong once: it was written
              against a renderer that could not do blockquotes, task lists
              or rules, and stayed silent about them after the renderer
              learned all three. Reading the renderer's own declaration is
              the only version of this that cannot drift. */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
            {MARKDOWN_SYNTAX_HINTS.map((hint) => (
              <Fragment key={hint.label}>
                <dt className="font-mono whitespace-pre-wrap text-text-muted">
                  {hint.syntax}
                </dt>
                <dd>{hint.label}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

function EmojiPanel({
  query,
  onQueryChange,
  items,
  onSelect,
  onClose,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  items: { char: string; name: string }[];
  onSelect: (char: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute top-2 right-2 z-30 w-64 overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface shadow-lg"
    >
      <div className="border-b border-border p-2">
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search emoji…"
          aria-label="Search emoji"
          className="w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg-inset px-2 py-1.5 text-[12.5px] text-text outline-none focus:border-accent"
        />
      </div>
      <div className="thin-scroll grid max-h-[190px] grid-cols-7 gap-0.5 overflow-y-auto p-1.5">
        {items.map((emoji) => (
          <button
            key={emoji.char}
            type="button"
            title={emoji.name}
            aria-label={emoji.name}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(emoji.char)}
            className="flex size-8 items-center justify-center rounded text-[15px] hover:bg-surface-2"
          >
            {emoji.char}
          </button>
        ))}
        {items.length === 0 && (
          <div className="col-span-7 px-1 py-3 text-center text-xs text-text-muted">No matches.</div>
        )}
      </div>
    </div>
  );
}
