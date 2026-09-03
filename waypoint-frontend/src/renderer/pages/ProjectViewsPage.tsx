import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { clsx } from 'clsx';
import { ArrowLeft, Copy, Globe2, Layers3, Lock, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { createView, deleteView, getCurrentUser, listMembers, listViews, updateView } from '@/data/api';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import ListView from '@/pages/tickets/ListView';
import { EMPTY_FILTERS, useTicketsView, type TicketFilters } from '@/pages/tickets/useTicketsView';
import { PRIORITY_ORDER } from '@/components/domain/PriorityIcon';
import type { Priority, SavedView } from '@/types/entities';

/**
 * A saved view's `filters` is a loosely-typed `Record<string, unknown>` (see
 * createView call sites and src/mock/seed.ts). Normalize it into the strict
 * TicketFilters shape the tickets list actually filters on, tolerating
 * both array and single-value entries.
 *
 * Assignee criteria get special handling because they can't all be expressed
 * as a positive `assigneeId` match: `assignee: 'none'` means "zero
 * assignees", an empty-set condition useTicketsView's filter can't express
 * (an empty `assigneeId` array is treated as "no filter", not "must be
 * empty"). So `unassignedOnly` is returned separately and applied as a
 * client-side post-filter by the caller. `assignee: 'me'` resolves to the
 * current user id; any other string/array is treated as specific member
 * id(s) and folds into `assigneeId`, which useTicketsView already filters
 * on correctly.
 */
function filtersFromSavedView(
  raw: Record<string, unknown>,
  currentUserId: string | undefined,
): { filters: TicketFilters; unassignedOnly: boolean } {
  function toStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    if (typeof value === 'string') return [value];
    return [];
  }

  const priority = toStringArray(raw.priority).filter((p): p is Priority =>
    (PRIORITY_ORDER as string[]).includes(p),
  );

  const rawAssignee = raw.assignee;
  let unassignedOnly = false;
  let assigneeId = toStringArray(raw.assigneeId);
  if (rawAssignee === 'none') {
    unassignedOnly = true;
  } else if (rawAssignee === 'me') {
    if (currentUserId) assigneeId = [...assigneeId, currentUserId];
  } else {
    assigneeId = [...assigneeId, ...toStringArray(rawAssignee)];
  }

  return {
    unassignedOnly,
    filters: {
      ...EMPTY_FILTERS,
      priority,
      stateId: toStringArray(raw.stateId),
      labelId: toStringArray(raw.labelId),
      assigneeId,
      workstreamId: toStringArray(raw.workstreamId),
      sprintId: toStringArray(raw.sprintId),
    },
  };
}

/** Small self-contained popover: caller renders the trigger and the panel content. Mirrors the
 * pattern used in SprintListCard/TicketDetailPage — there's no shared Dropdown/Menu primitive in
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

/** Electron's renderer doesn't implement window.prompt() at all (unlike
 * window.confirm(), which is real) — any code path relying on it crashes
 * unconditionally. This is the in-app replacement, local to this file since
 * there's no shared single-field text-prompt primitive yet. */
