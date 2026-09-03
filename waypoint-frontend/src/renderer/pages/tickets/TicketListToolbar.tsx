import {
  SlidersHorizontal,
  ListFilter,
  ChevronDown,
  Check,
  Search,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  PriorityIcon,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
} from '@/components/domain/PriorityIcon';
import { StateIcon } from '@/components/domain/StateIcon';
import { Popover } from '@/pages/tickets/Popover';
import {
  EMPTY_FILTERS,
  type GroupBy,
  type TicketsView,
} from '@/pages/tickets/useTicketsView';

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
 * identical across all five of a project's view tabs, not List-specific) and
 * "Save as view" (W5.3's saved-view filter editor owns that; building even a
 * stub here risks landing a `createView({})` shape that unit is explicitly
 * meant to prevent).
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
            <ChevronDown size={13} />
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
              {view.groupBy === opt.key && <Check size={14} />}
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
            <ListFilter size={14} />
            Filters
            {activeFilterCount > 0 && (
              <Badge tone="accent">{activeFilterCount}</Badge>
            )}
            <ChevronDown size={13} />
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
        <Search
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
    </div>
  );
}
