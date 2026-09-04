import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { clsx } from 'clsx';
import { ArrowLeft, Copy, Globe2, MoreHorizontal, Star, Trash2 } from 'lucide-react';
import { IconLayers, IconLock, IconEdit, IconPlus } from '@/components/icons';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import {
  createView,
  deleteView,
  listMembers,
  listViews,
  updateView,
} from '@/data/api';
import { refreshProjectInStore } from '@/lib/projectsStore';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { NamePromptModal } from '@/components/ui/NamePromptModal';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import TicketList from '@/pages/tickets/TicketList';
import TicketListToolbar, {
  captureSavedViewFilter,
  PROJECT_GROUP_BY_OPTIONS,
} from '@/pages/tickets/TicketListToolbar';
import {
  EMPTY_FILTERS,
  useTicketsView,
  type TicketFilters,
} from '@/pages/tickets/useTicketsView';
import type { SavedView, TicketFilterQuery } from '@/types/entities';

/**
 * A saved view's `filters` is now the typed ticketFilterSchema shape
 * (§4.6) — translate it into useTicketsView's local TicketFilters shape,
 * the same translation toFilterQuery() in useTicketsView.ts does in
 * reverse. '@me' and '@unassigned' inside assigneeIds are no longer
 * special-cased here at all: they ride straight through to the server,
 * which resolves them at query time (buildAssigneeCondition in
 * tickets.service.ts), so a saved view means "my open tickets" for
 * whoever opens it and "no assignee" is a real filter condition instead
 * of a client-side post-filter.
 */
