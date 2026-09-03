import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { ChevronUp, ChevronDown, ChevronsUpDown, Columns3 } from 'lucide-react';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { listMembers } from '@/data/api';
import { useTicketsView } from './useTicketsView';
import { Popover } from '@/pages/tickets/Popover';
import { Button } from '@/components/ui/Button';
import { Badge, Dot } from '@/components/ui/Badge';
import type { Ticket } from '@/types/entities';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton, SkeletonTableRows } from '@/components/ui/Skeleton';
import { StateIcon } from '@/components/domain/StateIcon';
import { PriorityIcon, PRIORITY_LABEL, PRIORITY_ORDER } from '@/components/domain/PriorityIcon';
import { AvatarStack } from '@/components/ui/Avatar';

type SortKey =
  | 'title'
  | 'state'
  | 'priority'
  | 'assignees'
  | 'createdAt'
  | 'updatedAt'
  | 'labels'
  | 'dueDate'
  | 'workstreams'
  | 'sprint'
  | 'estimate';

type SortDir = 'asc' | 'desc';

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const TITLE_COLUMN = { key: 'title' as const, label: 'Ticket' };

/** Columns available through the "Columns" toggle, beyond the always-shown "Ticket" column. */
const OPTIONAL_COLUMNS: { key: Exclude<SortKey, 'title'>; label: string }[] = [
  { key: 'state', label: 'State' },
  { key: 'priority', label: 'Priority' },
  { key: 'assignees', label: 'Assignees' },
  { key: 'createdAt', label: 'Created on' },
  { key: 'updatedAt', label: 'Updated on' },
  { key: 'labels', label: 'Labels' },
  { key: 'dueDate', label: 'Due date' },
  { key: 'workstreams', label: 'Workstreams' },
  { key: 'sprint', label: 'Sprint' },
];

const DEFAULT_VISIBLE: Exclude<SortKey, 'title'>[] = ['state', 'priority', 'assignees', 'createdAt'];

function toggleInArray<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

/**
 * Dense sortable table of tickets. Every header is client-side sortable
 * (ascending/descending on click); "Created on" always shows the absolute
 * creation date, never relative time. Columns beyond "Ticket" can be
 * shown/hidden via the "Columns" dropdown; the selection lives in local
 * component state only (does not persist across reloads).
 */
