import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { clsx } from 'clsx';
import { useProject } from '@/layouts/ProjectLayout';
import { Button } from '@/components/ui/Button';
import { CreateTicketModal } from '@/components/domain/CreateTicketModal';
import { TicketDrawer } from '@/components/domain/TicketDrawer';
import { useTicketsView, type ViewKind } from '@/pages/tickets/useTicketsView';
import TicketListToolbar, {
  PROJECT_GROUP_BY_OPTIONS,
} from '@/pages/tickets/TicketListToolbar';
import TicketList from '@/pages/tickets/TicketList';
import BoardView from '@/pages/tickets/BoardView';
import CalendarView from '@/pages/tickets/CalendarView';
import SpreadsheetView from '@/pages/tickets/SpreadsheetView';
import GanttView from '@/pages/tickets/GanttView';

const VIEW_TABS: { key: ViewKind; label: string }[] = [
  { key: 'list', label: 'List' },
  { key: 'board', label: 'Board' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'spreadsheet', label: 'Spreadsheet' },
  { key: 'gantt', label: 'Gantt' },
];

export default function TicketsLayout() {
  const { project } = useProject();
  const view = useTicketsView({ projectId: project.id });
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);

  const currentView: ViewKind =
    (searchParams.get('view') as ViewKind | null) ?? 'list';
  const peekIdentifier = searchParams.get('peek');

  // Sparse-project behavior (architecture §P5's own section title, "Sparse
  // projects and the ticket list" — the mockup's third buildTicketView
  // instantiation is literally a sparse project rendered through this same
  // component with no config difference at all, see TicketList.tsx's own
  // comment). The one concrete adjustment made here: don't offer "Group by
  // Sprint"/"Group by Workstream" for a project with zero rows in that
  // primitive — grouping by a dimension that produces one giant "No
  // sprint"/"No workstream" bucket for every ticket is pure noise, and it's
  // the same "derive presence from real rows" rule W5.1's primitiveCounts
  // already applies to the sidebar (§3.4). This is a judgment call beyond
  // what the mockup itself shows (its demo data assigns a sprint/workstream
  // to every ticket unconditionally, including the sparse project's) — see
  // the W5.2 handoff notes for the reasoning.
  const groupByOptions = useMemo(
    () =>
      PROJECT_GROUP_BY_OPTIONS.filter((opt) => {
        if (opt.key === 'sprint') return project.primitiveCounts.sprints > 0;
        if (opt.key === 'workstream')
          return project.primitiveCounts.workstreams > 0;
        return true;
      }),
    [project.primitiveCounts.sprints, project.primitiveCounts.workstreams],
  );

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

  return (
    <div className="flex h-full flex-col">
      {/* docs/design/waypoint-revamp-mockup.html:798-803's `.proj-tabs` — plain
          text tabs with an active underline, not the icon-only segmented
          control this used to be (the mockup has no icon for Board/
          Calendar/Spreadsheet/Gantt, and List's own icon duplicates the tab
          label right next to it). Project identity now lives in
          ProjectLayout's header above this, so this strip carries only the
          view tabs themselves. */}
      <div className="flex items-center gap-1 border-b border-border px-6 pt-2">
        {VIEW_TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            aria-pressed={currentView === key}
            onClick={() => setView(key)}
            className={clsx(
              'mb-[-1px] cursor-pointer border-b-2 px-3 py-2 text-[13px] transition-colors',
              currentView === key
                ? 'border-accent font-medium text-text'
                : 'border-transparent text-text-secondary hover:text-text',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3 border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <TicketListToolbar view={view} groupByOptions={groupByOptions} />

          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} />
            Add ticket
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {currentView === 'list' && (
          <TicketList
            view={view}
            projectId={project.id}
            onOpenItem={openPeek}
          />
        )}
        {currentView === 'board' && (
          <BoardView view={view} projectId={project.id} onOpenItem={openPeek} />
        )}
        {currentView === 'calendar' && (
          <CalendarView view={view} onOpenItem={openPeek} />
        )}
        {currentView === 'spreadsheet' && (
          <SpreadsheetView view={view} onOpenItem={openPeek} />
        )}
        {currentView === 'gantt' && (
          <GanttView view={view} onOpenItem={openPeek} />
        )}
      </div>

      <CreateTicketModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectId={project.id}
        onCreated={() => view.reload()}
      />

      {peekIdentifier && (
        <TicketDrawer
          projectId={project.id}
          identifier={peekIdentifier}
          onClose={closePeek}
        />
      )}
    </div>
  );
}
