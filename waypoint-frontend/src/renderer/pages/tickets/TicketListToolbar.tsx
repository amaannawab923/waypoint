import { useState } from 'react';
import { SlidersHorizontal, BookmarkPlus } from 'lucide-react';
import { IconFilter, IconChevron, IconCheck, IconSearch } from '@/components/icons';
import { clsx } from 'clsx';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { NamePromptModal } from '@/components/ui/NamePromptModal';
import {
  PriorityIcon,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
} from '@/components/domain/PriorityIcon';
import { StateIcon } from '@/components/domain/StateIcon';
import { Popover } from '@/pages/tickets/Popover';
import { createView } from '@/data/api';
import { refreshProjectInStore } from '@/lib/projectsStore';
import {
  EMPTY_FILTERS,
  toFilterQuery,
  type GroupBy,
  type TicketFilters,
  type TicketsView,
} from '@/pages/tickets/useTicketsView';
import type { TicketFilterQuery } from '@/types/entities';

/**
 * Captures a TicketsView's current live filters into the typed shape a
 * saved view's `filters` column requires (§4.6), guaranteeing a real,
 * non-empty result — W5.3's accept criterion is that `createView` never
 * saves `{}` or an equivalent meaningless filter. `toFilterQuery` alone
 * collapses an all-empty TicketFilters to `undefined` (by design — that's
 * the right behavior for the unfiltered ticket-list fetch it's also used
 * for), so this always folds in `projectIds: [projectId]` on top: even a
 * "no extra filters set" save still captures a real, meaningful predicate
 * ("every ticket in this project"), the same baseline
 * `{ v: 1, projectIds: [project.id] }` ProjectViewsPage's blank "Add view"
 * flow has used since W5.1.
 *
 * Exported so ProjectViewsPage's saved-view filter EDITOR (the "Save
 * changes" flow on an existing view, also W5.3) can capture an edited
 * TicketsView's filters the same way, rather than a second implementation.
 *
 * `groupBy` rides along on the same typed shape (optional, so an older
 * saved view without one just falls back to the toolbar's own default) —
 * a saved view used to capture only the filter predicate, so opening one
 * always reset to the default grouping regardless of what was showing
 * when it was saved.
 */
export function captureSavedViewFilter(
  filters: TicketFilters,
  projectId: string,
  groupBy: GroupBy,
): TicketFilterQuery {
  return {
    ...(toFilterQuery(filters) ?? { v: 1 }),
    projectIds: [projectId],
    groupBy,
  };
}

export const PROJECT_GROUP_BY_OPTIONS: { key: GroupBy; label: string }[] = [
  { key: 'state', label: 'State' },
  { key: 'priority', label: 'Priority' },
  { key: 'workstream', label: 'Workstream' },
  { key: 'sprint', label: 'Sprint' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'none', label: 'None' },
];

// Workspace scope adds 'Project' (mirrors the mockup's buildTicketView,
// which only ever offers the 'project' groupBy when cfg.showProject is
// true) and defaults to it (see AllTicketsPage / YourWork's
// defaultGroupBy: 'project').
export const WORKSPACE_GROUP_BY_OPTIONS: { key: GroupBy; label: string }[] = [
  { key: 'project', label: 'Project' },
  ...PROJECT_GROUP_BY_OPTIONS,
];

function toggleInArray<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

/**
 * The group/filter/search control surface shared by every W5.2 ticket-list
 * scope — project (TicketsLayout), workspace (AllTicketsPage), and YourWork's
 * Assigned/Created tabs. Extracted out of what used to be TicketsLayout's own
 * inline toolbar JSX so the three scopes render literally the same controls
 * wired to the same `TicketsView` shape, rather than three near-duplicates.
 *
 * Deliberately excludes "Add ticket" (TicketsLayout still owns that — it's
 * identical across all five of a project's view tabs, not List-specific).
 *
 * "Save as view" (W5.3) lives here, gated on `view.projectId` being set —
 * i.e. it only renders in project scope (TicketsLayout), not workspace scope
 * (AllTicketsPage) or YourWork's Assigned/Created tabs, even though those are
 * the same shared toolbar. Two independent reasons, either one sufficient on
 * its own:
 *   1. Saved views only have a home once created: the sole create endpoint
 *      is `POST /projects/:projectId/views`, and the only place to browse,
 *      rename, favorite, or delete one afterward is ProjectViewsPage
 *      (`/projects/:id/views`). Workspace scope has neither — W5.2 removed
 *      the old WorkspaceViewsPage outright (see AllTicketsPage.tsx's own
 *      comment) — so a view "saved" from there would be uneditable and
 *      unlistable the moment the dialog closed.
 *   2. Even setting that aside, YourWork's Assigned/Created tabs start from
 *      a fixed `@me`-scoped base filter (assigneeId/creatorId) that isn't
 *      the signed-in user's own choice the way every other filter in this
 *      toolbar is — captured into a saved view, "Assigned to me" bakes in
 *      whoever happened to save it (view ownership doesn't rebind `@me` the
 *      way it does when the toolbar itself renders it live), which is a
 *      meaningfully different, more confusing object than every other
 *      saved view this feature produces.
 */
