import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { clsx } from 'clsx';
import {
  FileText,
  Lock,
  Archive,
  Globe2,
  Plus,
  Search,
  ArrowUpDown,
  ChevronDown,
  Check,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
} from 'lucide-react';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { createPage, deletePage, listMembers, listPages, updatePage } from '@/mock/api';
import { Avatar } from '@/components/ui/Avatar';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import type { Page } from '@/types/entities';

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

interface PageRow {
  page: Page;
  depth: 0 | 1;
}

/** Small self-contained popover: caller renders the trigger and the panel content. Mirrors the
 * pattern used in CycleListCard — there's no shared Dropdown/Menu primitive in
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

export default function PagesPage() {
  const { project } = useProject();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('public');
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('updated');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const { data: pages, loading, reload } = useAsync(() => listPages(project.id), [project.id]);
  const { data: members } = useAsync(() => listMembers(), []);

  const filtered = useMemo(() => {
    if (!pages) return [];
    const q = query.trim().toLowerCase();
    let list = pages.filter((p) => p.visibility === tab);
    if (q) list = list.filter((p) => (p.title || 'Untitled').toLowerCase().includes(q));
    return [...list].sort((a, b) =>
      sortBy === 'title'
        ? (a.title || 'Untitled').localeCompare(b.title || 'Untitled')
        : b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [pages, tab, query, sortBy]);

  // One-level tree: top-level pages (no parent, or a parent that isn't in
  // this tab) followed immediately by their direct children, indented.
  const rows = useMemo(() => {
    const idsInTab = new Set(filtered.map((p) => p.id));
    const childrenByParent = new Map<string, Page[]>();
    for (const p of filtered) {
      if (p.parentPageId && idsInTab.has(p.parentPageId)) {
        const list = childrenByParent.get(p.parentPageId) ?? [];
        list.push(p);
        childrenByParent.set(p.parentPageId, list);
      }
    }
    const roots = filtered.filter((p) => !p.parentPageId || !idsInTab.has(p.parentPageId));
    const out: PageRow[] = [];
    for (const root of roots) {
      out.push({ page: root, depth: 0 });
      for (const child of childrenByParent.get(root.id) ?? []) {
        out.push({ page: child, depth: 1 });
      }
    }
    return out;
  }, [filtered]);

  function ownerFor(page: Page) {
    return members?.find((m) => m.id === page.ownerId);
  }

  async function handleAddPage(parentPageId: string | null = null) {
    if (creating) return;
    setCreating(true);
    try {
      const page = await createPage(project.id, '', parentPageId);
      reload();
      navigate(`/projects/${project.id}/pages/${page.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleFavorite(page: Page) {
    await updatePage(page.id, { isFavorite: !page.isFavorite });
    reload();
  }

  function startRename(page: Page) {
    setRenamingId(page.id);
    setRenameValue(page.title);
  }

  async function commitRename(page: Page) {
    setRenamingId(null);
    const trimmed = renameValue.trim() || 'Untitled';
    if (trimmed === page.title) return;
    await updatePage(page.id, { title: trimmed });
    reload();
  }

  async function handleDeletePage(page: Page) {
    if (!window.confirm(`Delete "${page.title || 'Untitled'}"? This can't be undone.`)) return;
    await deletePage(page.id);
    reload();
  }

  if (!project.features.pages) {
    return (
      <EmptyState
        icon={<FileText size={28} />}
        title="Pages is disabled for this project"
        description="Turn it back on in project settings to create and browse pages."
        action={
          <Button variant="primary" onClick={() => navigate(`/projects/${project.id}/settings/features`)}>
            Go to features
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="font-display text-lg font-medium text-text">Pages</h1>
          <p className="text-sm text-text-secondary">Notes and docs for {project.name}</p>
        </div>
        <Button variant="primary" onClick={() => handleAddPage()} disabled={creating}>
          <Plus size={15} />
          {creating ? 'Creating…' : 'Add page'}
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
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder="Search pages…"
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
              <ChevronDown size={13} />
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
                  {sortBy === opt.key && <Check size={13} className="text-accent" />}
                </button>
              ))}
            </div>
          )}
        </Dropdown>
      </div>

      <div className="flex-1 overflow-y-auto thin-scroll">
        {loading && !pages ? (
          <SkeletonListRows rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<FileText size={28} />}
            title={query ? 'No pages match your search' : `No ${tab} pages yet`}
            description={
              query
                ? 'Try a different search term.'
                : tab === 'archived'
                  ? 'Pages you archive will show up here.'
                  : 'Create a page to start writing notes and docs for this project.'
            }
            action={
              !query && tab !== 'archived' ? (
                <Button variant="primary" onClick={() => handleAddPage()} disabled={creating}>
                  <Plus size={15} />
                  Add page
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(({ page, depth }) => {
              const owner = ownerFor(page);
              const isRenaming = renamingId === page.id;
              return (
                <li key={page.id} className="group flex w-full items-center gap-3 py-3 pr-3 transition-colors hover:bg-surface-2">
                  <button
                    type="button"
                    onClick={() => !isRenaming && navigate(`/projects/${project.id}/pages/${page.id}`)}
                    className={`flex min-w-0 flex-1 items-center gap-3 text-left ${
                      depth === 1 ? 'pl-14' : 'pl-6'
                    }`}
                  >
                    <span className="text-base leading-none">{page.icon || '📄'}</span>
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => commitRename(page)}
                        onKeyDown={(e) => {
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
                        {page.title || 'Untitled'}
                      </span>
                    )}
                    {owner && <Avatar name={owner.displayName} color={owner.avatarColor} size={20} />}
                    <span className="w-32 shrink-0 text-right text-xs text-text-muted">
                      Updated {formatDistanceToNow(new Date(page.updatedAt), { addSuffix: true })}
                    </span>
                  </button>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={page.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                      aria-pressed={!!page.isFavorite}
                      onClick={() => handleToggleFavorite(page)}
                      className={clsx(
                        'inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:bg-surface',
                        page.isFavorite
                          ? 'text-warning opacity-100'
                          : 'text-text-secondary opacity-0 group-hover:opacity-100 hover:text-text',
                      )}
                    >
                      <Star size={14} fill={page.isFavorite ? 'currentColor' : 'none'} />
                    </button>

                    {depth === 0 && tab !== 'archived' && (
                      <IconButton
                        label="Add sub-page"
                        onClick={() => handleAddPage(page.id)}
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <Plus size={14} />
                      </IconButton>
                    )}

                    <Dropdown
                      trigger={(toggle) => (
                        <button
                          type="button"
                          aria-label="Page actions"
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
                            icon={<Pencil size={14} />}
                            label="Rename"
                            onClick={() => {
                              close();
                              startRename(page);
                            }}
                          />
                          <MenuItem
                            icon={<Star size={14} />}
                            label={page.isFavorite ? 'Unfavorite' : 'Favorite'}
                            onClick={() => {
                              close();
                              handleToggleFavorite(page);
                            }}
                          />
                          <div className="my-1 h-px bg-border" />
                          <MenuItem
                            icon={<Trash2 size={14} />}
                            label="Delete"
                            danger
                            onClick={() => {
                              close();
                              handleDeletePage(page);
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
