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
 * "Save as view" and "New ticket" are both intentionally absent here. The
 * latter has no single target project to create into (see TicketList's own
 * comment on why `projectId` is left undefined here). The former is W5.3's
 * saved-view filter editor, which does exist now (TicketListToolbar.tsx) —
 * but it's gated on `view.projectId` being set, so it doesn't render for
 * this page's `TicketListToolbar` regardless: this workspace scope has no
 * project to save a view into (the only create endpoint is
 * `POST /projects/:projectId/views`) and no page to browse/manage a
 * workspace-scoped view afterward (this page replaced the old
 * WorkspaceViewsPage outright rather than sitting alongside it — see above).
 * See TicketListToolbar.tsx's own doc comment for the full reasoning.
 */
export default function AllTicketsPage() {
  const view = useTicketsView({ defaultGroupBy: 'project' });
  const [searchParams, setSearchParams] = useSearchParams();
  const peekIdentifier = searchParams.get('peek');
  // `view.items` may not have loaded yet, or (on a `?peek=` deep link) may
  // simply not include this identifier yet — e.g. it hasn't loaded, or a
  // filter/page excludes it. Falling back to '' here previously built a
  // broken `/projects//tickets/...`-shaped link and, downstream, fed
  // TicketDetailContent an empty projectId prop. Leave it undefined until
  // the real id resolves instead of guessing at one.
  const peekProjectId = peekIdentifier
    ? view.items.find((i) => i.identifier === peekIdentifier)?.projectId
    : undefined;

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

      {peekIdentifier && peekProjectId && (
        <TicketDrawer
          projectId={peekProjectId}
          identifier={peekIdentifier}
          onClose={closePeek}
        />
      )}
    </div>
  );
}
