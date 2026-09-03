import { useMemo, useState } from 'react';
import { useAsync } from '@/lib/useAsync';
import {
  listTickets,
  listAllTickets,
  listStates,
  listLabels,
  listWorkstreams,
  listAllWorkstreams,
  listSprints,
  listAllSprints,
  listProjects,
} from '@/data/api';
import type {
  Ticket,
  TicketState,
  Priority,
  Project,
  TicketFilterQuery,
} from '@/types/entities';
import { STATE_GROUP_ORDER } from '@/components/domain/StateIcon';
import { PRIORITY_ORDER } from '@/components/domain/PriorityIcon';

export type GroupBy =
  | 'state'
  | 'priority'
  | 'workstream'
  | 'sprint'
  | 'assignee'
  | 'project'
  | 'none';
export type ViewKind = 'list' | 'board' | 'calendar' | 'spreadsheet' | 'gantt';

export interface TicketFilters {
  priority: Priority[];
  stateId: string[];
  labelId: string[];
  assigneeId: string[];
  workstreamId: string[];
  sprintId: string[];
  /**
   * '@me' resolves server-side (buildCreatorCondition, mirroring
   * assigneeId's own '@me'/'@unassigned' sentinels) — added for W5.2's
   * workspace scope so "tickets I created" (YourWork's Created tab) is a
   * real server-side filter instead of a client-side predicate over every
   * ticket in the workspace.
   */
  creatorId: string[];
  /** Free-text title search — the typed filter's `text` field (§4.6),
   * added for W5.2. Already ilike-matched server-side (tickets.service.ts's
   * buildTypedFilterConditions); this hook only needed to start collecting
   * it and passing it through. */
  text: string;
}

export const EMPTY_FILTERS: TicketFilters = {
  priority: [],
  stateId: [],
  labelId: [],
  assigneeId: [],
  workstreamId: [],
  sprintId: [],
  creatorId: [],
  text: '',
};

export interface TicketGroup {
  key: string;
  label: string;
  color?: string;
  items: Ticket[];
}

/**
 * Translates this hook's local TicketFilters shape (unchanged, so every
 * existing caller of setFilters keeps working) into the server's typed
 * filter wire shape (ticketFilterSchema on the backend, §4.6). An entirely
 * empty TicketFilters encodes to `undefined` so a view with no filter
 * applied hits the same unfiltered `GET /projects/:id/tickets` path as
 * before, instead of round-tripping an empty `?filter=`.
 *
 * Exported (as of W5.3) so the saved-view filter editor can reuse this exact
 * translation to capture a live TicketsView's current filters into the typed
 * shape `createView`/`updateView` require, instead of re-deriving it. Note
 * the `undefined` collapse still applies here too — a caller that needs a
 * saved view's filter to never be empty (W5.3's own accept criterion) must
 * fall back to a real base object (e.g. `{ v: 1, projectIds: [...] }`)
 * itself; this function's contract (mirrors the unfiltered-fetch path)
 * isn't the place to special-case that.
 */
export function toFilterQuery(
  filters: TicketFilters,
): TicketFilterQuery | undefined {
  const query: TicketFilterQuery = { v: 1 };
  if (filters.priority.length) query.priorities = filters.priority;
  if (filters.stateId.length) query.stateIds = filters.stateId;
  if (filters.labelId.length) query.labelIds = filters.labelId;
  if (filters.assigneeId.length) query.assigneeIds = filters.assigneeId;
  if (filters.workstreamId.length) query.workstreamIds = filters.workstreamId;
  if (filters.sprintId.length) query.sprintIds = filters.sprintId;
  if (filters.creatorId.length) query.creatorIds = filters.creatorId;
  if (filters.text.trim()) query.text = filters.text.trim();
  return Object.keys(query).length > 1 ? query : undefined;
}

export interface TicketsViewOptions {
  /**
   * Omitted (or undefined) means workspace-wide — every ticket across every
   * project, via `GET /tickets?filter=`. This is what makes the project
   * scope and the workspace scope (W5.2, architecture §P5) the same
   * component with a different default filter rather than two
   * implementations: TicketsLayout passes its project's id, the new
   * workspace-wide screens (AllTicketsPage, YourWork's Assigned/Created
   * tabs) pass none.
   */
  projectId?: string;
  /**
   * Seeds the initial filter state — e.g. `{ assigneeId: ['@me'] }` for
   * YourWork's Assigned tab, `{ creatorId: ['@me'] }` for its Created tab.
   * Applied once, on mount, the same way EMPTY_FILTERS is; the user can
   * still change or clear it afterward like any other filter.
   */
  defaultFilters?: Partial<TicketFilters>;
  /** Defaults to 'state', matching every project-scoped caller today. The
   * workspace scope passes 'project' (mockup: buildTicketView's atView). */
  defaultGroupBy?: GroupBy;
}

