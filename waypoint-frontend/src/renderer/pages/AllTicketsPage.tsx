import { useSearchParams } from 'react-router-dom';
import { useTicketsView } from '@/pages/tickets/useTicketsView';
import TicketListToolbar, {
  WORKSPACE_GROUP_BY_OPTIONS,
} from '@/pages/tickets/TicketListToolbar';
import TicketList from '@/pages/tickets/TicketList';
import { TicketDrawer } from '@/components/domain/TicketDrawer';

/**
 * The workspace scope of W5.2's unified TicketList (architecture §P5): every
 * ticket across every project, filtered/grouped/searched exactly like a
 * single project's list, just with no `projectIds` restriction on the
 * default filter. This is what the mockup's sidebar rename note calls out
 * directly (waypoint-revamp-mockup.html:610's `data-was`): the old "Views"
 * nav entry "was labeled 'Views' but opened a screen titled 'All work
 * items'. Now it is the same filter/group/bulk surface as a project list,
 * with no project filter applied" — i.e. this page replaces
 * WorkspaceViewsPage's old hand-rolled, unfiltered, ungrouped table (see the
 * W5.2 handoff notes) rather than sitting alongside it.
 *
 * Deliberately has no view-tab switcher (List/Board/Calendar/...) the way
 * TicketsLayout does — the mockup's own "All tickets" screen doesn't have
 * one either, since Board/Calendar/Gantt's column-per-state or
 * date-range framing doesn't carry over cleanly to a cross-project list.
 *
 * "Save as view" and "New ticket" are both intentionally absent: the former
 * is W5.3's saved-view filter editor (building even a stub risks landing a
 * `createView({})` shape that unit exists specifically to prevent); the
 * latter has no single target project to create into (see TicketList's own
 * comment on why `projectId` is left undefined here).
 */
export default function AllTicketsPage() {
  const view = useTicketsView({ defaultGroupBy: 'project' });
  const [searchParams, setSearchParams] = useSearchParams();
  const peekIdentifier = searchParams.get('peek');

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
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div>
          <h1 className="font-display text-lg font-medium text-text">
            All tickets
          </h1>
          <p className="text-sm text-text-secondary">
            Every ticket across every project.
          </p>
        </div>
        <TicketListToolbar
          view={view}
          groupByOptions={WORKSPACE_GROUP_BY_OPTIONS}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TicketList view={view} onOpenItem={openPeek} showProjectColumn />
      </div>

      {peekIdentifier && (
        <TicketDrawer
          projectId={
            view.items.find((i) => i.identifier === peekIdentifier)
              ?.projectId ?? ''
          }
          identifier={peekIdentifier}
          onClose={closePeek}
        />
      )}
    </div>
  );
}
