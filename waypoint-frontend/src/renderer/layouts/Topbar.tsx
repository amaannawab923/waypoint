import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Bell,
  Plus,
  X,
  LayoutList,
  FileText,
  FolderKanban,
  RefreshCw,
  Boxes,
  Settings,
  LogOut,
  Sun,
  Moon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useAsync } from '@/lib/useAsync';
import {
  getCurrentUser,
  listNotifications,
  listProjects,
  listAllWorkItems,
  listAllPages,
  listAllCycles,
  listAllModules,
} from '@/mock/api';
import { Avatar } from '@/components/ui/Avatar';
import { CreateWorkItemModal } from '@/components/domain/CreateWorkItemModal';
import { Tooltip } from '@/components/ui/Tooltip';
import { markOnboarding } from '@/lib/onboarding';
import { useTheme } from '@/lib/theme';
import type { Project, WorkItem, Page, Cycle, WorkModule } from '@/types/entities';

/** Small self-contained popover, mirrors the local Dropdown pattern used in
 * CycleListCard.tsx — there's no shared Dropdown/Menu primitive in
 * src/components/ui/ yet. */
function AccountMenu({
  trigger,
  children,
}: {
  trigger: (toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
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
      {trigger(() => setOpen((o) => !o))}
      {open && <div className="absolute right-0 z-30 mt-1">{children(() => setOpen(false))}</div>}
    </div>
  );
}

function AccountMenuItem({
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

interface SearchResult {
  key: string;
  title: string;
  subtitle?: string;
  path: string;
}

interface SearchGroup {
  label: string;
  icon: typeof LayoutList;
  results: SearchResult[];
}

const RESULT_LIMIT = 6;

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

function SearchPalette({
  open,
  onClose,
  projects,
  workItems,
  pages,
  cycles,
  modules,
}: {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  workItems: WorkItem[];
  pages: Page[];
  cycles: Cycle[];
  modules: WorkModule[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const projectNameById = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  const groups = useMemo<SearchGroup[]>(() => {
    const q = query.trim();
    if (!q) return [];

    const workItemResults: SearchResult[] = workItems
      .filter((w) => matches(w.title, q) || matches(w.identifier, q))
      .slice(0, RESULT_LIMIT)
      .map((w) => ({
        key: `work-item:${w.id}`,
        title: w.title,
        subtitle: `${w.identifier} · ${projectNameById.get(w.projectId) ?? ''}`,
        path: `/projects/${w.projectId}/work-items/${w.identifier}`,
      }));

    const pageResults: SearchResult[] = pages
      .filter((p) => matches(p.title || 'Untitled', q))
      .slice(0, RESULT_LIMIT)
      .map((p) => ({
        key: `page:${p.id}`,
        title: p.title || 'Untitled',
        subtitle: projectNameById.get(p.projectId) ?? '',
        path: `/projects/${p.projectId}/pages/${p.id}`,
      }));

    const projectResults: SearchResult[] = projects
      .filter((p) => matches(p.name, q) || matches(p.identifier, q))
      .slice(0, RESULT_LIMIT)
      .map((p) => ({
        key: `project:${p.id}`,
        title: p.name,
        subtitle: p.identifier,
        path: `/projects/${p.id}/work-items`,
      }));

    const cycleResults: SearchResult[] = cycles
      .filter((c) => matches(c.name, q))
      .slice(0, RESULT_LIMIT)
      .map((c) => ({
        key: `cycle:${c.id}`,
        title: c.name,
        subtitle: projectNameById.get(c.projectId) ?? '',
        path: `/projects/${c.projectId}/cycles/${c.id}`,
      }));

    const moduleResults: SearchResult[] = modules
      .filter((m) => matches(m.name, q))
      .slice(0, RESULT_LIMIT)
      .map((m) => ({
        key: `module:${m.id}`,
        title: m.name,
        subtitle: projectNameById.get(m.projectId) ?? '',
        path: `/projects/${m.projectId}/modules/${m.id}`,
      }));

    return [
      { label: 'Work items', icon: LayoutList, results: workItemResults },
      { label: 'Pages', icon: FileText, results: pageResults },
      { label: 'Projects', icon: FolderKanban, results: projectResults },
      { label: 'Cycles', icon: RefreshCw, results: cycleResults },
      { label: 'Modules', icon: Boxes, results: moduleResults },
    ].filter((g) => g.results.length > 0);
  }, [query, projects, workItems, pages, cycles, modules, projectNameById]);

  if (!open) return null;

  function go(path: string) {
    onClose();
    navigate(path);
  }

  const hasQuery = query.trim().length > 0;
  const hasResults = groups.length > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="thin-scroll max-h-[70vh] w-full max-w-xl overflow-y-auto rounded-[var(--radius-lg)] border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Search size={16} className="shrink-0 text-text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const first = groups[0]?.results[0];
                if (first) go(first.path);
              }
            }}
            placeholder="Search work items, pages, projects, cycles, modules…"
            className="h-6 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="flex size-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text"
          >
            <X size={14} />
          </button>
        </div>

        <div className="p-2">
          {!hasQuery && (
            <p className="px-2 py-6 text-center text-sm text-text-muted">
              Search across work items, pages, projects, cycles, and modules.
            </p>
          )}
          {hasQuery && !hasResults && (
            <p className="px-2 py-6 text-center text-sm text-text-muted">No results for "{query}".</p>
          )}
          {groups.map((group) => (
            <div key={group.label} className="mb-1 last:mb-0">
              <p className="px-2 pt-2 pb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">
                {group.label}
              </p>
              {group.results.map((result) => (
                <button
                  key={result.key}
                  type="button"
                  onClick={() => go(result.path)}
                  className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-2 text-left hover:bg-surface-2"
                >
                  <group.icon size={15} className="shrink-0 text-text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{result.title}</span>
                  {result.subtitle && (
                    <span className="ml-2 shrink-0 truncate text-xs text-text-muted">{result.subtitle}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-text-muted">
          <span>↵ to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Topbar() {
  const navigate = useNavigate();
  const { data: user } = useAsync(() => getCurrentUser(), []);
  const { data: notifications } = useAsync(() => listNotifications(), []);
  const { data: projects } = useAsync(() => listProjects(), []);
  const { data: workItems } = useAsync(() => listAllWorkItems(), []);
  const { data: pages } = useAsync(() => listAllPages(), []);
  const { data: cycles } = useAsync(() => listAllCycles(), []);
  const { data: modules } = useAsync(() => listAllModules(), []);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();

  const unread = notifications?.filter((n) => !n.read).length ?? 0;
  const firstProjectId = projects?.[0]?.id;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
      <button
        type="button"
        onClick={() => setSearchOpen(true)}
        className="flex h-8 w-72 max-w-[40vw] items-center gap-2 rounded-[var(--radius-sm)] border border-border-strong bg-bg-inset px-3 text-sm text-text-muted hover:border-text-muted"
      >
        <Search size={14} />
        Search…
        <span className="ml-auto text-xs text-text-muted">⌘K</span>
      </button>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!firstProjectId}
          onClick={() => setQuickCreateOpen(true)}
          className="flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] bg-accent px-3 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          <Plus size={14} />
          New work item
        </button>

        <Tooltip label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            className="flex size-8 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary hover:bg-surface-2 hover:text-text"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </Tooltip>

        <button
          type="button"
          onClick={() => navigate('/notifications')}
          aria-label="Notifications"
          className="relative flex size-8 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary hover:bg-surface-2 hover:text-text"
        >
          <Bell size={16} />
          {unread > 0 && (
            <span className="absolute top-1 right-1.5 size-1.5 rounded-full bg-danger" />
          )}
        </button>

        <AccountMenu
          trigger={(toggle) => (
            <button type="button" onClick={toggle} aria-label="Account menu" className="rounded-full">
              {user && <Avatar name={user.fullName} color={user.avatarColor} size={28} />}
            </button>
          )}
        >
          {(close) => (
            <div className="w-48 rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg">
              <AccountMenuItem
                icon={<Settings size={14} />}
                label="Profile settings"
                onClick={() => {
                  close();
                  navigate('/profile/general');
                }}
              />
              <div className="my-1 h-px bg-border" />
              <AccountMenuItem
                icon={<LogOut size={14} />}
                label="Sign out"
                danger
                onClick={() => {
                  close();
                  markOnboarding('false');
                  navigate('/login');
                }}
              />
            </div>
          )}
        </AccountMenu>
      </div>

      {firstProjectId && (
        <CreateWorkItemModal
          open={quickCreateOpen}
          onClose={() => setQuickCreateOpen(false)}
          projectId={firstProjectId}
          onCreated={(item) => navigate(`/projects/${item.projectId}/work-items/${item.identifier}`)}
        />
      )}

      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        projects={projects ?? []}
        workItems={workItems ?? []}
        pages={pages ?? []}
        cycles={cycles ?? []}
        modules={modules ?? []}
      />
    </header>
  );
}