function NamePromptModal({
  open,
  title,
  initialValue,
  confirmLabel,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initialValue: string;
  confirmLabel: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none focus:border-accent"
      />
    </Modal>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
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

export default function ProjectViewsPage() {
  const { project } = useProject();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [activeView, setActiveView] = useState<SavedView | null>(null);
  const [addPromptOpen, setAddPromptOpen] = useState(false);
  const [renamingView, setRenamingView] = useState<SavedView | null>(null);

  const { data: views, loading, reload } = useAsync(() => listViews(project.id), [project.id]);
  const { data: members } = useAsync(() => listMembers(), []);
  const { data: currentUser } = useAsync(() => getCurrentUser(), []);
  const ticketsView = useTicketsView(project.id);

  const normalized = useMemo(
    () => filtersFromSavedView(activeView ? activeView.filters : {}, currentUser?.id),
    [activeView, currentUser?.id],
  );

  useEffect(() => {
    ticketsView.setFilters(activeView ? normalized.filters : EMPTY_FILTERS);
    // Only re-run when the normalized filters change, not on every
    // ticketsView identity change (setFilters is stable per render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, normalized.filters]);

  // `unassignedOnly` (the "no assignee" / empty-set case) can't be expressed
  // through useTicketsView's filters, so it's applied here as a post-filter
  // on top of the already-filtered items/groups.
  const activeViewItems = normalized.unassignedOnly
    ? ticketsView.items.filter((item) => item.assigneeIds.length === 0)
    : ticketsView.items;
  const activeViewGroupedItems = normalized.unassignedOnly
    ? ticketsView.groupedItems.map((group) => ({
        ...group,
        items: group.items.filter((item) => item.assigneeIds.length === 0),
      }))
    : ticketsView.groupedItems;

  function handleAddView() {
    if (creating) return;
    setAddPromptOpen(true);
  }

  async function submitAddView(name: string) {
    setAddPromptOpen(false);
    setCreating(true);
    try {
      await createView(project.id, name, {});
      reload();
    } finally {
      setCreating(false);
    }
  }

  function handleRenameView(view: SavedView) {
    setRenamingView(view);
  }

  async function submitRenameView(name: string) {
    const view = renamingView;
    setRenamingView(null);
    if (!view || name === view.name) return;
    await updateView(view.id, { name });
    reload();
  }

  async function handleDuplicateView(view: SavedView) {
    await createView(project.id, `${view.name} copy`, view.filters);
    reload();
  }

  async function handleDeleteView(view: SavedView) {
    if (!window.confirm(`Delete "${view.name}"? This can't be undone.`)) return;
    if (activeView?.id === view.id) setActiveView(null);
    await deleteView(view.id);
    reload();
  }

  async function handleToggleVisibility(view: SavedView) {
    await updateView(view.id, { visibility: view.visibility === 'public' ? 'private' : 'public' });
    reload();
  }

  async function handleToggleFavorite(view: SavedView) {
    await updateView(view.id, { isFavorite: !view.isFavorite });
    reload();
  }

  if (!project.features.views) {
    return (
      <EmptyState
        icon={<Layers3 size={28} />}
        title="Views is disabled for this project"
        description="Turn Views back on in project settings to save filters again."
        action={
          <Button variant="primary" onClick={() => navigate(`/projects/${project.id}/settings/features`)}>
            Go to features
          </Button>
        }
      />
    );
  }

  if (activeView) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => setActiveView(null)}>
              <ArrowLeft size={15} />
              Views
            </Button>
            <div>
              <h1 className="font-display text-lg font-medium text-text">{activeView.name}</h1>
              <p className="text-sm text-text-secondary">
                {activeViewItems.length} ticket{activeViewItems.length === 1 ? '' : 's'} matching this view
              </p>
            </div>
          </div>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          <ListView
            view={{ ...ticketsView, items: activeViewItems, groupedItems: activeViewGroupedItems }}
            projectId={project.id}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="font-display text-lg font-medium text-text">Views</h1>
          <p className="text-sm text-text-secondary">Saved filters for {project.name}</p>
        </div>
        <Button variant="primary" onClick={handleAddView} disabled={creating}>
          <Plus size={15} />
          {creating ? 'Creating…' : 'Add view'}
        </Button>
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto">
        {loading && !views ? (
          <SkeletonListRows rows={6} />
        ) : !views || views.length === 0 ? (
          <EmptyState
            icon={<Layers3 size={28} />}
            title="No views yet"
            description="Save the current filter, sort, and grouping as a view you can jump back to."
            action={
              <Button variant="primary" onClick={handleAddView} disabled={creating}>
                <Plus size={15} />
                Add view
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {views.map((view) => {
              const owner = members?.find((m) => m.id === view.ownerId);
              const visibility = view.visibility ?? 'public';
              const isFavorite = view.isFavorite ?? false;
              return (
                <li key={view.id} className="group flex items-center gap-1 px-6 py-3 hover:bg-surface-2">
                  <button
                    type="button"
                    onClick={() => setActiveView(view)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <Layers3 size={15} className="shrink-0 text-text-muted" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{view.name}</span>
                    {owner && (
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-secondary">
                        <Avatar name={owner.displayName} color={owner.avatarColor} size={18} />
                        {owner.displayName}
                      </span>
                    )}
                    <span className="w-32 shrink-0 text-right text-xs text-text-muted">
                      Updated {formatDistanceToNow(new Date(view.updatedAt), { addSuffix: true })}
                    </span>
                  </button>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={visibility === 'public' ? 'Make private' : 'Make public'}
                      title={visibility === 'public' ? 'Public — visible to everyone' : 'Private — only visible to you'}
                      onClick={() => handleToggleVisibility(view)}
                      className="inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors hover:bg-surface hover:text-text"
                    >
                      {visibility === 'public' ? <Globe2 size={14} /> : <Lock size={14} />}
                    </button>
                    <button
                      type="button"
                      aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                      aria-pressed={isFavorite}
                      onClick={() => handleToggleFavorite(view)}
                      className={clsx(
                        'inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] opacity-0 transition-opacity hover:bg-surface group-hover:opacity-100 group-focus-within:opacity-100',
                        isFavorite ? 'text-warning opacity-100' : 'text-text-secondary hover:text-text',
                      )}
                    >
                      <Star size={14} fill={isFavorite ? 'currentColor' : 'none'} />
                    </button>
                    <div className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <Dropdown
                        trigger={(toggle) => (
                          <button
                            type="button"
                            aria-label="View actions"
                            onClick={toggle}
                            className="inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors hover:bg-surface hover:text-text"
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
                                handleRenameView(view);
                              }}
                            />
                            <MenuItem
                              icon={<Copy size={14} />}
                              label="Duplicate"
                              onClick={() => {
                                close();
                                handleDuplicateView(view);
                              }}
                            />
                            <div className="my-1 h-px bg-border" />
                            <MenuItem
                              icon={<Trash2 size={14} />}
                              label="Delete"
                              danger
                              onClick={() => {
                                close();
                                handleDeleteView(view);
                              }}
                            />
                          </div>
                        )}
                      </Dropdown>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <NamePromptModal
        open={addPromptOpen}
        title="Name this view"
        initialValue=""
        confirmLabel="Create"
        onCancel={() => setAddPromptOpen(false)}
        onSubmit={submitAddView}
      />
      <NamePromptModal
        open={renamingView !== null}
        title="Rename view"
        initialValue={renamingView?.name ?? ''}
        confirmLabel="Save"
        onCancel={() => setRenamingView(null)}
        onSubmit={submitRenameView}
      />
    </div>
  );
}