export default function TicketListToolbar({
  view,
  groupByOptions,
}: {
  view: TicketsView;
  groupByOptions: { key: GroupBy; label: string }[];
}) {
  const activeFilterCount =
    view.filters.priority.length + view.filters.stateId.length;
  const [saveAsViewOpen, setSaveAsViewOpen] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const { projectId } = view;

  async function submitSaveAsView(name: string) {
    if (!projectId) return;
    setSaveAsViewOpen(false);
    setSavingView(true);
    try {
      await createView(
        projectId,
        name,
        captureSavedViewFilter(view.filters, projectId, view.groupBy),
      );
      // This may be the project's first view — refresh the shared projects
      // store so the sidebar's Views entry (driven by
      // primitiveCounts.views > 0) appears without a page reload, mirroring
      // ProjectViewsPage's own submitAddView.
      refreshProjectInStore(projectId);
    } finally {
      setSavingView(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover
        trigger={({ open, toggle }) => (
          <Button
            variant={open ? 'secondary' : 'ghost'}
            size="sm"
            onClick={toggle}
          >
            <SlidersHorizontal size={14} />
            Group by
            <IconChevron size={13} />
          </Button>
        )}
      >
        <div className="flex w-48 flex-col">
          <p className="mb-1 px-2 pt-1 text-xs font-medium tracking-wide text-text-muted uppercase">
            Group by
          </p>
          {groupByOptions.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => view.setGroupBy(opt.key)}
              className={clsx(
                'flex cursor-pointer items-center justify-between rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-surface-2',
                view.groupBy === opt.key ? 'text-accent' : 'text-text',
              )}
            >
              {opt.label}
              {view.groupBy === opt.key && <IconCheck size={14} />}
            </button>
          ))}
        </div>
      </Popover>

      <Popover
        trigger={({ open, toggle }) => (
          <Button
            variant={open ? 'secondary' : 'ghost'}
            size="sm"
            onClick={toggle}
          >
            <IconFilter size={14} />
            Filters
            {activeFilterCount > 0 && (
              <Badge tone="accent">{activeFilterCount}</Badge>
            )}
            <IconChevron size={13} />
          </Button>
        )}
      >
        <div className="flex w-64 flex-col gap-3">
          <div>
            <p className="mb-1 px-2 text-xs font-medium tracking-wide text-text-muted uppercase">
              Priority
            </p>
            {PRIORITY_ORDER.map((p) => (
              <label
                key={p}
                className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={view.filters.priority.includes(p)}
                  onChange={() =>
                    view.setFilters((f) => ({
                      ...f,
                      priority: toggleInArray(f.priority, p),
                    }))
                  }
                />
                <PriorityIcon priority={p} size={13} />
                {PRIORITY_LABEL[p]}
              </label>
            ))}
          </div>
          <div>
            <p className="mb-1 px-2 text-xs font-medium tracking-wide text-text-muted uppercase">
              State
            </p>
            {view.states.map((s) => (
              <label
                key={s.id}
                className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={view.filters.stateId.includes(s.id)}
                  onChange={() =>
                    view.setFilters((f) => ({
                      ...f,
                      stateId: toggleInArray(f.stateId, s.id),
                    }))
                  }
                />
                <StateIcon state={s} size={13} />
                {s.name}
              </label>
            ))}
          </div>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={() =>
                view.setFilters((f) => ({ ...EMPTY_FILTERS, text: f.text }))
              }
              className="cursor-pointer self-start px-2 text-xs text-accent hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      </Popover>

      <span className="relative flex h-8 items-center">
        <IconSearch
          size={13}
          className="pointer-events-none absolute left-2.5 text-text-muted"
        />
        <input
          type="text"
          value={view.filters.text}
          onChange={(e) =>
            view.setFilters((f) => ({ ...f, text: e.target.value }))
          }
          placeholder="Search titles…"
          aria-label="Search ticket titles"
          className="h-8 w-44 rounded-[var(--radius-sm)] border border-border-strong bg-bg pr-2 pl-8 text-sm text-text outline-none placeholder:text-text-muted focus:border-accent"
        />
      </span>

      {projectId && (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSaveAsViewOpen(true)}
            disabled={savingView}
          >
            <BookmarkPlus size={14} />
            {savingView ? 'Saving…' : 'Save as view'}
          </Button>
          <NamePromptModal
            open={saveAsViewOpen}
            title="Save as view"
            initialValue=""
            confirmLabel="Save"
            onCancel={() => setSaveAsViewOpen(false)}
            onSubmit={submitSaveAsView}
          />
        </>
      )}
    </div>
  );
}