function filtersFromSavedView(raw: TicketFilterQuery): TicketFilters {
  return {
    priority: raw.priorities ?? [],
    stateId: raw.stateIds ?? [],
    labelId: raw.labelIds ?? [],
    assigneeId: raw.assigneeIds ?? [],
    workstreamId: raw.workstreamIds ?? [],
    sprintId: raw.sprintIds ?? [],
    creatorId: raw.creatorIds ?? [],
    text: raw.text ?? '',
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
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
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
        <div
          className={clsx(
            'absolute z-30 mt-1',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
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

export default function ProjectViewsPage() {
  const { project } = useProject();
  const [creating, setCreating] = useState(false);
  const [activeView, setActiveView] = useState<SavedView | null>(null);
  const [addPromptOpen, setAddPromptOpen] = useState(false);
  const [renamingView, setRenamingView] = useState<SavedView | null>(null);

  const {
    data: views,
    loading,
    reload,
  } = useAsync(() => listViews(project.id), [project.id]);
  const { data: members } = useAsync(() => listMembers(), []);
  const ticketsView = useTicketsView({ projectId: project.id });

  const [savingFilters, setSavingFilters] = useState(false);

  const normalizedFilters = useMemo(
    () =>
      activeView ? filtersFromSavedView(activeView.filters) : EMPTY_FILTERS,
    [activeView],
  );

  useEffect(() => {
    ticketsView.setFilters(normalizedFilters);
    // Only re-run when the normalized filters change, not on every
    // ticketsView identity change (setFilters is stable per render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedFilters]);

  // Whether the toolbar below (rendered against `ticketsView`, seeded from
  // `normalizedFilters` above) has diverged from the saved view's own
  // filters — i.e. whether there's an edit worth persisting. Compared as
  // plain values (TicketFilters is flat arrays-of-strings + one string, no
  // nested objects) rather than a field-by-field diff; a toggle-then-toggle-
  // back can reorder an array and read as dirty when it isn't, which only
  // means "Save changes" is enabled a little more eagerly than strictly
  // necessary — never the reverse, so it never hides a real, savable edit.
  const filtersAreDirty = useMemo(
    () =>
      JSON.stringify(ticketsView.filters) !== JSON.stringify(normalizedFilters),
    [ticketsView.filters, normalizedFilters],
  );

  async function handleSaveViewFilters() {
    if (!activeView) return;
    setSavingFilters(true);
    try {
      const filters = captureSavedViewFilter(ticketsView.filters, project.id);
      const updated = await updateView(activeView.id, { filters });
      // Reflects the save immediately without a round-trip through
      // `reload()` + re-selecting the view from the refreshed `views` list —
      // `normalizedFilters` (and so `filtersAreDirty`) recomputes off this
      // state, so the button returns to disabled the moment the save lands.
      setActiveView(updated);
      reload();
    } finally {
      setSavingFilters(false);
    }
  }

  function handleAddView() {
    if (creating) return;
    setAddPromptOpen(true);
  }

  async function submitAddView(name: string) {
    setAddPromptOpen(false);
    setCreating(true);
    try {
      await createView(project.id, name, { v: 1, projectIds: [project.id] });
      reload();
      // This may be the project's first view — refresh the shared projects
      // store so the sidebar's Views entry (driven by
      // primitiveCounts.views > 0) appears without a page reload.
      refreshProjectInStore(project.id);
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
    await updateView(view.id, {
      visibility: view.visibility === 'public' ? 'private' : 'public',
    });
    reload();
  }

  async function handleToggleFavorite(view: SavedView) {
    await updateView(view.id, { isFavorite: !view.isFavorite });
    reload();
  }

  if (activeView) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveView(null)}
            >
              <ArrowLeft size={15} />
              Views
            </Button>
            <div>
              <h1 className="font-display text-lg font-medium text-text">
                {activeView.name}
              </h1>
              <p className="text-sm text-text-secondary">
                {ticketsView.items.length} ticket
                {ticketsView.items.length === 1 ? '' : 's'} matching this view
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
          {/* Reuses the same group/filter/search controls the live ticket
              list toolbar renders (TicketListToolbar) — editing a saved
              view's filter is just driving this same `ticketsView` the way
              any other TicketsView is driven, not a second filter-editing
              UI. Its own "Save as view" button also renders here (this
              `ticketsView` has `projectId` set), which doubles as "Save as
              a new view" on top of this screen's own "Save changes"
              (update-in-place) below — a deliberate, harmless overlap
              rather than something worth suppressing. */}
          <TicketListToolbar
            view={ticketsView}
            groupByOptions={PROJECT_GROUP_BY_OPTIONS}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={handleSaveViewFilters}
            disabled={!filtersAreDirty || savingFilters}
          >
            {savingFilters ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          <TicketList view={ticketsView} projectId={project.id} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="font-display text-lg font-medium text-text">Views</h1>
          <p className="text-sm text-text-secondary">
            A view is a saved filter. One concept — a project view is just a view whose filter includes{' '}
            {project.name}.
          </p>
        </div>
        <Button variant="primary" onClick={handleAddView} disabled={creating}>
          <IconPlus size={15} />
          {creating ? 'Creating…' : 'Add view'}
        </Button>
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto">
        {loading && !views ? (
          <SkeletonListRows rows={6} />
        ) : !views || views.length === 0 ? (
          <EmptyState
            icon={<IconLayers size={28} />}
            title="No views yet"
            description="Save the current filter, sort, and grouping as a view you can jump back to."
            action={
              <Button
                variant="primary"
                onClick={handleAddView}
                disabled={creating}
              >
                <IconPlus size={15} />
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
                <li
                  key={view.id}
                  className="group flex items-center gap-1 px-6 py-3 hover:bg-surface-2"
                >
                  <button
                    type="button"
                    onClick={() => setActiveView(view)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <IconLayers size={15} className="shrink-0 text-text-muted" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
                      {view.name}
                    </span>
                    {owner && (
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-secondary">
                        <Avatar
                          name={owner.displayName}
                          color={owner.avatarColor}
                          size={18}
                        />
                        {owner.displayName}
                      </span>
                    )}
                    <span className="w-32 shrink-0 text-right text-xs text-text-muted">
                      Updated{' '}
                      {formatDistanceToNow(new Date(view.updatedAt), {
                        addSuffix: true,
                      })}
                    </span>
                  </button>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={
                        visibility === 'public' ? 'Make private' : 'Make public'
                      }
                      title={
                        visibility === 'public'
                          ? 'Public — visible to everyone'
                          : 'Private — only visible to you'
                      }
                      onClick={() => handleToggleVisibility(view)}
                      className="inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors hover:bg-surface hover:text-text"
                    >
                      {visibility === 'public' ? (
                        <Globe2 size={14} />
                      ) : (
                        <IconLock size={14} />
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={
                        isFavorite
                          ? 'Remove from favorites'
                          : 'Add to favorites'
                      }
                      aria-pressed={isFavorite}
                      onClick={() => handleToggleFavorite(view)}
                      className={clsx(
                        'inline-flex size-7 items-center justify-center rounded-[var(--radius-sm)] opacity-0 transition-opacity hover:bg-surface group-hover:opacity-100 group-focus-within:opacity-100',
                        isFavorite
                          ? 'text-warning opacity-100'
                          : 'text-text-secondary hover:text-text',
                      )}
                    >
                      <Star
                        size={14}
                        fill={isFavorite ? 'currentColor' : 'none'}
                      />
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
                              icon={<IconEdit size={14} />}
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
