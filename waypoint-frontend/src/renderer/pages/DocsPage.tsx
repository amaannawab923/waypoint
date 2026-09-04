import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { clsx } from 'clsx';
import {
  Lock,
  Archive,
  Globe2,
  ArrowUpDown,
  MoreHorizontal,
  Star,
  Trash2,
} from 'lucide-react';
import { IconFile, IconPlus, IconSearch, IconChevron, IconCheck, IconEdit } from '@/components/icons';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { createDoc, deleteDoc, listMembers, listDocs, updateDoc } from '@/data/api';
import { refreshProjectInStore } from '@/lib/projectsStore';
import { Avatar } from '@/components/ui/Avatar';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import type { Doc } from '@/types/entities';

type Tab = 'public' | 'private' | 'archived';
type SortKey = 'updated' | 'title';

const TABS: { key: Tab; label: string; icon: typeof Globe2 }[] = [
  { key: 'public', label: 'Public', icon: Globe2 },
  { key: 'private', label: 'Private', icon: Lock },
  { key: 'archived', label: 'Archived', icon: Archive },
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'updated', label: 'Date modified' },
  { key: 'title', label: 'Title A–Z' },
];

interface DocRow {
  doc: Doc;
  depth: 0 | 1;
}

/** Small self-contained popover: caller renders the trigger and the panel content. Mirrors the
 * pattern used in SprintListCard — there's no shared Dropdown/Menu primitive in
 * src/components/ui/ yet, so this stays local. */
