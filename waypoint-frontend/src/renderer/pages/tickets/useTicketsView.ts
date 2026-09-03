import { useMemo, useState } from 'react';
import { useAsync } from '@/lib/useAsync';
import {
  listTickets,
  listStates,
  listLabels,
  listWorkstreams,
  listSprints,
} from '@/data/api';
import type {
  Ticket,
  TicketState,
  Priority,
  TicketFilterQuery,
} from '@/types/entities';
import { STATE_GROUP_ORDER } from '@/components/domain/StateIcon';
import { PRIORITY_ORDER } from '@/components/domain/PriorityIcon';

export type GroupBy =
  'state' | 'priority' | 'workstream' | 'sprint' | 'assignee' | 'none';
export type ViewKind = 'list' | 'board' | 'calendar' | 'spreadsheet' | 'gantt';

export interface TicketFilters {
  priority: Priority[];
  stateId: string[];
  labelId: string[];
  assigneeId: string[];
  workstreamId: string[];
  sprintId: string[];
}

export const EMPTY_FILTERS: TicketFilters = {
  priority: [],
  stateId: [],
  labelId: [],
  assigneeId: [],
  workstreamId: [],
  sprintId: [],
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
 */
function toFilterQuery(filters: TicketFilters): TicketFilterQuery | undefined {
  const query: TicketFilterQuery = { v: 1 };
  if (filters.priority.length) query.priorities = filters.priority;
  if (filters.stateId.length) query.stateIds = filters.stateId;
  if (filters.labelId.length) query.labelIds = filters.labelId;
  if (filters.assigneeId.length) query.assigneeIds = filters.assigneeId;
  if (filters.workstreamId.length) query.workstreamIds = filters.workstreamId;
  if (filters.sprintId.length) query.sprintIds = filters.sprintId;
  return Object.keys(query).length > 1 ? query : undefined;
}

/**
 * Shared state + data for every ticket view (List, Board, Calendar,
 * Spreadsheet, Gantt) on a single project. All five views should be built
 * on top of ONE instance of this hook (passed down as a prop, the way
 * ListView/BoardView already receive `view`) rather than each mounting
 * its own — otherwise the toolbar's filter state has nothing to reach.
 *
 * Filtering itself happens server-side (§4.6): changing `filters` triggers
 * a refetch of `listTickets(projectId, filter)` with the filter encoded
 * into `?filter=`, rather than a client-side predicate over an
 * always-fully-fetched list. There is exactly one fetched set — `items`
 * and `allItems` are the same array; the latter name is kept only so
 * existing consumers (e.g. ListView's/BoardView's sub-item stats) don't
 * need to change, though it no longer means "every ticket regardless of
 * the active filter" the way it did before filtering moved server-side.
 */
export function useTicketsView(projectId: string) {
  const [filters, setFilters] = useState<TicketFilters>(EMPTY_FILTERS);
  const filterQuery = useMemo(() => toFilterQuery(filters), [filters]);

  const {
    data: items,
    loading,
    reload,
    setData: setItems,
  } = useAsync(
    () => listTickets(projectId, filterQuery),
    [projectId, filterQuery],
  );
  const { data: states } = useAsync(() => listStates(projectId), [projectId]);
  const { data: labels } = useAsync(() => listLabels(projectId), [projectId]);
  const { data: workstreams } = useAsync(
    () => listWorkstreams(projectId),
    [projectId],
  );
  const { data: sprints } = useAsync(() => listSprints(projectId), [projectId]);

  const [groupBy, setGroupBy] = useState<GroupBy>('state');
  const [showEmptyGroups, setShowEmptyGroups] = useState(true);

  // Memoized so an undefined `items` (still loading) doesn't hand
  // groupedItems' useMemo below a fresh [] reference on every render.
  const resolvedItems = useMemo(() => items ?? [], [items]);
  const stateById = useMemo(
    () => new Map((states ?? []).map((s) => [s.id, s])),
    [states],
  );

  const groupedItems: TicketGroup[] = useMemo(() => {
    if (!states) return [];

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
      default:
        groups = [build('all', 'All tickets', undefined, () => true)];
    }

    return showEmptyGroups ? groups : groups.filter((g) => g.items.length > 0);
  }, [resolvedItems, groupBy, states, workstreams, sprints, showEmptyGroups]);

  function stateFor(item: Ticket): TicketState | undefined {
    return stateById.get(item.stateId);
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
    items: resolvedItems,
    allItems: resolvedItems,
    loading,
    reload,
    patchItemLocally,
    reorderItemLocally,
    states: states ?? [],
    labels: labels ?? [],
    workstreams: workstreams ?? [],
    sprints: sprints ?? [],
    filters,
    setFilters,
    groupBy,
    setGroupBy,
    groupedItems,
    showEmptyGroups,
    setShowEmptyGroups,
    stateFor,
  };
}

export type TicketsView = ReturnType<typeof useTicketsView>;
