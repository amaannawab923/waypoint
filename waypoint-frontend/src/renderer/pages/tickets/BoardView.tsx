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
import { PriorityIcon, PRIORITY_COLOR, PRIORITY_LABEL } from '@/components/domain/PriorityIcon';
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

  // Bug 3 fix: every item's "subtree root" — the topmost ancestor reached by
  // walking the nesting-parent chain (view.nestedChildIds + item.parentId)
  // while it stays inside the SAME rendered kept-together block. Two items
  // that share a root are both part of one contiguous "parent + all its
  // descendants" run produced by useTicketsView's appendDescendants (see
  // that function's own comment) — the gap between any two such items can
  // never actually be represented in the raw reorder data, no matter how
  // deep the nesting or whether the pair is a direct parent/child or two
  // siblings under a shared ancestor. The previous version of this check
  // (H2, 54e9e6b) only compared a card against its immediate
  // prevItem/nextItem's parentId, which caught a direct parent/child pair
  // but missed a gap between two siblings (or two deeper descendants) that
  // share a common ancestor without being adjacent to each other in the
  // parent/child sense — see this file's own drag-over handler for how this
  // map is used.
  const subtreeRootId = useMemo(() => {
    const byId = new Map(view.items.map((i) => [i.id, i]));
    const roots = new Map<string, string>();
    function resolve(item: Ticket, visiting: Set<string>): string {
      const cached = roots.get(item.id);
      if (cached) return cached;
      const { parentId } = item;
      if (!view.nestedChildIds.has(item.id) || !parentId || visiting.has(item.id)) {
        roots.set(item.id, item.id);
        return item.id;
      }
      const parent = byId.get(parentId);
      if (!parent) {
        roots.set(item.id, item.id);
        return item.id;
      }
      visiting.add(item.id);
      const root = resolve(parent, visiting);
      roots.set(item.id, root);
      return root;
    }
    view.items.forEach((item) => resolve(item, new Set()));
    return roots;
  }, [view.items, view.nestedChildIds]);

  // Whether the gap between two rendered-adjacent items falls strictly
  // inside a shared subtree — see subtreeRootId's own comment above.
  function isBoundaryGap(a: Ticket | undefined, b: Ticket | undefined): boolean {
    if (!a || !b) return false;
    return (subtreeRootId.get(a.id) ?? a.id) === (subtreeRootId.get(b.id) ?? b.id);
  }

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
            {group.items.map((item, index) => {
              const state = view.stateFor(item);
              const labels = item.labelIds
                .map((id) => labelById.get(id))
                .filter((l): l is NonNullable<typeof l> => Boolean(l));
              const { total: subTotal, done: subDone } = subItemStats(item);
              const agentAssignment = primaryAgentAssignment(item);
              const parent = view.parentById.get(item.id);
              // Finding 2e: only indented when nested directly under its
              // parent in THIS column/group (view.nestedChildIds) — a card
              // whose parent landed in a different group keeps 2c's parent
              // chip as the only pointer instead.
              const isNested = view.nestedChildIds.has(item.id);
              // H2/Bug 3: the two gaps immediately around THIS item that
              // would ask to drop something inside a subtree it's part of —
              // 'after' this item when the next card shares its subtree
              // root, or 'before' this item when the previous card does.
              // Covers a direct parent/child pair AND a gap between two
              // siblings (or deeper descendants) under the same ancestor —
              // see subtreeRootId's own comment above. Both are refused
              // below (see onDragOver's own comment for why).
              const prevItem = group.items[index - 1];
              const nextItem = group.items[index + 1];
              const boundaryAfter = isBoundaryGap(item, nextItem);
              const boundaryBefore = isBoundaryGap(prevItem, item);
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
                    const rect = e.currentTarget.getBoundingClientRect();
                    const position =
                      e.clientY < rect.top + rect.height / 2
                        ? 'before'
                        : 'after';
                    // H2/Bug 1 (documented decision, not a silent no-op): a
                    // drop 'after' this card when the next card shares its
                    // subtree root, or 'before' this card when the previous
                    // one does, is asking to insert something at a gap
                    // strictly inside a kept-together parent+descendants
                    // block. The same-group nesting resort
                    // (useTicketsView.ts's orderedItems) always re-splices a
                    // nested child directly after its parent regardless of
                    // raw list order, so that drop can never actually land
                    // there — reorderItemLocally would still mutate the raw
                    // order and reorderTicket would still persist it
                    // server-side, but the rendered result would snap right
                    // back, a silent no-op that leaves persisted and
                    // rendered order disagreeing (see reorderItemLocally's
                    // own comment in useTicketsView.ts for the full
                    // mechanism). Implementing a real "insert inside a kept-
                    // together subtree" reorder is out of scope for this
                    // pass, so instead: no indicator, AND — this is the part
                    // an earlier version of this comment got wrong —
                    // e.stopPropagation() so the bubbled column-level
                    // onDragOver (which calls e.preventDefault()
                    // unconditionally) never gets a chance to re-enable the
                    // drop the browser would otherwise refuse. onDrop below
                    // re-checks the same predicate independently, as defense
                    // in depth against a drop event reaching it by some
                    // other path.
                    if (
                      (position === 'after' && boundaryAfter) ||
                      (position === 'before' && boundaryBefore)
                    ) {
                      e.stopPropagation();
                      setDragOverCard((c) => (c?.id === item.id ? null : c));
                      return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
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
                    // Bug 1/2 defense in depth: re-derive the drop position
                    // from the event itself (mirroring onDragOver's own
                    // computation) and re-check the same boundary predicate
                    // here, rather than relying solely on dragOverCard state
                    // (which the refusal branch above already nulls out).
                    // Without this, a drop event that reached this handler
                    // by some other path than a preceding onDragOver — or
                    // one where dragOverCard was null for any other reason —
                    // would fall through to handleCardDrop's `dragOverCard
                    // ?.position ?? 'after'` fallback, silently persisting a
                    // guessed 'after' even when the user was aiming for
                    // 'before' (or vice versa) at a boundary that can't be
                    // represented at all.
                    if (!canReorderPersist || !draggingId || draggingId === item.id) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const position =
                      e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                    if (
                      (position === 'after' && boundaryAfter) ||
                      (position === 'before' && boundaryBefore)
                    ) {
                      setDragOverGroup(null);
                      setDragOverCard(null);
                      setDraggingId(null);
                      return;
                    }
                    handleCardDrop(item.id);
                  }}
                  className={clsx(
                    'flex flex-col gap-2 rounded-[var(--radius-sm)] border border-border bg-surface p-3 text-left text-sm shadow-sm hover:border-border-strong',
                    item.priority !== 'none' && 'border-l-2',
                    isNested && 'ml-3',
                    draggingId === item.id && 'opacity-50',
                    dragOverCard?.id === item.id &&
                      dragOverCard.position === 'before' &&
                      'border-t-2 border-t-accent',
                    dragOverCard?.id === item.id &&
                      dragOverCard.position === 'after' &&
                      'border-b-2 border-b-accent',
                  )}
                  style={
                    item.priority !== 'none'
                      ? { borderLeftColor: PRIORITY_COLOR[item.priority] }
                      : undefined
                  }
                >
                  <span className="font-mono text-xs text-text-muted">
                    {isNested && (
                      <>
                        <span aria-hidden="true">↳ </span>
                        {/* M1: mirrors TicketList.tsx's nested-indent
                            branch — the parent-chip case below already has
                            an sr-only "Parent" label alongside its
                            aria-hidden glyph; this branch (parent/child
                            adjacent, connector rendered inline) had only
                            the aria-hidden glyph, no signal at all for a
                            screen-reader user. */}
                        {parent && <span className="sr-only">Subtask of {parent.identifier}</span>}
                      </>
                    )}
                    {item.identifier}
                  </span>
                  <span className="line-clamp-2 text-text">{item.title}</span>
                  {item.description && (
                    <span className="line-clamp-2 text-xs text-text-muted">{item.description}</span>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {state && (
                      <span className="flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-xs text-text-secondary">
                        <StateIcon state={state} size={12} />
                        {state.name}
                      </span>
                    )}
                    <span className="flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-xs text-text-secondary">
                      <PriorityIcon priority={item.priority} size={12} label={PRIORITY_LABEL[item.priority]} />
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
                  {(subTotal > 0 || Boolean(parent && !isNested) || item.linkCount > 0) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {subTotal > 0 && (
                        <span
                          title={`Epic: ${subDone} of ${subTotal} sub-items done`}
                        >
                          <Badge tone="accent">
                            <ListChecks size={11} />
                            Epic · {subDone}/{subTotal}
                          </Badge>
                        </span>
                      )}
                      {/* Finding 2e's indent already points at the parent
                          visually when they share a group — this chip is
                          only needed when they don't (isNested false). */}
                      {parent && !isNested && (
                        <span title={`Parent ${parent.identifier}`}>
                          <Badge tone="neutral">
                            <span aria-hidden="true">↳</span>
                            <span className="sr-only">Parent</span>
                            {parent.identifier}
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
