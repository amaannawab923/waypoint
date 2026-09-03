import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListChecks } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import { listAllTickets, listProjects, listMembers, listStates } from '@/data/api';
import type { Project, Ticket, TicketState, Member } from '@/types/entities';
import { EmptyState } from '@/components/ui/EmptyState';
import { AvatarStack } from '@/components/ui/Avatar';
import { PriorityIcon, PRIORITY_LABEL } from '@/components/domain/PriorityIcon';
import { StateIcon } from '@/components/domain/StateIcon';
import { Skeleton, SkeletonTableRows } from '@/components/ui/Skeleton';

interface Row {
  item: Ticket;
  project: Project | undefined;
  state: TicketState | undefined;
}

async function loadAll() {
  const [items, projects, members] = await Promise.all([listAllTickets(), listProjects(), listMembers()]);
  const statesByProject = await Promise.all(projects.map((p) => listStates(p.id)));
  const stateById = new Map<string, TicketState>();
  statesByProject.flat().forEach((s) => stateById.set(s.id, s));
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const rows: Row[] = items.map((item) => ({
    item,
    project: projectById.get(item.projectId),
    state: stateById.get(item.stateId),
  }));

  rows.sort((a, b) => a.item.identifier.localeCompare(b.item.identifier, undefined, { numeric: true }));

  return { rows, members };
}

export default function WorkspaceViewsPage() {
  const { data, loading } = useAsync(() => loadAll(), []);
  const navigate = useNavigate();

  const memberById = useMemo(() => new Map((data?.members ?? []).map((m) => [m.id, m])), [data]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-6">
        <h1 className="font-display text-xl font-medium text-text">All tickets</h1>
        <p className="text-sm text-text-secondary">
          {data ? (
            `${data.rows.length} ticket${data.rows.length === 1 ? '' : 's'} across every project`
          ) : (
            <Skeleton className="inline-flex">
              <Skeleton.Block height="1rem" width="12rem" />
            </Skeleton>
          )}
        </p>
      </div>

      {loading && !data && (
        <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface">
          <SkeletonTableRows rows={6} columns={6} />
        </div>
      )}

      {data && data.rows.length === 0 && (
        <EmptyState
          icon={<ListChecks size={32} strokeWidth={1.5} />}
          title="No tickets yet"
          description="Tickets you create across projects will show up here."
        />
      )}

      {data && data.rows.length > 0 && (
        <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="px-4 py-2 font-medium">ID</th>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">Priority</th>
                <th className="px-4 py-2 font-medium">Assignees</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(({ item, project, state }) => (
                <tr
                  key={item.id}
                  onClick={() => project && navigate(`/projects/${project.id}/tickets/${item.identifier}`)}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-2"
                >
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">{item.identifier}</td>
                  <td className="max-w-xs truncate px-4 py-3 text-text">{item.title}</td>
                  <td className="px-4 py-3 text-text-secondary">
                    <span className="mr-1">{project?.icon}</span>
                    {project?.name ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    {state ? (
                      <span className="inline-flex items-center gap-1.5 text-text-secondary">
                        <StateIcon state={state} size={13} />
                        {state.name}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 text-text-secondary">
                      <PriorityIcon priority={item.priority} size={13} />
                      {PRIORITY_LABEL[item.priority]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {item.assigneeIds.length > 0 ? (
                      <AvatarStack
                        people={item.assigneeIds.map((id) => resolveMember(memberById, id))}
                        size={20}
                        max={3}
                      />
                    ) : (
                      <span className="text-text-muted">Unassigned</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function resolveMember(memberById: Map<string, Member>, id: string): { name: string; color?: string } {
  const m = memberById.get(id);
  return { name: m?.fullName ?? '?', color: m?.avatarColor };
}
