import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Plus, ListTodo, ListChecks, Link2, Terminal } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import { listAgentAssignments, listAgents, listMembers } from '@/data/api';
import { Badge, Dot } from '@/components/ui/Badge';
import { AvatarStack } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { StateIcon } from '@/components/domain/StateIcon';
import { PriorityIcon } from '@/components/domain/PriorityIcon';
import { AGENT_STATUS_CONFIG } from '@/components/domain/AgentStatusBadge';
import { CreateTicketModal } from '@/components/domain/CreateTicketModal';
import type { TicketsView } from '@/pages/tickets/useTicketsView';
import type { Ticket } from '@/types/entities';
import { SkeletonListRows } from '@/components/ui/Skeleton';

export default function ListView({
  view,
  projectId,
  onOpenItem,
}: {
  view: TicketsView;
  projectId: string;
  /**
   * Opens the peek drawer for a ticket. Optional so this view can still
   * be reused by callers (e.g. ProjectViewsPage) that haven't wired up the
   * peek drawer yet — falls back to a full-page navigation in that case.
   */
  onOpenItem?: (identifier: string) => void;
}) {
  const navigate = useNavigate();
  const { data: members } = useAsync(() => listMembers(), []);
  const { data: agents } = useAsync(() => listAgents(), []);
  const { data: agentAssignments } = useAsync(() => listAgentAssignments(), []);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [createForGroup, setCreateForGroup] = useState<string | null>(null);

  const memberById = useMemo(() => new Map((members ?? []).map((m) => [m.id, m])), [members]);
  const agentById = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);
  const assignmentByKey = useMemo(
    () => new Map((agentAssignments ?? []).map((a) => [`${a.ticketId}:${a.agentId}`, a])),
    [agentAssignments],
  );
  const labelById = useMemo(() => new Map(view.labels.map((l) => [l.id, l])), [view.labels]);

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
    const done = children.filter((c) => view.stateFor(c)?.group === 'completed').length;
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
        if (m) return { name: m.displayName, color: m.avatarColor, shape: 'circle' as const };
        const a = agentById.get(id);
        if (a) return { name: a.name, color: a.avatarColor, shape: 'square' as const };
        return null;
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
  }

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
        description="Create your first ticket to start tracking work in this project."
        action={
          <button
            type="button"
            onClick={() => setCreateForGroup('none')}
            className="cursor-pointer text-sm font-medium text-accent hover:underline"
          >
            + New ticket
          </button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col pb-8">
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
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
              {group.color && <Dot color={group.color} />}
              <span className="font-display text-sm font-medium text-text">{group.label}</span>
              <span className="font-mono text-xs text-text-muted">{group.items.length}</span>
              <button
                type="button"
                onClick={() => setCreateForGroup(group.key)}
                className="ml-auto flex cursor-pointer items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-xs text-text-secondary hover:bg-surface hover:text-accent"
              >
                <Plus size={12} />
                New ticket
              </button>
            </div>

            {!isCollapsed &&
              group.items.map((item) => {
                const state = view.stateFor(item);
                const labels = item.labelIds.map((id) => labelById.get(id)).filter((l): l is NonNullable<typeof l> => Boolean(l));
                const { total: subTotal, done: subDone } = subItemStats(item);
                const agentAssignment = primaryAgentAssignment(item);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() =>
                      onOpenItem
                        ? onOpenItem(item.identifier)
                        : navigate(`/projects/${projectId}/tickets/${item.identifier}`)
                    }
                    className="flex w-full items-center gap-3 border-b border-border px-6 py-2.5 text-left text-sm hover:bg-surface-2"
                  >
                    <span className="w-16 shrink-0 font-mono text-xs text-text-muted">{item.identifier}</span>
                    {state && <StateIcon state={state} />}
                    <span className="flex-1 truncate text-text">{item.title}</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {subTotal > 0 && (
                        <span title={`${subDone} of ${subTotal} sub-items done`}>
                          <Badge tone="neutral">
                            <ListChecks size={11} />
                            {subDone}/{subTotal}
                          </Badge>
                        </span>
                      )}
                      {item.linkCount > 0 && (
                        <span title={`${item.linkCount} link${item.linkCount === 1 ? '' : 's'}`}>
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
                        <Badge tone={agentAssignment.assignment ? AGENT_STATUS_CONFIG[agentAssignment.assignment.status].tone : 'neutral'}>
                          <Terminal size={11} />
                          {agentAssignment.agent.name}
                        </Badge>
                      )}
                    </div>
                    <PriorityIcon priority={item.priority} />
                    <AvatarStack people={assigneesFor(item)} />
                  </button>
                );
              })}

            {!isCollapsed && group.items.length === 0 && (
              <div className="px-6 py-3 text-xs text-text-muted">No tickets</div>
            )}
          </div>
        );
      })}

      <CreateTicketModal
        open={createForGroup !== null}
        onClose={() => setCreateForGroup(null)}
        projectId={projectId}
        defaultStateId={view.groupBy === 'state' && createForGroup && createForGroup !== 'none' ? createForGroup : undefined}
        onCreated={() => view.reload()}
      />
    </div>
  );
}
