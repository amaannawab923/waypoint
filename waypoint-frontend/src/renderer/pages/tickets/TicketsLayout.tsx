import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  List,
  Kanban,
  Calendar,
  Table,
  GanttChart,
  Plus,
  SlidersHorizontal,
  ListFilter,
  ChevronDown,
  Check,
  type LucideIcon,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useProject } from '@/layouts/ProjectLayout';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { CreateTicketModal } from '@/components/domain/CreateTicketModal';
import { TicketDrawer } from '@/components/domain/TicketDrawer';
import { PriorityIcon, PRIORITY_LABEL, PRIORITY_ORDER } from '@/components/domain/PriorityIcon';
import { StateIcon } from '@/components/domain/StateIcon';
import { Popover } from '@/pages/tickets/Popover';
import { useTicketsView, EMPTY_FILTERS, type GroupBy, type ViewKind } from '@/pages/tickets/useTicketsView';
import ListView from '@/pages/tickets/ListView';
import BoardView from '@/pages/tickets/BoardView';
import CalendarView from '@/pages/tickets/CalendarView';
import SpreadsheetView from '@/pages/tickets/SpreadsheetView';
import GanttView from '@/pages/tickets/GanttView';

const VIEW_TABS: { key: ViewKind; label: string; Icon: LucideIcon }[] = [
  { key: 'list', label: 'List', Icon: List },
  { key: 'board', label: 'Board', Icon: Kanban },
  { key: 'calendar', label: 'Calendar', Icon: Calendar },
  { key: 'spreadsheet', label: 'Spreadsheet', Icon: Table },
  { key: 'gantt', label: 'Gantt', Icon: GanttChart },
];

const GROUP_BY_OPTIONS: { key: GroupBy; label: string }[] = [
  { key: 'state', label: 'State' },
  { key: 'priority', label: 'Priority' },
  { key: 'workstream', label: 'Workstream' },
  { key: 'sprint', label: 'Sprint' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'none', label: 'None' },
];

function toggleInArray<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

export default function TicketsLayout() {
  const { project } = useProject();
  const view = useTicketsView(project.id);
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);

  const currentView: ViewKind = (searchParams.get('view') as ViewKind | null) ?? 'list';
  const peekIdentifier = searchParams.get('peek');

  function setView(next: ViewKind) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set('view', next);
        return params;
      },
      { replace: true },
    );
  }

  function openPeek(identifier: string) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set('peek', identifier);
        return params;
      },
      { replace: true },
    );
  }

  function closePeek() {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.delete('peek');
        return params;
      },
      { replace: true },
    );
  }

  const activeFilterCount = view.filters.priority.length + view.filters.stateId.length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="font-display text-sm text-text-secondary">{project.name}</span>
          <span className="text-sm text-text-muted">/</span>
          <span className="font-display text-sm font-medium text-text">Tickets</span>
          <Badge tone="neutral">{view.items.length}</Badge>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-[var(--radius-sm)] border border-border-strong p-0.5">
            {VIEW_TABS.map(({ key, label, Icon }) => (
              <Tooltip key={key} label={label}>
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={currentView === key}
                  onClick={() => setView(key)}
                  className={clsx(
                    'flex size-7 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] transition-colors',
                    currentView === key
                      ? 'bg-accent text-on-accent'
                      : 'text-text-secondary hover:bg-surface-2 hover:text-text',
                  )}
                >
                  <Icon size={15} />
                </button>
              </Tooltip>
            ))}
          </div>

          <Popover
            trigger={({ open, toggle }) => (
              <Button variant={open ? 'secondary' : 'ghost'} size="sm" onClick={toggle}>
                <SlidersHorizontal size={14} />
                Display
                <ChevronDown size={13} />
              </Button>
            )}
          >
            <div className="flex w-48 flex-col">
              <p className="mb-1 px-2 pt-1 text-xs font-medium tracking-wide text-text-muted uppercase">Group by</p>
              {GROUP_BY_OPTIONS.map((opt) => (
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
            align="end"
            trigger={({ open, toggle }) => (
              <Button variant={open ? 'secondary' : 'ghost'} size="sm" onClick={toggle}>
                <ListFilter size={14} />
                Filters
                {activeFilterCount > 0 && <Badge tone="accent">{activeFilterCount}</Badge>}
                <ChevronDown size={13} />
              </Button>
            )}
          >
            <div className="flex w-64 flex-col gap-3">
              <div>
                <p className="mb-1 px-2 text-xs font-medium tracking-wide text-text-muted uppercase">Priority</p>
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
                        view.setFilters((f) => ({ ...f, priority: toggleInArray(f.priority, p) }))
                      }
                    />
                    <PriorityIcon priority={p} size={13} />
                    {PRIORITY_LABEL[p]}
                  </label>
                ))}
              </div>
              <div>
                <p className="mb-1 px-2 text-xs font-medium tracking-wide text-text-muted uppercase">State</p>
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
                        view.setFilters((f) => ({ ...f, stateId: toggleInArray(f.stateId, s.id) }))
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
                  onClick={() => view.setFilters(EMPTY_FILTERS)}
                  className="cursor-pointer self-start px-2 text-xs text-accent hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          </Popover>

          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} />
            Add ticket
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {currentView === 'list' && <ListView view={view} projectId={project.id} onOpenItem={openPeek} />}
        {currentView === 'board' && <BoardView view={view} projectId={project.id} onOpenItem={openPeek} />}
        {currentView === 'calendar' && <CalendarView view={view} onOpenItem={openPeek} />}
        {currentView === 'spreadsheet' && <SpreadsheetView view={view} onOpenItem={openPeek} />}
        {currentView === 'gantt' && <GanttView view={view} onOpenItem={openPeek} />}
      </div>

      <CreateTicketModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectId={project.id}
        onCreated={() => view.reload()}
      />

      {peekIdentifier && (
        <TicketDrawer projectId={project.id} identifier={peekIdentifier} onClose={closePeek} />
      )}
    </div>
  );
}
