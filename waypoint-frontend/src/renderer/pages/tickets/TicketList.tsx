import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListTodo, ListChecks, Link2, Terminal } from 'lucide-react';
import { IconChevron, IconChevronRight, IconPlus } from '@/components/icons';
import { clsx } from 'clsx';
import { useAsync } from '@/lib/useAsync';
import {
  listAgentAssignments,
  listAgents,
  listMembers,
  updateTicket,
} from '@/data/api';
import { Badge, Dot } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { AvatarStack, Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { StateIcon } from '@/components/domain/StateIcon';
import {
  PriorityIcon,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
} from '@/components/domain/PriorityIcon';
import { AGENT_STATUS_CONFIG } from '@/components/domain/AgentStatusBadge';
import { CreateTicketModal } from '@/components/domain/CreateTicketModal';
import { Popover } from '@/pages/tickets/Popover';
import type { TicketsView } from '@/pages/tickets/useTicketsView';
import type { Ticket } from '@/types/entities';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { registerActiveSelectableView } from '@/lib/useActiveSelectableView';

/**
 * The one TicketList component behind all three W5.2 scopes (architecture
 * §P5): a single project's list (TicketsLayout's List tab), the
 * workspace-wide list (AllTicketsPage, YourWork's Assigned/Created tabs),
 * and a sparse project's list — which needs no code path of its own here.
 * "Sparse" (per docs/design/waypoint-revamp-mockup.html:1833, "Third
 * instantiation of the same component — the sparse project") just means
 * this component pointed at a project whose primitiveCounts happen to be
 * low; TicketsLayout is the only caller that knows about primitiveCounts at
 * all (it narrows which groupBy options are worth offering — see
 * TicketsLayout.tsx), and this file's own rendering is identical either way.
 *
 * Owns: grouped row rendering (unchanged from the pre-W5.2 ListView),
 * per-row bulk-select checkboxes + a bulk action bar, `j`/`k`/`x` keyboard
 * row-navigation/selection scoped to this component's mount, and the count
 * line. The count line is deliberately just `view.items.length` — the same
 * number every group's rows are filtered from — so it can never drift from
 * the rendered row count (W5.2's accept criterion): nothing in this file
 * re-filters `view.items` before rendering it.
 */
export default function TicketList({
  view,
  projectId,
  onOpenItem,
  showProjectColumn = false,
}: {
  view: TicketsView;
  /** Present for the project scope (used to build the CreateTicketModal's
   * target and the fallback navigate() link). Undefined at workspace scope —
   * "New ticket" only makes sense once a target project is known, so it's
   * omitted there rather than guessing projects[0] (see the mockup's own
   * "New ticket ... not projects[0]" comment). */
  projectId?: string;
  /**
   * Opens the peek drawer for a ticket. Optional so this view can still
   * be reused by callers (e.g. ProjectViewsPage) that haven't wired up the
   * peek drawer yet — falls back to a full-page navigation in that case.
   */
  onOpenItem?: (identifier: string) => void;
  /** Workspace scope shows which project each row belongs to (mockup's
   * `showProject` config) — project scope never needs this since it's
   * implicit from the page you're already on. */
  showProjectColumn?: boolean;
}) {
  const navigate = useNavigate();
  const { data: members } = useAsync(() => listMembers(), []);
  const { data: agents } = useAsync(() => listAgents(), []);
  const { data: agentAssignments } = useAsync(() => listAgentAssignments(), []);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );
  const [createForGroup, setCreateForGroup] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

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

  // Any filter, group, or search change invalidates the current selection
  // and focus — a checked row that just scrolled out from under a new
  // filter must not silently stay part of a bulk action the user can no
  // longer see (same rule ReviewPage's bulk selection follows).
  useEffect(() => {
    setSelected(new Set());
    setFocusId(null);
  }, [view.filters, view.groupBy]);

  function primaryAgentAssignment(item: Ticket) {
    const agentId = item.assigneeIds.find((id) => agentById.has(id));
    if (!agentId) return null;
    const agent = agentById.get(agentId);
    if (!agent) return null;
    return { agent, assignment: assignmentByKey.get(`${item.id}:${agentId}`) };
  }

  const subItemsByParent = useMemo(() => {
    const map = new Map<string, Ticket[]>();
    for (const wi of view.allItems) {
      if (!wi.parentId) continue;
      const list = map.get(wi.parentId) ?? [];
      list.push(wi);
      map.set(wi.parentId, list);
    }
    return map;
  }, [view.allItems]);

  function subItemStats(item: Ticket) {
    const children = subItemsByParent.get(item.id) ?? [];
    const done = children.filter(
      (c) => view.stateFor(c)?.group === 'completed',
    ).length;
    return { total: children.length, done };
  }

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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

  // Rows in on-screen order, skipping collapsed groups — the basis for
  // `j`/`k` focus movement (mockup's own `flat`/`move()`). A collapsed
  // group's rows aren't in the DOM, so they're excluded from the sequence
  // rather than left focusable-but-invisible.
  const flatVisible = useMemo(
    () =>
      view.groupedItems.flatMap((g) =>
        collapsedGroups.has(g.key) ? [] : g.items,
      ),
    [view.groupedItems, collapsedGroups],
  );

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function moveFocus(delta: number) {
    if (flatVisible.length === 0) return;
    const currentIndex = focusId
      ? flatVisible.findIndex((i) => i.id === focusId)
      : -1;
    const nextIndex = Math.max(
      0,
      Math.min(
        flatVisible.length - 1,
        currentIndex < 0 ? 0 : currentIndex + delta,
      ),
    );
    const next = flatVisible[nextIndex];
    setFocusId(next.id);
    document
      .getElementById(`ticket-row-${next.id}`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  // `j`/`k` move a focus ring down/up the currently visible rows, `x`
  // toggles the focused row's bulk selection (architecture §P5, W5.2's
  // "j/k/x" line). Scoped to this component's mount via an effect that
  // tears its listener down on unmount, the same way ReviewPage's `e`/`r`
  // bulk shortcuts are scoped to that screen — not a document-wide handler
  // some other mounted screen's code could trigger. Guarded on typing
  // targets and modifier keys so it never fires while the user is in a text
  // field (search input included) or using a browser/OS shortcut.
  // g-prefixed navigation and `?` are W5.4, deliberately not built here.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j') {
        e.preventDefault();
        moveFocus(1);
      } else if (e.key === 'k') {
        e.preventDefault();
        moveFocus(-1);
      } else if (e.key === 'x') {
        if (!focusId) return;
        e.preventDefault();
        toggleSelected(focusId);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatVisible, focusId]);

  // W5.4: registers this list as the app-shell keyboard layer's "active
  // selectable view" so ⌘A (useGlobalKeyboardShortcuts.ts) can reach it
  // without this component knowing anything about the global keyboard
  // layer itself — purely additive, doesn't touch the j/k/x effect above.
  // "Select all" means all VISIBLE rows (mirrors the mockup's own "Select
  // all visible" label), i.e. `flatVisible` — the same on-screen sequence
  // j/k already move focus through, respecting collapsed groups.
  const selectAllVisible = useCallback(() => {
    setSelected(new Set(flatVisible.map((item) => item.id)));
  }, [flatVisible]);
  const clearSelection = useCallback(() => {
    setSelected(new Set());
  }, []);
  useEffect(() => {
    return registerActiveSelectableView({
      selectAll: selectAllVisible,
      clear: clearSelection,
    });
  }, [selectAllVisible, clearSelection]);

  const applyBulkPatch = useCallback(
    async (patch: Partial<Ticket>) => {
      const ids = Array.from(selected);
      if (ids.length === 0) return;
      setBulkBusy(true);
      setSelected(new Set());
      try {
        // No bulk ticket-mutation endpoint exists yet (unlike proposals'
        // POST /proposals/bulk-approve) — updateTicket already supports
        // patching state/priority/assignees individually, so this fires one
        // PATCH per selected ticket rather than adding new backend surface
        // for what's a small, bounded selection size.
        await Promise.all(ids.map((id) => updateTicket(id, patch)));
      } finally {
        setBulkBusy(false);
        view.reload();
      }
    },
    [selected, view],
  );

  if (view.loading) {
    return (
      <div className="px-6 py-3">
        <SkeletonListRows rows={8} />
      </div>
    );
  }

  if (!view.loading && view.items.length === 0) {
    return (
      <EmptyState
        icon={<ListTodo size={28} />}
        title="No tickets"
        description={
          projectId
            ? 'Create your first ticket to start tracking work in this project.'
            : 'Tickets matching this filter will show up here.'
        }
        action={
          projectId ? (
            <button
              type="button"
              onClick={() => setCreateForGroup('none')}
              className="cursor-pointer text-sm font-medium text-accent hover:underline"
            >
              + New ticket
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="flex flex-col pb-8">
      <div className="flex items-center gap-2 px-6 py-2 text-xs font-medium text-text-muted">
        {view.items.length} ticket{view.items.length === 1 ? '' : 's'}
      </div>

      {selected.size > 0 && (
        <div className="sticky top-0 z-20 mx-6 mb-2 flex items-center gap-2 rounded-[var(--radius)] border border-accent bg-accent-soft-bg px-3 py-2">
          <span className="text-sm font-medium text-accent-soft-text">
            {selected.size} selected
          </span>

          <Popover
            trigger={({ toggle }) => (
              <Button
                size="xs"
                variant="secondary"
                onClick={toggle}
                disabled={bulkBusy}
              >
                Set state
                <IconChevron size={12} />
              </Button>
            )}
          >
            <div className="flex w-44 flex-col">
              {view.states.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => applyBulkPatch({ stateId: s.id })}
                  className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2"
                >
                  <StateIcon state={s} size={13} />
                  {s.name}
                </button>
              ))}
            </div>
          </Popover>

          <Popover
            trigger={({ toggle }) => (
              <Button
                size="xs"
                variant="secondary"
                onClick={toggle}
                disabled={bulkBusy}
              >
                Set priority
                <IconChevron size={12} />
              </Button>
            )}
          >
            <div className="flex w-40 flex-col">
              {PRIORITY_ORDER.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => applyBulkPatch({ priority: p })}
                  className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2"
                >
                  <PriorityIcon priority={p} size={13} />
                  {PRIORITY_LABEL[p]}
                </button>
              ))}
            </div>
          </Popover>

          <Popover
            trigger={({ toggle }) => (
              <Button
                size="xs"
                variant="secondary"
                onClick={toggle}
                disabled={bulkBusy}
              >
                Assign
                <IconChevron size={12} />
              </Button>
            )}
          >
            <div className="thin-scroll flex max-h-64 w-48 flex-col overflow-y-auto">
              {(members ?? []).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => applyBulkPatch({ assigneeIds: [m.id] })}
                  className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2"
                >
                  <Avatar
                    name={m.displayName}
                    color={m.avatarColor}
                    size={18}
                  />
                  {m.displayName}
                </button>
              ))}
            </div>
          </Popover>

          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto cursor-pointer text-xs text-text-secondary hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      {view.groupedItems.map((group) => {
        const isCollapsed = collapsedGroups.has(group.key);
        return (
          <div key={group.key}>
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface-2 px-6 py-2.5">
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                className="cursor-pointer text-text-muted hover:text-text"
                aria-label={isCollapsed ? 'Expand group' : 'Collapse group'}
              >
                {isCollapsed ? (
                  <IconChevronRight size={14} />
                ) : (
                  <IconChevron size={14} />
                )}
              </button>
              {group.color && <Dot color={group.color} />}
              <span className="font-display text-sm font-medium text-text">
                {group.label}
              </span>
              <span className="font-mono text-xs text-text-muted">
                {group.items.length}
              </span>
              {projectId && (
                <button
                  type="button"
                  onClick={() => setCreateForGroup(group.key)}
                  className="ml-auto flex cursor-pointer items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-text-secondary hover:bg-surface hover:text-accent"
                >
                  <IconPlus size={12} />
                  New ticket
                </button>
              )}
            </div>

            {!isCollapsed &&
              group.items.map((item) => {
                const state = view.stateFor(item);
                const project = showProjectColumn
                  ? view.projectFor(item)
                  : undefined;
                const labels = item.labelIds
                  .map((id) => labelById.get(id))
                  .filter((l): l is NonNullable<typeof l> => Boolean(l));
                const { total: subTotal, done: subDone } = subItemStats(item);
                const agentAssignment = primaryAgentAssignment(item);
                const isFocused = focusId === item.id;
                return (
                  <div
                    key={item.id}
                    id={`ticket-row-${item.id}`}
                    className={clsx(
                      'flex w-full items-center gap-3 border-b border-border px-6 py-2.5 text-left text-sm hover:bg-surface-2',
                      isFocused && 'bg-surface-2 ring-1 ring-inset ring-accent',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="shrink-0 accent-[var(--accent)]"
                      checked={selected.has(item.id)}
                      onChange={() => toggleSelected(item.id)}
                      aria-label={`Select ${item.identifier}`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setFocusId(item.id);
                        onOpenItem
                          ? onOpenItem(item.identifier)
                          : navigate(
                              `/projects/${item.projectId}/tickets/${item.identifier}`,
                            );
                      }}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
                    >
                      <span className="w-16 shrink-0 font-mono text-xs text-text-muted">
                        {item.identifier}
                      </span>
                      {state && <StateIcon state={state} />}
                      <span className="flex-1 truncate text-text">
                        {item.title}
                      </span>
                      {project && (
                        <span className="shrink-0 truncate text-xs text-text-muted">
                          {project.icon} {project.name}
                        </span>
                      )}
                      <div className="flex shrink-0 items-center gap-1.5">
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
                      <PriorityIcon priority={item.priority} />
                      <AvatarStack people={assigneesFor(item)} />
                    </button>
                  </div>
                );
              })}

            {!isCollapsed && group.items.length === 0 && (
              <div className="px-6 py-3 text-xs text-text-muted">
                No tickets
              </div>
            )}
          </div>
        );
      })}

      {projectId && (
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
      )}
    </div>
  );
}
