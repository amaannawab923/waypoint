import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, CheckCircle2, Loader, Plus, Users } from 'lucide-react';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { createModule, listMembers, listModules, listStates, listWorkItems } from '@/mock/api';
import { Avatar } from '@/components/ui/Avatar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import type { WorkModule } from '@/types/entities';

const STATUS_LABEL: Record<WorkModule['status'], string> = {
  backlog: 'Backlog',
  planned: 'Planned',
  'in-progress': 'In Progress',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATUS_TONE: Record<WorkModule['status'], BadgeTone> = {
  backlog: 'neutral',
  paused: 'neutral',
  planned: 'info',
  'in-progress': 'warning',
  completed: 'success',
  cancelled: 'danger',
};

function formatDate(value: string | null): string | null {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dateRangeLabel(module: WorkModule): string {
  const start = formatDate(module.startDate);
  const target = formatDate(module.targetDate);
  if (!start && !target) return 'No dates set';
  if (start && target) return `${start} – ${target}`;
  return start ? `From ${start}` : `Due ${target}`;
}

export default function ModulesPage() {
  const { project } = useProject();
  const navigate = useNavigate();
  const { data: modules, loading, reload } = useAsync(() => listModules(project.id), [project.id]);
  const { data: workItems } = useAsync(() => listWorkItems(project.id), [project.id]);
  const { data: states } = useAsync(() => listStates(project.id), [project.id]);
  const { data: allMembers } = useAsync(() => listMembers(), []);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const membersById = useMemo(() => new Map((allMembers ?? []).map((m) => [m.id, m])), [allMembers]);

  const completedStateIds = useMemo(
    () => new Set((states ?? []).filter((s) => s.group === 'completed').map((s) => s.id)),
    [states],
  );

  const progressFor = useMemo(() => {
    return (moduleId: string) => {
      const items = (workItems ?? []).filter((i) => i.moduleId === moduleId);
      if (items.length === 0) return null;
      const done = items.filter((i) => completedStateIds.has(i.stateId)).length;
      return Math.round((done / items.length) * 100);
    };
  }, [workItems, completedStateIds]);

  const stats = useMemo(() => {
    const list = modules ?? [];
    return {
      total: list.length,
      completed: list.filter((m) => m.status === 'completed').length,
      inProgress: list.filter((m) => m.status === 'in-progress').length,
    };
  }, [modules]);

  async function handleCreate() {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await createModule(project.id, { name: name.trim() });
      setName('');
      setCreating(false);
      reload();
    } finally {
      setSubmitting(false);
    }
  }

  if (!project.features.modules) {
    return (
      <EmptyState
        icon={<Boxes size={28} />}
        title="Modules is disabled for this project"
        description="Turn it back on in project settings to plan and track modules."
        action={
          <Button variant="primary" onClick={() => navigate(`/projects/${project.id}/settings/features`)}>
            Go to features
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="font-display text-lg font-medium text-text">Modules</h1>
          <p className="text-sm text-text-secondary">Group work into shippable pieces for {project.name}</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus size={15} />
          Add Module
        </Button>
      </div>

      {!!modules?.length && (
        <div className="grid grid-cols-3 gap-3 border-b border-border px-6 py-4">
          <div className="rounded-[var(--radius)] border border-border bg-surface p-4">
            <Boxes size={16} className="mb-3 text-text-muted" strokeWidth={2} />
            <p className="font-display text-2xl font-medium text-text">{stats.total}</p>
            <p className="text-xs text-text-secondary">Total modules</p>
          </div>
          <div className="rounded-[var(--radius)] border border-border bg-surface p-4">
            <CheckCircle2 size={16} className="mb-3 text-text-muted" strokeWidth={2} />
            <p className="font-display text-2xl font-medium text-text">{stats.completed}</p>
            <p className="text-xs text-text-secondary">Completed</p>
          </div>
          <div className="rounded-[var(--radius)] border border-border bg-surface p-4">
            <Loader size={16} className="mb-3 text-text-muted" strokeWidth={2} />
            <p className="font-display text-2xl font-medium text-text">{stats.inProgress}</p>
            <p className="text-xs text-text-secondary">In progress</p>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto thin-scroll">
        {loading && !modules ? (
          <SkeletonListRows rows={6} />
        ) : !modules || modules.length === 0 ? (
          <EmptyState
            icon={<Boxes size={28} />}
            title="No modules yet"
            description="Create a module to group related work items toward a shared outcome."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={15} />
                Add Module
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {modules.map((module) => {
              const progress = progressFor(module.id);
              const lead = module.leadId ? membersById.get(module.leadId) : undefined;
              return (
                <li key={module.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/projects/${project.id}/modules/${module.id}`)}
                    className="flex w-full items-center gap-4 px-6 py-3.5 text-left transition-colors hover:bg-surface-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{module.name}</span>
                    <Badge tone={STATUS_TONE[module.status]}>{STATUS_LABEL[module.status]}</Badge>
                    <span className="w-36 shrink-0 text-xs text-text-muted">{dateRangeLabel(module)}</span>
                    {lead ? (
                      <Avatar name={lead.displayName} color={lead.avatarColor} size={20} className="shrink-0" />
                    ) : (
                      <span className="size-5 shrink-0" />
                    )}
                    <span className="flex w-14 shrink-0 items-center gap-1 text-xs text-text-muted">
                      <Users size={12} />
                      {module.memberIds.length}
                    </span>
                    <div className="flex w-32 shrink-0 items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${progress ?? 0}%` }}
                        />
                      </div>
                      <span className="w-8 shrink-0 text-right text-xs text-text-muted">
                        {progress === null ? '—' : `${progress}%`}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Modal
        open={creating}
        onClose={() => {
          setCreating(false);
          setName('');
        }}
        title="New module"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!name.trim() || submitting} onClick={handleCreate}>
              {submitting ? 'Creating…' : 'Create module'}
            </Button>
          </>
        }
      >
        <input
          autoFocus
          placeholder="Module name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate();
          }}
          className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
        />
      </Modal>
    </div>
  );
}
