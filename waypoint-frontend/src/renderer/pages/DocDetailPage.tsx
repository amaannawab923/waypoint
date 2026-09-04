import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { clsx } from 'clsx';
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
  Archive,
  ArchiveRestore,
  Trash2,
} from 'lucide-react';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { useRecordRecent } from '@/lib/recents';
import { deleteDoc, getDoc, updateDoc } from '@/data/api';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import type { Doc } from '@/types/entities';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

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

export default function DocDetailPage() {
  const { project } = useProject();
  const { docId = '' } = useParams();
  const navigate = useNavigate();

  const { data: doc, loading } = useAsync(() => getDoc(docId), [docId]);

  useRecordRecent(
    doc
      ? {
          type: 'doc',
          id: doc.id,
          title: doc.title || 'Untitled',
          projectId: doc.projectId,
          path: `/projects/${doc.projectId}/docs/${doc.id}`,
        }
      : null,
  );

  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState('📄');
  const [visibility, setVisibility] = useState<Doc['visibility']>('private');
  const [isFavorite, setIsFavorite] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedDocId = useRef<string | null>(null);
  const prevVisibilityRef = useRef<'public' | 'private'>('private');
  const iconPickerRef = useRef<HTMLDivElement | null>(null);
  // Kept in sync every render (see the assignment right after `useEditor`
  // below) so the docId-change and unmount flush effects can read the
  // editor's CURRENT content without depending on `editor` identity —
  // useEditor's own instance is stable for the component's lifetime, but
  // reading through a ref keeps the flush logic robust to that changing.
  const editorRef = useRef<Editor | null>(null);

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
        saveTimer.current = null;
        void updateDoc(docId, { contentHtml: e.getHTML() })
          .then(() => setStatus('saved'))
          .catch(() => setStatus('error'));
      }, 800);
      setSlashMenu(computeSlashMenuState(e));
    },
    onSelectionUpdate: ({ editor: e }) => {
      setSlashMenu(computeSlashMenuState(e));
    },
    onBlur: () => setSlashMenu(null),
  });
  editorRef.current = editor ?? null;

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

  // Flush any pending debounced save from the doc we're navigating AWAY
  // from, before the "load new doc content" effect below overwrites the
  // editor's live buffer. Navigating from doc A to doc B does NOT unmount
  // this component (both routes resolve to the same route element — only
  // the `:docId` param changes), so a pending 800ms save timer scheduled
  // while editing A is still armed when B's `docId` lands here. Left
  // alone, that timer would eventually fire and call
  // `updateDoc(<A's id>, { contentHtml: editor.getHTML() })` — but by then
  // `editor.getHTML()` reads B's content (the same editor instance, now
  // showing B), silently overwriting A with B's text. `loadedDocId.current`
  // still holds A's id here because the content-load effect below (which
  // advances it to B) only runs once `doc` itself updates — and `doc` is
  // driven by an async `getDoc(docId)` fetch that hasn't resolved yet in
  // this same render, so this effect always gets to flush first.
  useEffect(() => {
    const previousDocId = loadedDocId.current;
    if (!previousDocId || previousDocId === docId) return;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const pendingEditor = editorRef.current;
      if (pendingEditor) {
        // Deliberately doesn't touch `status`: by the time this flush
        // settles, the status indicator in the header belongs to the doc
        // we've already navigated TO (driven by the content-load effect
        // below), not the one this flush is saving. Surfacing this save's
        // outcome there would misattribute it. Still explicitly caught
        // (matching the unmount flush below) so a failure can't produce an
        // unhandled rejection.
        void updateDoc(previousDocId, { contentHtml: pendingEditor.getHTML() }).catch(() => {});
      }
    }
  }, [docId]);

  // Load doc content into the editor once, whenever we navigate to a new doc.
  useEffect(() => {
    if (!doc || !editor) return;
    if (loadedDocId.current === doc.id) return;
    loadedDocId.current = doc.id;
    // emitUpdate must be false here: Tiptap v3's setContent defaults it to
    // true, which fires onUpdate (and therefore the autosave below) just
    // from loading a doc into the editor, bumping updatedAt on a pure view.
    editor.commands.setContent(doc.contentHtml || '<p></p>', { emitUpdate: false });
    setTitle(doc.title);
    setIcon(doc.icon || '📄');
    setVisibility(doc.visibility);
    // Seed the "restore on unarchive" ref per-doc so it never carries over a
    // previously-viewed doc's value. If this doc is already archived, there's
    // no persisted record of what it was before, so fall back to 'private'.
    prevVisibilityRef.current = doc.visibility === 'archived' ? 'private' : doc.visibility;
    setIsFavorite(!!doc.isFavorite);
    setIsLocked(!!doc.isLocked);
    setStatus('idle');
  }, [doc, editor]);

  useEffect(() => {
    // Tiptap v3's setEditable defaults emitUpdate to true and emits an
    // "update" event unconditionally (it doesn't check whether the doc
    // actually changed). That fires the autosave in onUpdate below, so
    // this effect alone would bump updatedAt on mount and on every lock
    // toggle even though it never touches content. Pass emitUpdate: false;
    // handleToggleLocked already persists the lock state explicitly.
    editor?.setEditable(!isLocked, false);
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

  // On actual unmount (not a docId change — that's handled above), flush
  // any still-pending debounced save instead of just discarding it, so
  // navigating away from the doc editor entirely (e.g. "Back to docs")
  // within the 800ms debounce window doesn't silently drop the last edit
  // despite the UI's last visible state having claimed "Saving…".
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const pendingEditor = editorRef.current;
        const pendingDocId = loadedDocId.current;
        if (pendingEditor && pendingDocId) {
          // Fire-and-forget: the component is unmounting, so there's no
          // local state left to update on success/failure — still swallow
          // the rejection explicitly rather than letting it go unhandled.
          void updateDoc(pendingDocId, { contentHtml: pendingEditor.getHTML() }).catch(() => {});
        }
      }
    };
  }, []);

  async function handleTitleBlur() {
    if (!doc) return;
    const trimmed = title.trim() || 'Untitled';
    if (trimmed === doc.title) return;
    setStatus('saving');
    await updateDoc(doc.id, { title: trimmed });
    setStatus('saved');
  }

  async function handleIconSelect(next: string) {
    if (!doc) return;
    setIcon(next);
    setIconPickerOpen(false);
    setStatus('saving');
    await updateDoc(doc.id, { icon: next });
    setStatus('saved');
  }

  async function handleToggleFavorite() {
    if (!doc) return;
    const previous = isFavorite;
    const next = !isFavorite;
    setIsFavorite(next);
    setStatus('saving');
    try {
      await updateDoc(doc.id, { isFavorite: next });
      setStatus('saved');
    } catch {
      // Save failed (the shared HTTP client already surfaced a toast) —
      // revert so the toggle's visible state matches what's actually
      // persisted, instead of looking saved when it isn't.
      setIsFavorite(previous);
      setStatus('error');
    }
  }

  async function handleToggleLocked() {
    if (!doc) return;
    const previous = isLocked;
    const next = !isLocked;
    setIsLocked(next);
    setStatus('saving');
    try {
      await updateDoc(doc.id, { isLocked: next });
      setStatus('saved');
    } catch {
      setIsLocked(previous);
      setStatus('error');
    }
  }

  async function handleToggleArchived() {
    if (!doc) return;
    const previous = visibility;
    const isCurrentlyArchived = visibility === 'archived';
    // Capture the visibility that's actually in effect right now, at the exact
    // moment Archive fires, so Unarchive always restores it — not via a
    // reactive effect keyed on `visibility`, which can miss or misattribute
    // the transition (e.g. across doc navigations or a fresh page load).
    if (!isCurrentlyArchived) {
      prevVisibilityRef.current = visibility;
    }
    const next: Doc['visibility'] = isCurrentlyArchived ? prevVisibilityRef.current : 'archived';
    setVisibility(next);
    setStatus('saving');
    try {
      await updateDoc(doc.id, { visibility: next });
      setStatus('saved');
    } catch {
      // Save failed (the shared HTTP client already surfaced a toast) —
      // revert so the control's visible state matches what's actually
      // persisted, instead of looking saved when it isn't. No need to also
      // roll back prevVisibilityRef: it was set to `previous` (the same
      // value visibility reverts to) above, so it's already correct for a
      // retried Archive.
      setVisibility(previous);
      setStatus('error');
    }
  }

  async function handleDeleteDoc() {
    if (!doc) return;
    if (!window.confirm(`Delete "${doc.title || 'Untitled'}"? This can't be undone.`)) return;
    await deleteDoc(doc.id);
    navigate(`/projects/${project.id}/docs`);
  }

  if (loading && !doc) {
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

  if (!doc) {
    return <EmptyState title="Doc not found" description="It may have been deleted." />;
  }

  const isArchived = visibility === 'archived';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <IconButton label="Back to docs" onClick={() => navigate(`/projects/${project.id}/docs`)}>
          <ArrowLeft size={16} />
        </IconButton>
        <span className={clsx('text-xs', status === 'error' ? 'text-danger' : 'text-text-muted')}>
          {status === 'saving'
            ? 'Saving…'
            : status === 'saved'
              ? 'Saved'
              : status === 'error'
                ? 'Failed to save'
                : ' '}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            onClick={handleToggleFavorite}
            className={isFavorite ? 'text-accent' : undefined}
          >
            <Star size={15} fill={isFavorite ? 'currentColor' : 'none'} />
          </IconButton>
          <IconButton
            label={isLocked ? 'Unlock doc' : 'Lock doc'}
            onClick={handleToggleLocked}
            className={isLocked ? 'text-accent' : undefined}
          >
            {isLocked ? <Lock size={15} /> : <Unlock size={15} />}
          </IconButton>
          <IconButton
            label={isArchived ? 'Unarchive doc' : 'Archive doc'}
            onClick={handleToggleArchived}
            className={isArchived ? 'text-accent' : undefined}
          >
            {isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
          </IconButton>
          <IconButton label="Delete doc" onClick={handleDeleteDoc} className="hover:text-danger">
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
            aria-label="Change doc icon"
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