/**
 * Shared state + data for every ticket view (List, Board, Calendar,
 * Spreadsheet, Gantt) across all three W5.2 scopes — a single project, the
 * whole workspace, or a sparse project (which is just the project scope
 * applied to a project with few/no sprints or workstreams; see TicketList's
 * own comment for why that needs no separate code path here). All views for
 * a given scope should be built on top of ONE instance of this hook (passed
 * down as a prop, the way ListView/BoardView already receive `view`) rather
 * than each mounting its own — otherwise the toolbar's filter state has
 * nothing to reach.
 *
 * Filtering itself happens server-side (§4.6): changing `filters` triggers
 * a refetch of `listTickets(projectId, filter)` / `listAllTickets(filter)`
 * with the filter encoded into `?filter=`, rather than a client-side
 * predicate over an always-fully-fetched list. There is exactly one fetched
 * set — `items` and `allItems` are the same array; the latter name is kept
 * only so existing consumers (e.g. ListView's/BoardView's sub-item stats)
 * don't need to change, though it no longer means "every ticket regardless
 * of the active filter" the way it did before filtering moved server-side.
 * groupedItems partitions `items` exhaustively (every group set, including
 * 'none'/'unassigned' buckets, is a total predicate over `items`), which is
 * what keeps a rendered ticket-list's count line equal to its rendered row
 * count (W5.2's accept criterion) — nothing here or in TicketList ever
 * re-filters `items` client-side on top of the server-side result.
 */
