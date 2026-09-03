import { useMemo, useState } from 'react';
import { useAsync } from '@/lib/useAsync';
import { listWorkItems, listStates, listLabels, listModules, listCycles } from '@/data/api';
import type { WorkItem, WorkItemState, Priority } from '@/types/entities';
import { STATE_GROUP_ORDER } from '@/components/domain/StateIcon';
import { PRIORITY_ORDER } from '@/components/domain/PriorityIcon';

export type GroupBy = 'state' | 'priority' | 'module' | 'cycle' | 'assignee' | 'none';
export type ViewKind = 'list' | 'board' | 'calendar' | 'spreadsheet' | 'gantt';

export interface WorkItemFilters {
  priority: Priority[];
  stateId: string[];
  labelId: string[];
  assigneeId: string[];
  moduleId: string[];
  cycleId: string[];
}

export const EMPTY_FILTERS: WorkItemFilters = {
  priority: [],
  stateId: [],
  labelId: [],
  assigneeId: [],
  moduleId: [],
  cycleId: [],
};

export interface WorkItemGroup {
  key: string;
  label: string;
  color?: string;
  items: WorkItem[];
}

/**
 * Shared state + data for every work-item view (List, Board, Calendar,
 * Spreadsheet, Gantt) on a single project. All five views should be built on
 * top of this hook rather than re-fetching or re-deriving filter/group logic
 * independently, so switching views never loses filter/sort state.
 */
export function useWorkItemsView(projectId: string) {
  const { data: items, loading, reload, setData: setItems } = useAsync(() => listWorkItems(projectId), [projectId]);
  const { data: states } = useAsync(() => listStates(projectId), [projectId]);
  const { data: labels } = useAsync(() => listLabels(projectId), [projectId]);
  const { data: modules } = useAsync(() => listModules(projectId), [projectId]);
  const { data: cycles } = useAsync(() => listCycles(projectId), [projectId]);

  const [filters, setFilters] = useState<WorkItemFilters>(EMPTY_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>('state');
  const [showEmptyGroups, setShowEmptyGroups] = useState(true);

  const filteredItems = useMemo(() => {
    if (!items) return [];
    return items.filter((item) => {
      if (filters.priority.length && !filters.priority.includes(item.priority)) return false;
      if (filters.stateId.length && !filters.stateId.includes(item.stateId)) return false;
      if (filters.labelId.length && !item.labelIds.some((id) => filters.labelId.includes(id))) return false;
      if (filters.assigneeId.length && !item.assigneeIds.some((id) => filters.assigneeId.includes(id))) return false;
      if (filters.moduleId.length && (!item.moduleId || !filters.moduleId.includes(item.moduleId))) return false;
      if (filters.cycleId.length && (!item.cycleId || !filters.cycleId.includes(item.cycleId))) return false;
      return true;
    });
  }, [items, filters]);

  const stateById = useMemo(() => new Map((states ?? []).map((s) => [s.id, s])), [states]);

  const groupedItems: WorkItemGroup[] = useMemo(() => {
    if (!states) return [];

    function build(key: string, label: string, color: string | undefined, predicate: (i: WorkItem) => boolean): WorkItemGroup {
      return { key, label, color, items: filteredItems.filter(predicate) };
    }

    let groups: WorkItemGroup[];
    switch (groupBy) {
      case 'state': {
        const orderedStates = [...states].sort(
          (a, b) => STATE_GROUP_ORDER.indexOf(a.group) - STATE_GROUP_ORDER.indexOf(b.group) || a.sortOrder - b.sortOrder,
        );
        groups = orderedStates.map((s) => build(s.id, s.name, s.color, (i) => i.stateId === s.id));
        break;
      }
      case 'priority':
        groups = PRIORITY_ORDER.map((p) => build(p, p, undefined, (i) => i.priority === p));
        break;
      case 'module':
        groups = [
          ...(modules ?? []).map((m) => build(m.id, m.name, undefined, (i) => i.moduleId === m.id)),
          build('none', 'No module', undefined, (i) => !i.moduleId),
        ];
        break;
      case 'cycle':
        groups = [
          ...(cycles ?? []).map((c) => build(c.id, c.name, undefined, (i) => i.cycleId === c.id)),
          build('none', 'No cycle', undefined, (i) => !i.cycleId),
        ];
        break;
      case 'assignee':
        groups = [build('assigned', 'Assigned', undefined, (i) => i.assigneeIds.length > 0), build('unassigned', 'Unassigned', undefined, (i) => i.assigneeIds.length === 0)];
        break;
      default:
        groups = [build('all', 'All work items', undefined, () => true)];
    }

    return showEmptyGroups ? groups : groups.filter((g) => g.items.length > 0);
  }, [filteredItems, groupBy, states, modules, cycles, showEmptyGroups]);

  function stateFor(item: WorkItem): WorkItemState | undefined {
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
  function patchItemLocally(id: string, patch: Partial<WorkItem>) {
    setItems((prev) => {
      if (!prev) return prev as unknown as WorkItem[];
      const index = prev.findIndex((i) => i.id === id);
      if (index === -1) return prev;
      const updated = { ...prev[index], ...patch };
      const stateChanged = Boolean(patch.stateId && patch.stateId !== prev[index].stateId);
      const rest = [...prev.slice(0, index), ...prev.slice(index + 1)];
      if (stateChanged) return [...rest, updated];
      return [...prev.slice(0, index), updated, ...prev.slice(index + 1)];
    });
  }

  /**
   * Move `id` to sit directly before/after `targetId`, optimistically —
   * mirrors data/api.ts's reorderWorkItem so dragging a card to a specific
   * spot (not just onto a column) reflects instantly instead of waiting on
   * a reload. Adopts the target's state too, matching the server behavior.
   */
  function reorderItemLocally(id: string, targetId: string, position: 'before' | 'after') {
    setItems((prev) => {
      if (!prev || id === targetId) return prev as unknown as WorkItem[];
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
    items: filteredItems,
    allItems: items ?? [],
    loading,
    reload,
    patchItemLocally,
    reorderItemLocally,
    states: states ?? [],
    labels: labels ?? [],
    modules: modules ?? [],
    cycles: cycles ?? [],
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

export type WorkItemsView = ReturnType<typeof useWorkItemsView>;