function Dropdown({
  trigger,
  children,
  align = 'right',
}: {
  trigger: (toggle: () => void, open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && (
        <div className={clsx('absolute z-30 mt-1', align === 'right' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2',
        danger && 'text-danger hover:bg-danger-bg',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

export default function DocsPage() {
  const { project } = useProject();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('public');
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('updated');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const { data: docs, loading, reload } = useAsync(() => listDocs(project.id), [project.id]);
  const { data: members } = useAsync(() => listMembers(), []);

  const filtered = useMemo(() => {
    if (!docs) return [];
    const q = query.trim().toLowerCase();
    let list = docs.filter((p) => p.visibility === tab);
    if (q) list = list.filter((p) => (p.title || 'Untitled').toLowerCase().includes(q));
    return [...list].sort((a, b) =>
      sortBy === 'title'
        ? (a.title || 'Untitled').localeCompare(b.title || 'Untitled')
        : b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [docs, tab, query, sortBy]);

  // One-level tree: top-level docs (no parent, or a parent that isn't in
  // this tab) followed immediately by their direct children, indented.
  const rows = useMemo(() => {
    const idsInTab = new Set(filtered.map((p) => p.id));
    const childrenByParent = new Map<string, Doc[]>();
    for (const p of filtered) {
      if (p.parentDocId && idsInTab.has(p.parentDocId)) {
        const list = childrenByParent.get(p.parentDocId) ?? [];
        list.push(p);
        childrenByParent.set(p.parentDocId, list);
      }
    }
    const roots = filtered.filter((p) => !p.parentDocId || !idsInTab.has(p.parentDocId));
    const out: DocRow[] = [];
    for (const root of roots) {
      out.push({ doc: root, depth: 0 });
      for (const child of childrenByParent.get(root.id) ?? []) {
        out.push({ doc: child, depth: 1 });
      }
    }
    return out;
  }, [filtered]);

  function ownerFor(doc: Doc) {
    return members?.find((m) => m.id === doc.ownerId);
  }

  async function handleAddDoc(parentDocId: string | null = null) {
    if (creating) return;
    setCreating(true);
    try {
      const doc = await createDoc(project.id, '', parentDocId);
      reload();
      // This may be the project's first doc — refresh the shared projects
      // store so the sidebar's Docs entry (driven by
      // primitiveCounts.docs > 0) appears without a page reload.
      refreshProjectInStore(project.id);
      navigate(`/projects/${project.id}/docs/${doc.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleFavorite(doc: Doc) {
    await updateDoc(doc.id, { isFavorite: !doc.isFavorite });
    reload();
  }

  function startRename(doc: Doc) {
    setRenamingId(doc.id);
    setRenameValue(doc.title);
  }

  async function commitRename(doc: Doc) {
    setRenamingId(null);
    const trimmed = renameValue.trim() || 'Untitled';
    if (trimmed === doc.title) return;
    await updateDoc(doc.id, { title: trimmed });
    reload();
  }

  async function handleDeleteDoc(doc: Doc) {
    if (!window.confirm(`Delete "${doc.title || 'Untitled'}"? This can't be undone.`)) return;
    await deleteDoc(doc.id);
    reload();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-text-muted uppercase">Project-scoped and shared</p>
          <h1 className="font-display text-lg font-medium text-text">Docs</h1>
          <p className="text-sm text-text-secondary">
            Long-form writing that belongs to {project.name}. Personal, unfiled jottings go on the
            Scratchpad.
          </p>
        </div>
        <Button variant="primary" onClick={() => handleAddDoc()} disabled={creating}>
          <IconPlus size={15} />
          {creating ? 'Creating…' : 'Add doc'}
        </Button>
      </div>

      <div className="flex items-center gap-1 border-b border-border px-6">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
              tab === key
                ? 'border-accent text-text'
                : 'border-transparent text-text-secondary hover:text-text'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <IconSearch size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder="Search docs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full rounded-[var(--radius-sm)] border border-border-strong bg-surface pl-8 pr-3 text-sm outline-none focus:border-accent"
          />
        </div>

        <Dropdown
          align="left"
          trigger={(toggle, open) => (
            <Button variant={open ? 'secondary' : 'ghost'} size="sm" onClick={toggle}>
              <ArrowUpDown size={14} />
              {SORT_OPTIONS.find((o) => o.key === sortBy)?.label}
              <IconChevron size={13} />
            </Button>
          )}
        >
          {(close) => (
            <div className="w-44 rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => {
                    setSortBy(opt.key);
                    close();
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2"
                >
                  {opt.label}
                  {sortBy === opt.key && <IconCheck size={13} className="text-accent" />}
                </button>
              ))}
            </div>
          )}
        </Dropdown>
      </div>

      <div className="flex-1 overflow-y-auto thin-scroll">
        {loading && !docs ? (
          <SkeletonListRows rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<IconFile size={28} />}
            title={query ? 'No docs match your search' : `No ${tab} docs yet`}
            description={
              query
                ? 'Try a different search term.'
                : tab === 'archived'
                  ? 'Docs you archive will show up here.'
                  : 'Create a doc to start writing specs, runbooks, or notes for this project.'
            }
            action={
              !query && tab !== 'archived' ? (
                <Button variant="primary" onClick={() => handleAddDoc()} disabled={creating}>
                  <IconPlus size={15} />
                  Add doc
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(({ doc, depth }) => {
              const owner = ownerFor(doc);
              const isRenaming = renamingId === doc.id;
              return (
                <li key={doc.id} className="group flex w-full items-center gap-3 py-3 pr-3 transition-colors hover:bg-surface-2">
                  {/* A <button> row wrapping the rename <input> — itself a real
                      focusable form control — nested interactive content inside
                      a <button>, invalid HTML with real click/focus-target risk.
                      Same role="button"/tabIndex/Enter-key pattern used for the
                      row-as-button case elsewhere in this PR (Agents.tsx,
                      States.tsx), so the input stays a sibling, not a
                      descendant, of any button. */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => !isRenaming && navigate(`/projects/${project.id}/docs/${doc.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isRenaming) navigate(`/projects/${project.id}/docs/${doc.id}`);
                    }}
                    className={`flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left ${
                      depth === 1 ? 'pl-14' : 'pl-6'
                    }`}
                  >
                    <span className="text-base leading-none">{doc.icon || '📄'}</span>
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => commitRename(doc)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          } else if (e.key === 'Escape') {
                            setRenamingId(null);
                          }
                        }}
                        className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-1.5 py-0.5 text-sm font-medium text-text outline-none focus:border-accent"
                      />
                    ) : (
                      <span className="flex-1 truncate text-sm font-medium text-text">
                        {doc.title || 'Untitled'}
                      </span>
                    )}
                    {owner && <Avatar name={owner.displayName} color={owner.avatarColor} size={20} />}
                    <span className="w-32 shrink-0 text-right text-xs text-text-muted">
                      Updated {formatDistanceToNow(new Date(doc.updatedAt), { addSuffix: true })}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={doc.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                      aria-pressed={!!doc.isFavorite}
                      onClick={() => handleToggleFavorite(doc)}
                      className={clsx(
                        'inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:bg-surface',
                        doc.isFavorite
                          ? 'text-warning opacity-100'
                          : 'text-text-secondary opacity-0 group-hover:opacity-100 hover:text-text',
                      )}
                    >
                      <Star size={14} fill={doc.isFavorite ? 'currentColor' : 'none'} />
                    </button>

                    {depth === 0 && tab !== 'archived' && (
                      <IconButton
                        label="Add sub-doc"
                        onClick={() => handleAddDoc(doc.id)}
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <IconPlus size={14} />
                      </IconButton>
                    )}

                    <Dropdown
                      trigger={(toggle) => (
                        <button
                          type="button"
                          aria-label="Doc actions"
                          onClick={toggle}
                          className="inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary opacity-0 transition-colors hover:bg-surface hover:text-text group-hover:opacity-100"
                        >
                          <MoreHorizontal size={16} />
                        </button>
                      )}
                    >
                      {(close) => (
                        <div className="w-40 rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg">
                          <MenuItem
                            icon={<IconEdit size={14} />}
                            label="Rename"
                            onClick={() => {
                              close();
                              startRename(doc);
                            }}
                          />
                          <MenuItem
                            icon={<Star size={14} />}
                            label={doc.isFavorite ? 'Unfavorite' : 'Favorite'}
                            onClick={() => {
                              close();
                              handleToggleFavorite(doc);
                            }}
                          />
                          <div className="my-1 h-px bg-border" />
                          <MenuItem
                            icon={<Trash2 size={14} />}
                            label="Delete"
                            danger
                            onClick={() => {
                              close();
                              handleDeleteDoc(doc);
                            }}
                          />
                        </div>
                      )}
                    </Dropdown>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
