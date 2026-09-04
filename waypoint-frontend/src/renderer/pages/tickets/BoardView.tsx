import { useMemo, useState } from 'react';
import { Kanban, ListChecks, Link2, Terminal } from 'lucide-react';
import { IconPlus } from '@/components/icons';
import { clsx } from 'clsx';
import { useAsync } from '@/lib/useAsync';
import {
  listAgentAssignments,
  listAgents,
  listMembers,
  updateTicket,
  reorderTicket,
} from '@/data/api';
import { Badge, Dot } from '@/components/ui/Badge';
import { AvatarStack } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { StateIcon } from '@/components/domain/StateIcon';
import { PriorityIcon } from '@/components/domain/PriorityIcon';
import { AGENT_STATUS_CONFIG } from '@/components/domain/AgentStatusBadge';
import { CreateTicketModal } from '@/components/domain/CreateTicketModal';
import {
  hasActiveFilters,
  type TicketsView,
} from '@/pages/tickets/useTicketsView';
import type { Ticket } from '@/types/entities';
import { Skeleton } from '@/components/ui/Skeleton';

export default function BoardView({
  view,
  projectId,
  onOpenItem,
}: {
  view: TicketsView;
  projectId: string;
  onOpenItem: (identifier: string) => void;
}) {
  const { data: members } = useAsync(() => listMembers(), []);
  const { data: agents } = useAsync(() => listAgents(), []);
  const { data: agentAssignments } = useAsync(() => listAgentAssignments(), []);
  const [createForGroup, setCreateForGroup] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [dragOverCard, setDragOverCard] = useState<{
    id: string;
    position: 'before' | 'after';
  } | null>(null);

  const memberById = useMemo(
    () => new Map((members ?? []).map((m) => [m.id, m])),
    [members],
  );
  const agentById = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a])),
    [agents],
  );
  const assignmentByKey = useMemo(
    () =>
      new Map(
        (agentAssignments ?? []).map((a) => [`${a.ticketId}:${a.agentId}`, a]),
      ),
    [agentAssignments],
  );
  const labelById = useMemo(
    () => new Map(view.labels.map((l) => [l.id, l])),
    [view.labels],
  );

  // A ticket's first agent id (if any) drives the board badge — the seed
  // data only ever pairs one agent per ticket, and a single status chip per
  // card keeps the badge row from overflowing.
  function primaryAgentAssignment(item: Ticket) {
    const agentId = item.assigneeIds.find((id) => agentById.has(id));
    if (!agentId) return null;
    const agent = agentById.get(agentId);
    if (!agent) return null;
    return { agent, assignment: assignmentByKey.get(`${item.id}:${agentId}`) };
  }
  const canReorderPersist = view.groupBy === 'state';

  // Built from `view.subItemCountByParent` (a genuinely unfiltered dataset),
  // not `view.allItems` (which, despite the name, is the currently FILTERED
  // set — see useTicketsView's own doc comment) — a completion badge
  // answering "how much of this parent is done" must not undercount just
  // because the active filter narrowed the visible list.
  function subItemStats(item: Ticket) {
    return view.subItemCountByParent.get(item.id) ?? { total: 0, done: 0 };
  }

  function assigneesFor(item: Ticket) {
    return item.assigneeIds
      .map((id) => {
        const m = memberById.get(id);
        if (m)
          return {
            name: m.displayName,
            color: m.avatarColor,
            shape: 'circle' as const,
          };
        const a = agentById.get(id);
        if (a)
          return {
            name: a.name,
            color: a.avatarColor,
            shape: 'square' as const,
          };
        return null;
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
  }

  function handleDrop(groupKey: string) {
    setDragOverGroup(null);
    const itemId = draggingId;
    setDraggingId(null);
    if (!itemId || !canReorderPersist) return;
    const item = view.items.find((i) => i.id === itemId);
    if (!item || item.stateId === groupKey) return;
    // Optimistic: update local state immediately so the board doesn't flash
    // back to its loading skeleton, then persist in the background.
    view.patchItemLocally(item.id, { stateId: groupKey });
    void updateTicket(item.id, { stateId: groupKey });
  }

  function handleCardDrop(targetId: string) {
    const itemId = draggingId;
    const position = dragOverCard?.position ?? 'after';
    setDragOverGroup(null);
    setDragOverCard(null);
    setDraggingId(null);
    if (!itemId || !canReorderPersist || itemId === targetId) return;
    // Optimistic: reposition locally first so the card lands immediately,
    // then persist the same move in the background.
    view.reorderItemLocally(itemId, targetId, position);
    void reorderTicket(itemId, targetId, position);
  }

  if (view.loading) {
    return (
      <Skeleton className="flex h-full items-start gap-3 overflow-x-auto px-6 py-4">
        {Array.from({ length: 4 }).map((_, colIndex) => (
          <div
            key={colIndex}
            className="flex max-h-full w-[300px] shrink-0 flex-col rounded-[var(--radius)] bg-surface-2"
          >
            <div className="flex items-center gap-2 px-3 py-2.5">
              <Skeleton.Block
                height="0.875rem"
                width={colIndex % 2 === 0 ? '6rem' : '4.5rem'}
              />
            </div>
            <div className="flex flex-col gap-2 px-2 pb-3">
              {Array.from({ length: 2 + (colIndex % 2) }).map(
                (_, cardIndex) => (
                  <Skeleton.Block
                    key={cardIndex}
                    height="6rem"
                    rounded="rounded-[var(--radius-sm)]"
                  />
                ),
              )}
            </div>
          </div>
        ))}
      </Skeleton>
    );
  }

  if (!view.loading && view.items.length === 0) {
    // Same fix as TicketList.tsx's ListView: a filter/search active with
    // zero results is not the same as the project genuinely having no
    // tickets — the two used to share identical "Create your first
    // ticket..." copy.
    const searching = hasActiveFilters(view.filters, view.defaultFilters);
    return (
      <EmptyState
        icon={<Kanban size={28} />}
        title={searching ? 'No matching tickets' : 'No tickets'}
        description={
          searching
            ? 'No tickets match your search or filters.'
            : 'Create your first ticket to start tracking work in this project.'
        }
        action={
          searching ? (
            <button
              type="button"
              onClick={() => view.resetFilters()}
              className="cursor-pointer text-sm font-medium text-accent hover:underline"
            >
              Clear filters
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setCreateForGroup('none')}
              className="cursor-pointer text-sm font-medium text-accent hover:underline"
            >
              + New ticket
            </button>
          )
        }
      />
    );
  }

  return (
    <div className="flex h-full items-start gap-3 overflow-x-auto px-6 py-4">
      {view.groupedItems.map((group) => (
        <div
          key={group.key}
          onDragOver={(e) => {
            if (!canReorderPersist) return;
            e.preventDefault();
            if (dragOverGroup !== group.key) setDragOverGroup(group.key);
          }}
          onDragLeave={() =>
            setDragOverGroup((k) => (k === group.key ? null : k))
          }
          onDrop={(e) => {
            e.preventDefault();
            handleDrop(group.key);
          }}
          className={clsx(
            'flex max-h-full w-[300px] shrink-0 flex-col rounded-[var(--radius)] bg-surface-2 transition-shadow',
            dragOverGroup === group.key &&
              canReorderPersist &&
              'ring-2 ring-accent',
          )}
        >
          <div className="flex items-center gap-2 px-3 py-2.5">
            {group.color && <Dot color={group.color} />}
            <span className="font-display text-sm font-medium text-text">
              {group.label}
            </span>
            <span className="font-mono text-xs text-text-muted">
              {group.items.length}
            </span>
            <button
              type="button"
              onClick={() => setCreateForGroup(group.key)}
              aria-label="New ticket"
              className="ml-auto cursor-pointer rounded-[var(--radius-sm)] p-1 text-text-muted hover:bg-surface hover:text-accent"
            >
              <IconPlus size={14} />
            </button>
          </div>

          <div className="thin-scroll flex min-h-[40px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
            {group.items.map((item) => {
              const state = view.stateFor(item);
              const labels = item.labelIds
                .map((id) => labelById.get(id))
                .filter((l): l is NonNullable<typeof l> => Boolean(l));
              const { total: subTotal, done: subDone } = subItemStats(item);
              const agentAssignment = primaryAgentAssignment(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onOpenItem(item.identifier)}
                  draggable={canReorderPersist}
                  onDragStart={(e) => {
                    e.stopPropagation();
                    setDraggingId(item.id);
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDragOverCard(null);
                  }}
                  onDragOver={(e) => {
                    if (
                      !canReorderPersist ||
                      !draggingId ||
                      draggingId === item.id
                    )
                      return;
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const position =
                      e.clientY < rect.top + rect.height / 2
                        ? 'before'
                        : 'after';
                    setDragOverCard((c) =>
                      c?.id === item.id && c.position === position
                        ? c
                        : { id: item.id, position },
                    );
                  }}
                  onDragLeave={() =>
                    setDragOverCard((c) => (c?.id === item.id ? null : c))
                  }
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleCardDrop(item.id);
                  }}
                  className={clsx(
                    'flex flex-col gap-2 rounded-[var(--radius-sm)] border border-border bg-surface p-3 text-left text-sm shadow-sm hover:border-border-strong',
                    draggingId === item.id && 'opacity-50',
                    dragOverCard?.id === item.id &&
                      dragOverCard.position === 'before' &&
                      'border-t-2 border-t-accent',
                    dragOverCard?.id === item.id &&
                      dragOverCard.position === 'after' &&
                      'border-b-2 border-b-accent',
                  )}
                >
                  <span className="font-mono text-xs text-text-muted">
                    {item.identifier}
                  </span>
                  <span className="line-clamp-2 text-text">{item.title}</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {state && (
                      <span className="flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-xs text-text-secondary">
                        <StateIcon state={state} size={12} />
                        {state.name}
                      </span>
                    )}
                    <span className="flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-xs text-text-secondary">
                      <PriorityIcon priority={item.priority} size={12} />
                    </span>
                    {labels.map((l) => (
                      <Badge key={l.id} tone="neutral">
                        <Dot color={l.color} />
                        {l.name}
                      </Badge>
                    ))}
                    {agentAssignment && (
                      <Badge
                        tone={
                          agentAssignment.assignment
                            ? AGENT_STATUS_CONFIG[
                                agentAssignment.assignment.status
                              ].tone
                            : 'neutral'
                        }
                      >
                        <Terminal size={11} />
                        {agentAssignment.agent.name}
                      </Badge>
                    )}
                  </div>
                  {(subTotal > 0 || item.linkCount > 0) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {subTotal > 0 && (
                        <span
                          title={`${subDone} of ${subTotal} sub-items done`}
                        >
                          <Badge tone="neutral">
                            <ListChecks size={11} />
                            {subDone}/{subTotal}
                          </Badge>
                        </span>
                      )}
                      {item.linkCount > 0 && (
                        <span
                          title={`${item.linkCount} link${item.linkCount === 1 ? '' : 's'}`}
                        >
                          <Badge tone="neutral">
                            <Link2 size={11} />
                            {item.linkCount}
                          </Badge>
                        </span>
                      )}
                    </div>
                  )}
                  <div className="flex items-center justify-end">
                    <AvatarStack people={assigneesFor(item)} size={20} />
                  </div>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setCreateForGroup(group.key)}
              className="flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-2 text-left text-sm text-text-secondary hover:bg-surface hover:text-accent"
            >
              <IconPlus size={14} />
              New ticket
            </button>
          </div>
        </div>
      ))}

      <CreateTicketModal
        open={createForGroup !== null}
        onClose={() => setCreateForGroup(null)}
        projectId={projectId}
        defaultStateId={
          view.groupBy === 'state' &&
          createForGroup &&
          createForGroup !== 'none'
            ? createForGroup
            : undefined
        }
        onCreated={() => view.reload()}
      />
    </div>
  );
}