export function useTicketsView(options: TicketsViewOptions = {}) {
  const { projectId, defaultFilters, defaultGroupBy = 'state' } = options;
  const [filters, setFilters] = useState<TicketFilters>(() => ({
    ...EMPTY_FILTERS,
    ...defaultFilters,
  }));
  const filterQuery = useMemo(() => toFilterQuery(filters), [filters]);

  const {
    data: items,
    loading: itemsLoading,
    reload,
    setData: setItems,
  } = useAsync(
    () =>
      projectId
        ? listTickets(projectId, filterQuery)
        : listAllTickets(filterQuery),
    [projectId, filterQuery],
  );

  // Memoized so an undefined `items` (still loading) doesn't hand
  // groupedItems' useMemo below a fresh [] reference on every render.
  const resolvedItems = useMemo(() => items ?? [], [items]);

  // The set of projects actually represented in the current result —
  // exactly [projectId] in project scope (so this degrades to the original
  // single-project fetches below with no behavior change), or every
  // distinct project the loaded tickets span in workspace scope. Bounded by
  // what's on screen, not every project in the workspace: states/labels are
  // per-project-customizable with no workspace-wide list endpoint, so this
  // mirrors the same bounded Promise.all shape YourWork.tsx's loadYourWork
  // already used for exactly this problem before W5.2.
  const distinctProjectIds = useMemo(() => {
    if (projectId) return [projectId];
    return Array.from(new Set(resolvedItems.map((i) => i.projectId))).sort();
  }, [projectId, resolvedItems]);
  const projectIdsKey = distinctProjectIds.join(',');

  const { data: statesLists, loading: statesLoading } = useAsync(
    () => Promise.all(distinctProjectIds.map((pid) => listStates(pid))),
    [projectIdsKey],
  );
  // Deduped by id defensively — real state/label rows are project-owned
  // with server-generated ids so two different real projects can never
  // collide, but a duplicate id here (stale data, a test double, a future
  // caller reusing this hook in some odd way) must not silently double-count
  // a group's rows the way an un-deduped `states` array would under 'state'
  // grouping — that's exactly the count-line invariant this hook exists to
  // protect.
  const states = useMemo(
    () =>
      Array.from(
        new Map((statesLists ?? []).flat().map((s) => [s.id, s])).values(),
      ),
    [statesLists],
  );

  const { data: labelsLists } = useAsync(
    () => Promise.all(distinctProjectIds.map((pid) => listLabels(pid))),
    [projectIdsKey],
  );
  const labels = useMemo(
    () =>
      Array.from(
        new Map((labelsLists ?? []).flat().map((l) => [l.id, l])).values(),
      ),
    [labelsLists],
  );

  // Workstreams/sprints DO have workspace-wide list endpoints already
  // (listAllWorkstreams/listAllSprints — pre-existing, used by Topbar's
  // command palette), so workspace scope uses those directly instead of
  // the bounded-per-project approach states/labels need above.
  const { data: workstreams } = useAsync(
    () => (projectId ? listWorkstreams(projectId) : listAllWorkstreams()),
    [projectId],
  );
  const { data: sprints } = useAsync(
    () => (projectId ? listSprints(projectId) : listAllSprints()),
    [projectId],
  );

  // Only fetched in workspace scope — used for the 'project' groupBy option
  // and TicketList's project column/badge (showProjectColumn). Project
  // scope already knows its one project from context (useProject()), so
  // this stays empty there rather than firing a redundant fetch.
  const { data: projectsData } = useAsync(
    () => (projectId ? Promise.resolve([] as Project[]) : listProjects()),
    [projectId],
  );
  const projects = projectsData ?? [];

  const loading = itemsLoading || statesLoading;

  const [groupBy, setGroupBy] = useState<GroupBy>(defaultGroupBy);
  const [showEmptyGroups, setShowEmptyGroups] = useState(true);

  const stateById = useMemo(
    () => new Map(states.map((s) => [s.id, s])),
    [states],
  );
  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  const groupedItems: TicketGroup[] = useMemo(() => {
    function build(
      key: string,
      label: string,
      color: string | undefined,
      predicate: (i: Ticket) => boolean,
    ): TicketGroup {
      return { key, label, color, items: resolvedItems.filter(predicate) };
    }

    let groups: TicketGroup[];
    switch (groupBy) {
      case 'state': {
        const orderedStates = [...states].sort(
          (a, b) =>
            STATE_GROUP_ORDER.indexOf(a.group) -
              STATE_GROUP_ORDER.indexOf(b.group) || a.sortOrder - b.sortOrder,
        );
        groups = orderedStates.map((s) =>
          build(s.id, s.name, s.color, (i) => i.stateId === s.id),
        );
        break;
      }
      case 'priority':
        groups = PRIORITY_ORDER.map((p) =>
          build(p, p, undefined, (i) => i.priority === p),
        );
        break;
      case 'workstream':
        groups = [
          ...(workstreams ?? []).map((m) =>
            build(m.id, m.name, undefined, (i) => i.workstreamId === m.id),
          ),
          build('none', 'No workstream', undefined, (i) => !i.workstreamId),
        ];
        break;
      case 'sprint':
        groups = [
          ...(sprints ?? []).map((c) =>
            build(c.id, c.name, undefined, (i) => i.sprintId === c.id),
          ),
          build('none', 'No sprint', undefined, (i) => !i.sprintId),
        ];
        break;
      case 'assignee':
        groups = [
          build(
            'assigned',
            'Assigned',
            undefined,
            (i) => i.assigneeIds.length > 0,
          ),
          build(
            'unassigned',
            'Unassigned',
            undefined,
            (i) => i.assigneeIds.length === 0,
          ),
        ];
        break;
      case 'project':
        groups = distinctProjectIds.map((pid) =>
          build(
            pid,
            projectById.get(pid)?.name ?? 'Unknown project',
            undefined,
            (i) => i.projectId === pid,
          ),
        );
        break;
      default:
        groups = [build('all', 'All tickets', undefined, () => true)];
    }

    return showEmptyGroups ? groups : groups.filter((g) => g.items.length > 0);
  }, [
    resolvedItems,
    groupBy,
    states,
    workstreams,
    sprints,
    showEmptyGroups,
    distinctProjectIds,
    projectById,
  ]);

  function stateFor(item: Ticket): TicketState | undefined {
    return stateById.get(item.stateId);
  }

  function projectFor(item: Ticket): Project | undefined {
    return projectById.get(item.projectId);
  }

  /**
   * Apply a patch to a single item in local state immediately, without
   * refetching — used for optimistic UI updates (e.g. drag-and-drop between
   * board columns) so the view doesn't flash back to its loading skeleton
   * for a change the caller already knows the outcome of. Mirrors the mock
   * API's own behavior of moving an item to the end of the list when its
   * state changes, so it sorts to the bottom of its new group here too.
   */
  function patchItemLocally(id: string, patch: Partial<Ticket>) {
    setItems((prev) => {
      if (!prev) return prev as unknown as Ticket[];
      const index = prev.findIndex((i) => i.id === id);
      if (index === -1) return prev;
      const updated = { ...prev[index], ...patch };
      const stateChanged = Boolean(
        patch.stateId && patch.stateId !== prev[index].stateId,
      );
      const rest = [...prev.slice(0, index), ...prev.slice(index + 1)];
      if (stateChanged) return [...rest, updated];
      return [...prev.slice(0, index), updated, ...prev.slice(index + 1)];
    });
  }

  /**
   * Move `id` to sit directly before/after `targetId`, optimistically —
   * mirrors data/api.ts's reorderTicket so dragging a card to a specific
   * spot (not just onto a column) reflects instantly instead of waiting on
   * a reload. Adopts the target's state too, matching the server behavior.
   */
  function reorderItemLocally(
    id: string,
    targetId: string,
    position: 'before' | 'after',
  ) {
    setItems((prev) => {
      if (!prev || id === targetId) return prev as unknown as Ticket[];
      const from = prev.find((i) => i.id === id);
      const target = prev.find((i) => i.id === targetId);
      if (!from || !target) return prev;
      const moved = { ...from, stateId: target.stateId };
      const rest = prev.filter((i) => i.id !== id);
      const targetIndex = rest.findIndex((i) => i.id === targetId);
      const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
      return [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
    });
  }

  return {
    projectId,
    items: resolvedItems,
    allItems: resolvedItems,
    loading,
    reload,
    patchItemLocally,
    reorderItemLocally,
    states,
    labels,
    workstreams: workstreams ?? [],
    sprints: sprints ?? [],
    projects,
    filters,
    setFilters,
    groupBy,
    setGroupBy,
    groupedItems,
    showEmptyGroups,
    setShowEmptyGroups,
    stateFor,
    projectFor,
  };
}

export type TicketsView = ReturnType<typeof useTicketsView>;
