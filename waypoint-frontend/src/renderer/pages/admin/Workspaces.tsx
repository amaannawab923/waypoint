import { Building2 } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { getCurrentUser, getWorkspace, listMembers, listProjects, updateWorkspace } from '@/mock/api';
import { useAsync } from '@/lib/useAsync';
import { PageHeader, SectionCard, SettingRow, StatTile, Toggle } from '@/pages/admin/components';

async function loadWorkspaceOverview() {
  const [workspace, owner, projects, members] = await Promise.all([
    getWorkspace(),
    getCurrentUser(),
    listProjects(),
    listMembers(),
  ]);
  return { workspace, owner, projects, members };
}

export default function Workspaces() {
  const { data, loading, reload } = useAsync(loadWorkspaceOverview, []);

  async function handleToggleRestrictCreation(value: boolean) {
    await updateWorkspace({ restrictWorkspaceCreation: value });
    reload();
  }

  return (
    <div>
      <PageHeader title="Workspaces" description="This instance hosts a single workspace." />

      <div className="flex flex-col gap-6">
        {loading || !data ? (
          <div className="rounded-[var(--radius)] border border-border bg-surface p-5">
            <Skeleton>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Skeleton.Block height="2.5rem" width="2.5rem" rounded="rounded-[var(--radius-sm)]" />
                  <div>
                    <Skeleton.Block height="0.875rem" width="8rem" className="mb-1.5" />
                    <Skeleton.Block height="0.75rem" width="5rem" />
                  </div>
                </div>
                <Skeleton.Block height="1.25rem" width="4rem" rounded="rounded-full" />
              </div>
              <div className="mt-5 flex items-center gap-2.5 border-t border-border pt-4">
                <Skeleton.Circle size="22px" />
                <div>
                  <Skeleton.Block height="0.75rem" width="3rem" className="mb-1" />
                  <Skeleton.Block height="0.875rem" width="10rem" />
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3">
                <Skeleton.Block height="3.5rem" />
                <Skeleton.Block height="3.5rem" />
                <Skeleton.Block height="3.5rem" />
              </div>
            </Skeleton>
          </div>
        ) : (
          <div className="rounded-[var(--radius)] border border-border bg-surface p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-accent-soft-bg text-accent-soft-text">
                  <Building2 size={18} />
                </span>
                <div>
                  <p className="font-display text-sm font-medium text-text">{data.workspace.name}</p>
                  <p className="text-xs text-text-secondary">/{data.workspace.slug}</p>
                </div>
              </div>
              <Badge tone="accent" className="capitalize">
                {data.workspace.plan}
              </Badge>
            </div>

            <div className="mt-5 flex items-center gap-2.5 border-t border-border pt-4">
              <Avatar name={data.owner.fullName} color={data.owner.avatarColor} size={22} />
              <div className="min-w-0">
                <p className="text-xs text-text-muted">Owner</p>
                <p className="truncate text-sm text-text">{data.owner.email}</p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <StatTile label="Projects" value={data.projects.length} />
              <StatTile label="Members" value={data.members.length} />
              <StatTile label="Timezone" value={data.workspace.timezone} />
            </div>
          </div>
        )}

        <SectionCard title="Creation">
          <SettingRow
            title="Prevent anyone else from creating a workspace"
            description="When on, only instance admins can create new workspaces."
            control={
              <Toggle
                checked={data?.workspace.restrictWorkspaceCreation ?? false}
                onChange={handleToggleRestrictCreation}
                label="Prevent anyone else from creating a workspace"
              />
            }
          />
        </SectionCard>
      </div>
    </div>
  );
}