export default function SpreadsheetView({ onOpenItem }: { onOpenItem: (identifier: string) => void }) {
  const { project } = useProject();
  const { items, loading, stateFor, labels, workstreams, sprints } = useTicketsView(project.id);
  const { data: members } = useAsync(() => listMembers(), []);
  const [sortKey, setSortKey] = useState<SortKey>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [visible, setVisible] = useState<Set<Exclude<SortKey, 'title'>>>(new Set(DEFAULT_VISIBLE));

  const memberById = useMemo(() => new Map((members ?? []).map((m) => [m.id, m])), [members]);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  const workstreamById = useMemo(() => new Map(workstreams.map((m) => [m.id, m])), [workstreams]);
  const sprintById = useMemo(() => new Map(sprints.map((c) => [c.id, c])), [sprints]);

  const hasEstimates = !!project.estimate;
  const columns = useMemo(() => {
    const optional = hasEstimates
      ? [...OPTIONAL_COLUMNS, { key: 'estimate' as const, label: 'Estimate' }]
      : OPTIONAL_COLUMNS;
    return [TITLE_COLUMN, ...optional.filter((c) => visible.has(c.key))];
  }, [visible, hasEstimates]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sortedItems = useMemo(() => {
    function compare(a: Ticket, b: Ticket): number {
      switch (sortKey) {
        case 'title':
          return a.title.localeCompare(b.title);
        case 'state': {
          const an = stateFor(a)?.name ?? '';
          const bn = stateFor(b)?.name ?? '';
          return an.localeCompare(bn);
        }
        case 'priority':
          return PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
        case 'assignees':
          return a.assigneeIds.length - b.assigneeIds.length;
        case 'updatedAt':
          return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        case 'labels':
          return a.labelIds.length - b.labelIds.length;
        case 'dueDate':
          return (a.dueDate ? new Date(a.dueDate).getTime() : Infinity) - (b.dueDate ? new Date(b.dueDate).getTime() : Infinity);
        case 'workstreams': {
          const an = a.workstreamId ? (workstreamById.get(a.workstreamId)?.name ?? '') : '';
          const bn = b.workstreamId ? (workstreamById.get(b.workstreamId)?.name ?? '') : '';
          return an.localeCompare(bn);
        }
        case 'sprint': {
          const an = a.sprintId ? (sprintById.get(a.sprintId)?.name ?? '') : '';
          const bn = b.sprintId ? (sprintById.get(b.sprintId)?.name ?? '') : '';
          return an.localeCompare(bn);
        }
        case 'estimate':
          return (a.estimateValue ?? '').localeCompare(b.estimateValue ?? '');
        case 'createdAt':
        default:
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
    }
    const sorted = [...items].sort(compare);
    return sortDir === 'asc' ? sorted : sorted.reverse();
  }, [items, sortKey, sortDir, stateFor, workstreamById, sprintById]);

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-end border-b border-border px-4 py-2">
          <Skeleton>
            <Skeleton.Block height="1.75rem" width="6.5rem" rounded="rounded-[var(--radius-sm)]" />
          </Skeleton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
          <SkeletonTableRows rows={10} columns={6} />
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return <EmptyState title="No tickets" description="Tickets matching the current filters will show up here." />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end border-b border-border px-4 py-2">
        <Popover
          align="end"
          trigger={({ open, toggle }) => (
            <Button variant={open ? 'secondary' : 'ghost'} size="sm" onClick={toggle}>
              <Columns3 size={14} />
              Columns
              <ChevronDown size={13} />
            </Button>
          )}
        >
          <div className="flex w-48 flex-col">
            <p className="mb-1 px-2 pt-1 text-xs font-medium tracking-wide text-text-muted uppercase">
              Toggle columns
            </p>
            {(hasEstimates ? [...OPTIONAL_COLUMNS, { key: 'estimate' as const, label: 'Estimate' }] : OPTIONAL_COLUMNS).map(
              (col) => (
                <label
                  key={col.key}
                  className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={visible.has(col.key)}
                    onChange={() => setVisible((prev) => new Set(toggleInArray([...prev], col.key)))}
                  />
                  {col.label}
                </label>
              ),
            )}
          </div>
        </Popover>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[880px] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr className="border-b border-border">
              {columns.map((col) => {
                const active = sortKey === col.key;
                return (
                  <th key={col.key} className="whitespace-nowrap px-4 py-2.5 text-left font-medium text-text-secondary">
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className="inline-flex cursor-pointer items-center gap-1 hover:text-text"
                    >
                      {col.label}
                      {active ? (
                        sortDir === 'asc' ? (
                          <ChevronUp size={13} />
                        ) : (
                          <ChevronDown size={13} />
                        )
                      ) : (
                        <ChevronsUpDown size={13} className="text-text-muted" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item) => {
              const state = stateFor(item);
              const assignees = item.assigneeIds
                .map((id) => memberById.get(id))
                .filter((m): m is NonNullable<typeof m> => !!m);
              const itemLabels = item.labelIds
                .map((id) => labelById.get(id))
                .filter((l): l is NonNullable<typeof l> => !!l);
              const workstream = item.workstreamId ? workstreamById.get(item.workstreamId) : undefined;
              const sprint = item.sprintId ? sprintById.get(item.sprintId) : undefined;
              return (
                <tr
                  key={item.id}
                  onClick={() => onOpenItem(item.identifier)}
                  className={clsx('cursor-pointer border-b border-border transition-colors hover:bg-surface-2')}
                >
                  <td className="max-w-[420px] px-4 py-2.5">
                    <span className="font-mono text-xs text-text-muted">{item.identifier}</span>{' '}
                    <span className="text-text">{item.title}</span>
                  </td>
                  {visible.has('state') && (
                    <td className="px-4 py-2.5">
                      {state ? (
                        <span className="inline-flex items-center gap-1.5 text-text-secondary">
                          <StateIcon state={state} />
                          {state.name}
                        </span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                  )}
                  {visible.has('priority') && (
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5 text-text-secondary">
                        <PriorityIcon priority={item.priority} />
                        {PRIORITY_LABEL[item.priority]}
                      </span>
                    </td>
                  )}
                  {visible.has('assignees') && (
                    <td className="px-4 py-2.5">
                      {assignees.length > 0 ? (
                        <AvatarStack people={assignees.map((m) => ({ name: m.displayName, color: m.avatarColor }))} />
                      ) : (
                        <span className="text-text-muted">Unassigned</span>
                      )}
                    </td>
                  )}
                  {visible.has('createdAt') && (
                    <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                      {DATE_FORMAT.format(new Date(item.createdAt))}
                    </td>
                  )}
                  {visible.has('updatedAt') && (
                    <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                      {DATE_FORMAT.format(new Date(item.updatedAt))}
                    </td>
                  )}
                  {visible.has('labels') && (
                    <td className="px-4 py-2.5">
                      {itemLabels.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1">
                          {itemLabels.map((l) => (
                            <Badge key={l.id} tone="neutral">
                              <Dot color={l.color} />
                              {l.name}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                  )}
                  {visible.has('dueDate') && (
                    <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                      {item.dueDate ? DATE_FORMAT.format(new Date(item.dueDate)) : <span className="text-text-muted">—</span>}
                    </td>
                  )}
                  {visible.has('workstreams') && (
                    <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                      {workstream ? workstream.name : <span className="text-text-muted">—</span>}
                    </td>
                  )}
                  {visible.has('sprint') && (
                    <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                      {sprint ? sprint.name : <span className="text-text-muted">—</span>}
                    </td>
                  )}
                  {hasEstimates && visible.has('estimate') && (
                    <td className="whitespace-nowrap px-4 py-2.5 text-text-secondary">
                      {item.estimateValue ?? <span className="text-text-muted">—</span>}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
