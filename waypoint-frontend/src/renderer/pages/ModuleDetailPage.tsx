import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Boxes, Check, ChevronDown, ChevronLeft, Plus, Search, UserPlus, Users } from 'lucide-react';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { useRecordRecent } from '@/lib/recents';
import { listMembers, listModules, listStates, listWorkItems, updateModule, updateWorkItem } from '@/data/api';
import { Avatar, AvatarStack } from '@/components/ui/Avatar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { PriorityIcon } from '@/components/domain/PriorityIcon';
import { StateIcon, STATE_GROUP_ORDER } from '@/components/domain/StateIcon';
import { Skeleton } from '@/components/ui/Skeleton';
import type { WorkItem, WorkModule } from '@/types/entities';

const TRIGGER_CLASS =
  'flex h-9 w-full items-center gap-1.5 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2.5 text-sm text-text outline-none hover:bg-surface-2';
const PANEL_CLASS =
  'thin-scroll max-h-64 w-full min-w-[200px] overflow-y-auto rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg';
const OPTION_CLASS =
  'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2';

function Dropdown({
  trigger,
  children,
}: {
  trigger: (toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      {trigger(() => setOpen((o) => !o))}
      {open && <div className="absolute left-0 right-0 z-30 mt-1">{children(() => setOpen(false))}</div>}
    </div>
  );
}

const STATUS_OPTIONS: WorkModule['status'][] = [
  'backlog',
  'planned',
  'in-progress',
  'paused',
  'completed',
  'cancelled',
];

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

function toDateInput(value: string | null): string {
  return value ? value.slice(0, 10) : '';
}

/**
 * Searchable picker for assigning an existing, not-yet-in-this-module project work item to
 * the current module. Mirrors the pattern used in CycleWorkItemList's own add-work-item modal.
 */
function AddWorkItemModal({
  open,
  onClose,
  candidates,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  candidates: WorkItem[];
  onAdd: (item: WorkItem) => void;
}) {
  const [query, setQuery] = useState('');
  const [addingId, setAddingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (i) => i.title.toLowerCase().includes(q) || i.identifier.toLowerCase().includes(q),
    );
  }, [candidates, query]);

  async function handlePick(item: WorkItem) {
    if (addingId) return;
    setAddingId(item.id);
    try {
      await onAdd(item);
    } finally {
      setAddingId(null);
    }
  }

  function handleClose() {
    setQuery('');
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title="Add work item to module">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search work items…"
            className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg pl-8 pr-3 text-sm outline-none focus:border-accent"
          />
        </div>
        <div className="thin-scroll max-h-72 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-text-muted">
              {candidates.length === 0 ? 'No unassigned work items in this project.' : 'No matches.'}
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={addingId === item.id}
                  onClick={() => handlePick(item)}
                  className="flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-2 text-left text-sm text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
                >
                  <PriorityIcon priority={item.priority} size={13} />
                  <span className="shrink-0 font-mono text-xs text-text-muted">{item.identifier}</span>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default function ModuleDetailPage() {
  const { project } = useProject();
  const { moduleId = '' } = useParams();
  const navigate = useNavigate();

  const { data: modules, loading, reload } = useAsync(() => listModules(project.id), [project.id]);
  const { data: workItems, reload: reloadWorkItems } = useAsync(() => listWorkItems(project.id), [project.id]);
  const { data: states } = useAsync(() => listStates(project.id), [project.id]);
  const { data: allMembers } = useAsync(() => listMembers(), []);

  const [addItemOpen, setAddItemOpen] = useState(false);

  const module = modules?.find((m) => m.id === moduleId);

  const projectMembers = useMemo(
    () => (allMembers ?? []).filter((m) => project.memberIds.includes(m.id)),
    [allMembers, project.memberIds],
  );
  const lead = useMemo(
    () => (allMembers ?? []).find((m) => m.id === module?.leadId) ?? null,
    [allMembers, module?.leadId],
  );
  const moduleMembers = useMemo(
    () => (allMembers ?? []).filter((m) => (module?.memberIds ?? []).includes(m.id)),
    [allMembers, module?.memberIds],
  );

  useRecordRecent(
    module
      ? {
          type: 'module',
          id: module.id,
          title: module.name,
          projectId: module.projectId,
          path: `/projects/${module.projectId}/modules/${module.id}`,
        }
      : null,
  );

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (module) {
      setName(module.name);
      setDescription(module.description);
    }
  }, [module]);

  const items = useMemo(
    () => (workItems ?? []).filter((i) => i.moduleId === moduleId),
    [workItems, moduleId],
  );

  const addItemCandidates = useMemo(
    () => (workItems ?? []).filter((i) => i.moduleId !== moduleId),
    [workItems, moduleId],
  );

  async function handleAddItem(item: WorkItem) {
    await updateWorkItem(item.id, { moduleId });
    setAddItemOpen(false);
    reloadWorkItems();
  }

  const completedStateIds = useMemo(
    () => new Set((states ?? []).filter((s) => s.group === 'completed').map((s) => s.id)),
    [states],
  );

  const progress = items.length === 0 ? null : Math.round(
    (items.filter((i) => completedStateIds.has(i.stateId)).length / items.length) * 100,
  );

  const grouped = useMemo(() => {
    if (!states) return [];
    const orderedStates = [...states].sort(
      (a, b) => STATE_GROUP_ORDER.indexOf(a.group) - STATE_GROUP_ORDER.indexOf(b.group) || a.sortOrder - b.sortOrder,
    );
    return orderedStates
      .map((s) => ({ state: s, items: items.filter((i) => i.stateId === s.id) }))
      .filter((g) => g.items.length > 0);
  }, [states, items]);

  async function patch(fields: Partial<WorkModule>) {
    if (!module) return;
    await updateModule(module.id, fields);
    reload();
  }

  function toggleMember(memberId: string) {
    if (!module) return;
    const next = module.memberIds.includes(memberId)
      ? module.memberIds.filter((id) => id !== memberId)
      : [...module.memberIds, memberId];
    patch({ memberIds: next });
  }

  if (!project.features.modules) {
    return (
      <EmptyState
        icon={<Boxes size={28} />}
        title="Modules is disabled for this project"
        description="Turn Modules back on in project settings to see it again."
        action={
          <Button variant="primary" onClick={() => navigate(`/projects/${project.id}/settings/features`)}>
            Go to features
          </Button>
        }
      />
    );
  }

  if (loading && !modules) {
    return (
      <Skeleton className="flex h-full flex-col overflow-y-auto thin-scroll">
        <div className="border-b border-border px-6 py-4">
          <Skeleton.Block height="0.75rem" width="5rem" className="mb-3" />
          <Skeleton.Block height="1.5rem" width="16rem" />
        </div>
        <div className="grid grid-cols-1 gap-6 px-6 py-5 md:grid-cols-[1fr_260px]">
          <div className="flex flex-col gap-5">
            <Skeleton.Block height="4.5rem" width="100%" />
            <div>
              <div className="mb-2 flex items-center justify-between">
                <Skeleton.Block height="0.875rem" width="8rem" />
                <Skeleton.Block height="2rem" width="8rem" />
              </div>
              <div className="overflow-hidden rounded-[var(--radius)] border border-border">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div
                    key={index}
                    className={index > 0 ? 'flex items-center gap-2.5 border-t border-border bg-surface px-3 py-2' : 'flex items-center gap-2.5 bg-surface px-3 py-2'}
                  >
                    <Skeleton.Block height="0.875rem" width="0.875rem" />
                    <Skeleton.Block height="0.75rem" width="3rem" />
                    <Skeleton.Block height="0.875rem" width={index % 2 === 0 ? '18rem' : '12rem'} />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <Skeleton.Block height="0.75rem" width="3rem" />
            <Skeleton.Block height="2.25rem" width="100%" />
            <Skeleton.Block height="0.75rem" width="3rem" className="mt-2" />
            <Skeleton.Block height="2.25rem" width="100%" />
            <Skeleton.Block height="0.75rem" width="4rem" className="mt-2" />
            <Skeleton.Block height="2.25rem" width="100%" />
          </div>
        </div>
      </Skeleton>
    );
  }

  if (!module) {
    return (
      <EmptyState
        title="Module not found"
        description="It may have been deleted."
        action={
          <Button variant="secondary" onClick={() => navigate(`/projects/${project.id}/modules`)}>
            <ChevronLeft size={15} />
            Back to modules
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto thin-scroll">
      <div className="border-b border-border px-6 py-4">
        <button
          type="button"
          onClick={() => navigate(`/projects/${project.id}/modules`)}
          className="mb-3 flex items-center gap-1 text-xs font-medium text-text-secondary transition-colors hover:text-text"
        >
          <ChevronLeft size={14} />
          Modules
        </button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== module.name && patch({ name: name.trim() })}
          className="w-full border-none bg-transparent p-0 font-display text-xl font-medium text-text outline-none"
          placeholder="Module name"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 px-6 py-5 md:grid-cols-[1fr_260px]">
        <div className="flex flex-col gap-5">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-muted">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => description !== module.description && patch({ description })}
              rows={3}
              placeholder="What is this module about?"
              className="w-full resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-medium text-text-muted">Work items ({items.length})</label>
              <Button variant="secondary" size="sm" onClick={() => setAddItemOpen(true)}>
                <Plus size={14} />
                Add work item
              </Button>
            </div>
            {items.length === 0 ? (
              <EmptyState
                title="No work items in this module yet"
                action={
                  <Button variant="secondary" size="sm" onClick={() => setAddItemOpen(true)}>
                    <Plus size={14} />
                    Add work item
                  </Button>
                }
              />
            ) : (
              <div className="flex flex-col gap-4">
                {grouped.map(({ state, items: groupItems }) => (
                  <div key={state.id}>
                    <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                      <StateIcon state={state} size={13} />
                      {state.name}
                      <span className="text-text-muted">{groupItems.length}</span>
                    </div>
                    <ul className="divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border">
                      {groupItems.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => navigate(`/projects/${project.id}/work-items/${item.identifier}`)}
                            className="flex w-full items-center gap-2.5 bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-2"
                          >
                            <PriorityIcon priority={item.priority} size={13} />
                            <span className="shrink-0 font-mono text-xs text-text-muted">{item.identifier}</span>
                            <span className="min-w-0 flex-1 truncate text-sm text-text">{item.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-muted">Status</label>
            <select
              value={module.status}
              onChange={(e) => patch({ status: e.target.value as WorkModule['status'] })}
              className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2.5 text-sm outline-none focus:border-accent"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {STATUS_LABEL[opt]}
                </option>
              ))}
            </select>
            <div className="mt-2">
              <Badge tone={STATUS_TONE[module.status]}>{STATUS_LABEL[module.status]}</Badge>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-muted">Lead</label>
            <Dropdown
              trigger={(toggle) => (
                <button type="button" onClick={toggle} className={TRIGGER_CLASS}>
                  {lead ? (
                    <>
                      <Avatar name={lead.displayName} color={lead.avatarColor} size={20} />
                      <span className="truncate">{lead.displayName}</span>
                    </>
                  ) : (
                    <span className="flex items-center gap-1.5 text-text-muted">
                      <UserPlus size={14} /> No lead
                    </span>
                  )}
                  <ChevronDown size={13} className="ml-auto shrink-0 text-text-muted" />
                </button>
              )}
            >
              {(close) => (
                <div className={PANEL_CLASS}>
                  <button
                    type="button"
                    onClick={() => {
                      patch({ leadId: null });
                      close();
                    }}
                    className={OPTION_CLASS}
                  >
                    <span className="text-text-muted">No lead</span>
                    {!module.leadId && <Check size={14} className="ml-auto shrink-0 text-accent" />}
                  </button>
                  {projectMembers.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        patch({ leadId: m.id });
                        close();
                      }}
                      className={OPTION_CLASS}
                    >
                      <Avatar name={m.displayName} color={m.avatarColor} size={20} />
                      <span className="truncate">{m.displayName}</span>
                      {m.id === module.leadId && <Check size={14} className="ml-auto shrink-0 text-accent" />}
                    </button>
                  ))}
                </div>
              )}
            </Dropdown>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-muted">Members</label>
            <Dropdown
              trigger={(toggle) => (
                <button type="button" onClick={toggle} className={TRIGGER_CLASS}>
                  {moduleMembers.length > 0 ? (
                    <AvatarStack people={moduleMembers.map((m) => ({ name: m.displayName, color: m.avatarColor }))} size={20} />
                  ) : (
                    <span className="flex items-center gap-1.5 text-text-muted">
                      <Users size={14} /> No members
                    </span>
                  )}
                  <ChevronDown size={13} className="ml-auto shrink-0 text-text-muted" />
                </button>
              )}
            >
              {() => (
                <div className={PANEL_CLASS}>
                  {projectMembers.length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-text-muted">No project members.</p>
                  )}
                  {projectMembers.map((m) => {
                    const checked = module.memberIds.includes(m.id);
                    return (
                      <button key={m.id} type="button" onClick={() => toggleMember(m.id)} className={OPTION_CLASS}>
                        <Avatar name={m.displayName} color={m.avatarColor} size={20} />
                        <span className="truncate">{m.displayName}</span>
                        {checked && <Check size={14} className="ml-auto shrink-0 text-accent" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </Dropdown>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-muted">Progress</label>
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-accent" style={{ width: `${progress ?? 0}%` }} />
              </div>
              <span className="w-8 shrink-0 text-right text-xs text-text-muted">
                {progress === null ? '—' : `${progress}%`}
              </span>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-muted">Start date</label>
            <input
              type="date"
              defaultValue={toDateInput(module.startDate)}
              onBlur={(e) => patch({ startDate: e.target.value ? new Date(e.target.value).toISOString() : null })}
              className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2.5 text-sm outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-text-muted">Target date</label>
            <input
              type="date"
              defaultValue={toDateInput(module.targetDate)}
              onBlur={(e) => patch({ targetDate: e.target.value ? new Date(e.target.value).toISOString() : null })}
              className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2.5 text-sm outline-none focus:border-accent"
            />
          </div>
        </div>
      </div>

      <AddWorkItemModal
        open={addItemOpen}
        onClose={() => setAddItemOpen(false)}
        candidates={addItemCandidates}
        onAdd={handleAddItem}
      />
    </div>
  );
}
