import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Blockquote } from '@tiptap/extension-blockquote';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Table as TableIcon,
  Quote,
  Info,
  Code2,
  ArrowLeft,
  Star,
  Lock,
  Unlock,
  Link2,
  Archive,
  ArchiveRestore,
  Trash2,
  Check,
} from 'lucide-react';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { useRecordRecent } from '@/lib/recents';
import { deletePage, getPage, updatePage } from '@/data/api';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import type { Page } from '@/types/entities';

type SaveStatus = 'idle' | 'saving' | 'saved';

// Lightweight callout/info-box block: the same Blockquote node used for regular
// quotes, plus an optional `callout` attribute. When set, the editor CSS below
// renders it with an emoji, colored left border, and tinted background instead
// of the plain italic blockquote style. Avoids introducing a brand-new node type.
const Callout = Blockquote.extend({
  addAttributes() {
    return {
      callout: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-callout'),
        renderHTML: (attributes) => (attributes.callout ? { 'data-callout': attributes.callout } : {}),
      },
    };
  },
});

function toggleCallout(editor: Editor) {
  if (editor.isActive('blockquote', { callout: 'info' })) {
    editor.chain().focus().lift('blockquote').run();
  } else if (editor.isActive('blockquote')) {
    editor.chain().focus().updateAttributes('blockquote', { callout: 'info' }).run();
  } else {
    editor
      .chain()
      .focus()
      .setBlockquote()
      .updateAttributes('blockquote', { callout: 'info' })
      .insertContent('💡 ')
      .run();
  }
}

const ICON_OPTIONS = [
  '📄', '📝', '📋', '📚', '📖', '🗒️', '🗓️', '📌', '📎', '🔖',
  '💡', '🎯', '🚀', '🧭', '🛠️', '⚙️', '🔧', '📇', '📊', '📈',
  '🗂️', '🧩', '✅', '⭐', '🔥', '💬', '🎨', '🧠', '📦', '🔒',
  '🌐', '🧪', '🔬', '📅', '🏷️', '📁', '🖇️', '🧾', '📐', '🎉',
];

type SlashItem = {
  key: string;
  label: string;
  icon: typeof Heading2;
  run: (editor: Editor) => void;
};

const SLASH_ITEMS: SlashItem[] = [
  {
    key: 'heading2',
    label: 'Heading 2',
    icon: Heading2,
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    key: 'heading3',
    label: 'Heading 3',
    icon: Heading3,
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    key: 'bulletList',
    label: 'Bullet list',
    icon: List,
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    key: 'orderedList',
    label: 'Numbered list',
    icon: ListOrdered,
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    key: 'blockquote',
    label: 'Blockquote',
    icon: Quote,
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    key: 'callout',
    label: 'Callout',
    icon: Info,
    run: (editor) => toggleCallout(editor),
  },
  {
    key: 'codeBlock',
    label: 'Code block',
    icon: Code2,
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
];

interface SlashMenuState {
  query: string;
  from: number;
  to: number;
  top: number;
  left: number;
}

function computeSlashMenuState(editor: Editor): SlashMenuState | null {
  if (!editor.isEditable) return null;
  const { state, view } = editor;
  const { $from, empty } = state.selection;
  if (!empty) return null;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const match = /^\/(\w*)$/.exec(textBefore);
  if (!match) return null;
  const from = $from.pos - match[0].length;
  const to = $from.pos;
  const coords = view.coordsAtPos(to);
  return { query: match[1], from, to, top: coords.bottom + 6, left: coords.left };
}

export default function PageDetailPage() {
  const { project } = useProject();
  const { pageId = '' } = useParams();
  const navigate = useNavigate();

  const { data: page, loading } = useAsync(() => getPage(pageId), [pageId]);

  useRecordRecent(
    page
      ? {
          type: 'page',
          id: page.id,
          title: page.title || 'Untitled',
          projectId: page.projectId,
          path: `/projects/${page.projectId}/pages/${page.id}`,
        }
      : null,
  );

  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState('📄');
  const [visibility, setVisibility] = useState<Page['visibility']>('private');
  const [isFavorite, setIsFavorite] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedPageId = useRef<string | null>(null);
  const prevVisibilityRef = useRef<'public' | 'private'>('private');
  const iconPickerRef = useRef<HTMLDivElement | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ blockquote: false }),
      Callout,
      Placeholder.configure({ placeholder: 'Write something, or type "/" for commands…' }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: '',
    editable: true,
    onUpdate: ({ editor: e }) => {
      setStatus('saving');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void updatePage(pageId, { contentHtml: e.getHTML() }).then(() => setStatus('saved'));
      }, 800);
      setSlashMenu(computeSlashMenuState(e));
    },
    onSelectionUpdate: ({ editor: e }) => {
      setSlashMenu(computeSlashMenuState(e));
    },
    onBlur: () => setSlashMenu(null),
  });

  const filteredSlashItems = useMemo(() => {
    if (!slashMenu) return [];
    const q = slashMenu.query.toLowerCase();
    return SLASH_ITEMS.filter((item) => item.label.toLowerCase().includes(q));
  }, [slashMenu]);

  function selectSlashItem(item: SlashItem) {
    if (!editor || !slashMenu) return;
    editor.chain().focus().deleteRange({ from: slashMenu.from, to: slashMenu.to }).run();
    item.run(editor);
    setSlashMenu(null);
  }

  // Close the slash menu on Escape, and pick the top match on Enter, without
  // letting ProseMirror's own Enter (new paragraph) handler run first.
  useEffect(() => {
    if (!slashMenu || !editor) return;
    const dom = editor.view.dom;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashMenu(null);
      } else if (e.key === 'Enter') {
        const top = filteredSlashItems[0];
        if (top) {
          e.preventDefault();
          selectSlashItem(top);
        }
      }
    }
    dom.addEventListener('keydown', onKeyDown, true);
    return () => dom.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashMenu, editor, filteredSlashItems]);

  // Load page content into the editor once, whenever we navigate to a new page.
  useEffect(() => {
    if (!page || !editor) return;
    if (loadedPageId.current === page.id) return;
    loadedPageId.current = page.id;
    editor.commands.setContent(page.contentHtml || '<p></p>');
    setTitle(page.title);
    setIcon(page.icon || '📄');
    setVisibility(page.visibility);
    // Seed the "restore on unarchive" ref per-page so it never carries over a
    // previously-viewed page's value. If this page is already archived, there's
    // no persisted record of what it was before, so fall back to 'private'.
    prevVisibilityRef.current = page.visibility === 'archived' ? 'private' : page.visibility;
    setIsFavorite(!!page.isFavorite);
    setIsLocked(!!page.isLocked);
    setStatus('idle');
  }, [page, editor]);

  useEffect(() => {
    editor?.setEditable(!isLocked);
  }, [isLocked, editor]);

  useEffect(() => {
    if (!iconPickerOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (iconPickerRef.current && !iconPickerRef.current.contains(e.target as Node)) {
        setIconPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [iconPickerOpen]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  async function handleTitleBlur() {
    if (!page) return;
    const trimmed = title.trim() || 'Untitled';
    if (trimmed === page.title) return;
    setStatus('saving');
    await updatePage(page.id, { title: trimmed });
    setStatus('saved');
  }

  async function handleIconSelect(next: string) {
    if (!page) return;
    setIcon(next);
    setIconPickerOpen(false);
    setStatus('saving');
    await updatePage(page.id, { icon: next });
    setStatus('saved');
  }

  async function handleToggleFavorite() {
    if (!page) return;
    const next = !isFavorite;
    setIsFavorite(next);
    setStatus('saving');
    await updatePage(page.id, { isFavorite: next });
    setStatus('saved');
  }

  async function handleToggleLocked() {
    if (!page) return;
    const next = !isLocked;
    setIsLocked(next);
    setStatus('saving');
    await updatePage(page.id, { isLocked: next });
    setStatus('saved');
  }

  async function handleToggleArchived() {
    if (!page) return;
    const isCurrentlyArchived = visibility === 'archived';
    // Capture the visibility that's actually in effect right now, at the exact
    // moment Archive fires, so Unarchive always restores it — not via a
    // reactive effect keyed on `visibility`, which can miss or misattribute
    // the transition (e.g. across page navigations or a fresh page load).
    if (!isCurrentlyArchived) {
      prevVisibilityRef.current = visibility;
    }
    const next: Page['visibility'] = isCurrentlyArchived ? prevVisibilityRef.current : 'archived';
    setVisibility(next);
    setStatus('saving');
    await updatePage(page.id, { visibility: next });
    setStatus('saved');
  }

  async function handleDeletePage() {
    if (!page) return;
    if (!window.confirm(`Delete "${page.title || 'Untitled'}"? This can't be undone.`)) return;
    await deletePage(page.id);
    navigate(`/projects/${project.id}/pages`);
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the browser; fail silently.
    }
  }

  if (loading && !page) {
    const lineWidths = ['100%', '92%', '96%', '70%', '100%', '85%', '60%'];
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-border px-6 py-3">
          <Skeleton.Block height="1.75rem" width="1.75rem" rounded="rounded-[var(--radius-sm)]" />
          <div className="ml-auto flex items-center gap-1">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton.Block key={index} height="1.75rem" width="1.75rem" rounded="rounded-[var(--radius-sm)]" />
            ))}
          </div>
        </div>
        <Skeleton className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-8">
          <Skeleton.Block height="2.25rem" width="2.25rem" rounded="rounded-[var(--radius-sm)]" className="mb-2" />
          <Skeleton.Block height="2.25rem" width="60%" className="mb-8" />
          <div className="flex flex-col gap-3">
            {lineWidths.map((width, index) => (
              <Skeleton.Block key={index} height="0.875rem" width={width} />
            ))}
          </div>
        </Skeleton>
      </div>
    );
  }

  if (!page) {
    return <EmptyState title="Page not found" description="It may have been deleted." />;
  }

  const isArchived = visibility === 'archived';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <IconButton label="Back to pages" onClick={() => navigate(`/projects/${project.id}/pages`)}>
          <ArrowLeft size={16} />
        </IconButton>
        <span className="text-xs text-text-muted">
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ' '}
        </span>
        {copied && <span className="text-xs text-accent">Link copied</span>}

        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            onClick={handleToggleFavorite}
            className={isFavorite ? 'text-accent' : undefined}
          >
            <Star size={15} fill={isFavorite ? 'currentColor' : 'none'} />
          </IconButton>
          <IconButton
            label={isLocked ? 'Unlock page' : 'Lock page'}
            onClick={handleToggleLocked}
            className={isLocked ? 'text-accent' : undefined}
          >
            {isLocked ? <Lock size={15} /> : <Unlock size={15} />}
          </IconButton>
          <IconButton label="Copy link" onClick={handleCopyLink}>
            {copied ? <Check size={15} /> : <Link2 size={15} />}
          </IconButton>
          <IconButton
            label={isArchived ? 'Unarchive page' : 'Archive page'}
            onClick={handleToggleArchived}
            className={isArchived ? 'text-accent' : undefined}
          >
            {isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
          </IconButton>
          <IconButton label="Delete page" onClick={handleDeletePage} className="hover:text-danger">
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-y-auto thin-scroll px-6 py-8">
        <div className="relative mb-2 flex items-center gap-2 text-2xl leading-none" ref={iconPickerRef}>
          <button
            type="button"
            onClick={() => setIconPickerOpen((v) => !v)}
            className="cursor-pointer rounded-[var(--radius-sm)] p-1 leading-none transition-colors hover:bg-surface-2"
            aria-label="Change page icon"
          >
            {icon}
          </button>
          {iconPickerOpen && (
            <div className="absolute top-full left-0 z-20 mt-1 grid w-64 grid-cols-8 gap-0.5 rounded-[var(--radius-sm)] border border-border bg-surface p-2 shadow-lg">
              {ICON_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => handleIconSelect(opt)}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-lg leading-none hover:bg-surface-2"
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          readOnly={isLocked}
          placeholder="Untitled"
          className="mb-6 w-full border-none bg-transparent font-display text-3xl font-semibold text-text outline-none placeholder:text-text-muted"
        />

        {!isLocked && <EditorToolbar editor={editor} />}

        <div className="mt-3 flex-1">
          <EditorContent editor={editor} className="wp-editor" />
        </div>
      </div>

      {slashMenu && filteredSlashItems.length > 0 && (
        <div
          className="fixed z-30 w-56 rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg"
          style={{ top: slashMenu.top, left: slashMenu.left }}
        >
          {filteredSlashItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                selectSlashItem(item);
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2"
            >
              <item.icon size={14} className="text-text-muted" />
              {item.label}
            </button>
          ))}
        </div>
      )}

      <style>{`
        .wp-editor .ProseMirror {
          outline: none;
          min-height: 50vh;
          font-size: 0.9375rem;
          line-height: 1.7;
          color: var(--text);
        }
        .wp-editor .ProseMirror p { margin: 0.5em 0; }
        .wp-editor .ProseMirror h2 {
          margin: 1.5em 0 0.4em;
          font-family: var(--font-display);
          font-size: 1.25rem;
          font-weight: 600;
        }
        .wp-editor .ProseMirror h3 {
          margin: 1.25em 0 0.4em;
          font-family: var(--font-display);
          font-size: 1.05rem;
          font-weight: 600;
        }
        .wp-editor .ProseMirror ul { margin: 0.5em 0; padding-left: 1.4em; list-style: disc; }
        .wp-editor .ProseMirror ol { margin: 0.5em 0; padding-left: 1.4em; list-style: decimal; }
        .wp-editor .ProseMirror li { margin: 0.2em 0; }
        .wp-editor .ProseMirror blockquote {
          margin: 1em 0;
          padding: 0.1em 0 0.1em 1em;
          border-left: 3px solid var(--border-strong);
          color: var(--text-secondary);
          font-style: italic;
        }
        .wp-editor .ProseMirror blockquote[data-callout] {
          padding: 0.6em 0.9em;
          border-left: 3px solid var(--accent);
          border-radius: var(--radius-sm);
          background: var(--accent-soft-bg);
          color: var(--accent-soft-text);
          font-style: normal;
        }
        .wp-editor .ProseMirror pre {
          margin: 1em 0;
          padding: 0.75em 1em;
          border-radius: var(--radius-sm);
          background: var(--surface-2);
          font-family: var(--font-mono);
          font-size: 0.85em;
          overflow-x: auto;
        }
        .wp-editor .ProseMirror pre code {
          padding: 0;
          background: none;
          color: inherit;
        }
        .wp-editor .ProseMirror code {
          padding: 0.1em 0.35em;
          border-radius: 4px;
          background: var(--surface-2);
          font-family: var(--font-mono);
          font-size: 0.85em;
        }
        .wp-editor .ProseMirror table {
          border-collapse: collapse;
          margin: 1em 0;
          width: 100%;
        }
        .wp-editor .ProseMirror td,
        .wp-editor .ProseMirror th {
          border: 1px solid var(--border);
          padding: 0.4em 0.6em;
          text-align: left;
          vertical-align: top;
        }
        .wp-editor .ProseMirror th {
          background: var(--surface-2);
          font-weight: 600;
        }
        .wp-editor .ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          height: 0;
          color: var(--text-muted);
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}

function EditorToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;

  const items: {
    icon: typeof Bold;
    label: string;
    active: boolean;
    onClick: () => void;
  }[] = [
    {
      icon: Bold,
      label: 'Bold',
      active: editor.isActive('bold'),
      onClick: () => editor.chain().focus().toggleBold().run(),
    },
    {
      icon: Italic,
      label: 'Italic',
      active: editor.isActive('italic'),
      onClick: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      icon: UnderlineIcon,
      label: 'Underline',
      active: editor.isActive('underline'),
      onClick: () => editor.chain().focus().toggleUnderline().run(),
    },
    {
      icon: Strikethrough,
      label: 'Strikethrough',
      active: editor.isActive('strike'),
      onClick: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      icon: Heading2,
      label: 'Heading 2',
      active: editor.isActive('heading', { level: 2 }),
      onClick: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      icon: Heading3,
      label: 'Heading 3',
      active: editor.isActive('heading', { level: 3 }),
      onClick: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    {
      icon: List,
      label: 'Bullet list',
      active: editor.isActive('bulletList'),
      onClick: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      icon: ListOrdered,
      label: 'Ordered list',
      active: editor.isActive('orderedList'),
      onClick: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      icon: Quote,
      label: 'Blockquote',
      active: editor.isActive('blockquote'),
      onClick: () => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      icon: Info,
      label: 'Callout',
      active: editor.isActive('blockquote', { callout: 'info' }),
      onClick: () => toggleCallout(editor),
    },
    {
      icon: Code2,
      label: 'Code block',
      active: editor.isActive('codeBlock'),
      onClick: () => editor.chain().focus().toggleCodeBlock().run(),
    },
    {
      icon: TableIcon,
      label: 'Insert table',
      active: editor.isActive('table'),
      onClick: () =>
        editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
  ];

  return (
    <div className="sticky top-0 z-10 flex items-center gap-0.5 rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-sm">
      {items.map(({ icon: Icon, label, active, onClick }) => (
        <IconButton
          key={label}
          label={label}
          onClick={onClick}
          className={active ? 'bg-accent-soft-bg text-accent-soft-text' : undefined}
        >
          <Icon size={15} />
        </IconButton>
      ))}
    </div>
  );
}
