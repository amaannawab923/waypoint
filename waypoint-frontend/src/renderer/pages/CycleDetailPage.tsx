import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { ArrowLeft, CalendarRange, Check, ChevronDown, MoreHorizontal, Pencil, RefreshCw, Trash2, UserPlus, Users } from 'lucide-react';
import { useProject } from '@/layouts/ProjectLayout';
import { useAsync } from '@/lib/useAsync';
import { useRecordRecent } from '@/lib/recents';
import { deleteCycle, listCycles, listMembers, listStates, listTickets, updateCycle } from '@/data/api';
import { Avatar, AvatarStack } from '@/components/ui/Avatar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { CycleStatsPanel } from '@/pages/cycles/CycleStatsPanel';
import { CycleTicketList } from '@/pages/cycles/CycleTicketList';
import { findOverlappingCycle, formatDateRange, getCycleStatus, type CycleStatus } from '@/pages/cycles/cycle-utils';
import { Skeleton } from '@/components/ui/Skeleton';

const STATUS_LABEL: Record<CycleStatus, string> = {
  active: 'Active',
  upcoming: 'Upcoming',
  completed: 'Completed',
};

const STATUS_TONE: Record<CycleStatus, BadgeTone> = {
  active: 'accent',
  upcoming: 'info',
  completed: 'success',
};

const TRIGGER_CLASS =
  'flex h-9 w-full items-center gap-1.5 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2.5 text-sm text-text outline-none hover:bg-surface-2';
const PANEL_CLASS =
  'thin-scroll max-h-64 w-full min-w-[200px] overflow-y-auto rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg';
const OPTION_CLASS =
  'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2';

/** Self-contained popover, mirrors the pattern in CycleListCard/ModuleDetailPage — there's no
 * shared Dropdown/Menu primitive in src/components/ui/ yet. */
function Dropdown({
  trigger,
  children,
  align = 'left',
}: {
  trigger: (toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
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
      {open && (
        <div className={clsx('absolute z-30 mt-1', align === 'right' ? 'right-0' : 'left-0 right-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2',
        danger && 'text-danger hover:bg-danger-bg',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function toDateInputValue(value: string): string {
  return value ? value.slice(0, 10) : '';
}

export default function CycleDetailPage() {
  const { project } = useProject();
  const { cycleId = '' } = useParams();
  const navigate = useNavigate();

  const { data: cycles, loading: cyclesLoading, reload: reloadCycles } = useAsync(() => listCycles(project.id), [project.id]);
  const { data: items, loading: itemsLoading, reload: reloadItems } = useAsync(() => listTickets(project.id), [project.id]);
  const { data: states, loading: statesLoading } = useAsync(() => listStates(project.id), [project.id]);
  const { data: allMembers } = useAsync(() => listMembers(), []);

  const loading = cyclesLoading || itemsLoading || statesLoading;
  const cycle = cycles?.find((c) => c.id === cycleId);
  const cycleItems = useMemo(() => (items ?? []).filter((i) => i.cycleId === cycleId), [items, cycleId]);

  const projectMembers = useMemo(
    () => (allMembers ?? []).filter((m) => project.memberIds.includes(m.id)),
    [allMembers, project.memberIds],
  );
  const lead = useMemo(
    () => (allMembers ?? []).find((m) => m.id === cycle?.leadId) ?? null,
    [allMembers, cycle?.leadId],
  );
  const cycleMembers = useMemo(
    () => (allMembers ?? []).filter((m) => (cycle?.memberIds ?? []).includes(m.id)),
    [allMembers, cycle?.memberIds],
  );

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [saving, setSaving] = useState(false);

  useRecordRecent(
    cycle
      ? {
          type: 'cycle',
          id: cycle.id,
          title: cycle.name,
          projectId: cycle.projectId,
          path: `/projects/${cycle.projectId}/cycles/${cycle.id}`,
        }
      : null,
  );

  if (!project.features.cycles) {
    return (
      <EmptyState
        icon={<RefreshCw size={28} />}
        title="Cycles isn't enabled for this project"
        description="Turn Cycles back on in project settings to run work in fixed date ranges again."
        action={
          <Link
            to={`/projects/${project.id}/settings/features`}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-border-strong bg-surface px-3 text-sm font-medium text-text transition-colors hover:bg-surface-2"
          >
            Go to feature settings
          </Link>
        }
      />
    );
  }

  if (loading && (!cycle || !states)) {
    return (
      <Skeleton className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
        <div>
          <Skeleton.Block height="0.75rem" width="5rem" className="mb-3" />
          <div className="flex items-center gap-2">
            <Skeleton.Block height="1.25rem" width="12rem" />
            <Skeleton.Block height="1.25rem" width="4rem" rounded="rounded-full" />
          </div>
          <Skeleton.Block height="0.875rem" width="9rem" className="mt-2" />
        </div>
        <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
          <div className="flex items-center gap-4">
            <Skeleton.Block height="4rem" width="4rem" rounded="rounded-full" />
            <div className="flex flex-1 gap-6">
              <Skeleton.Block height="2.5rem" width="5rem" />
              <Skeleton.Block height="2.5rem" width="5rem" />
              <Skeleton.Block height="2.5rem" width="5rem" />
            </div>
          </div>
        </div>
        <div className="rounded-[var(--radius-lg)] border border-border bg-surface px-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              key={index}
              className={index > 0 ? 'flex items-center gap-3 border-t border-border px-2 py-3' : 'flex items-center gap-3 px-2 py-3'}
            >
              <Skeleton.Block height="1.25rem" width="40px" rounded="rounded-sm" />
              <Skeleton.Block height="0.875rem" width={index % 2 === 0 ? '16rem' : '12rem'} />
              <div className="ml-auto flex items-center gap-2">
                <Skeleton.Block height="1.25rem" width="4rem" rounded="rounded-sm" />
                <Skeleton.Circle size="1.5rem" />
              </div>
            </div>
          ))}
        </div>
      </Skeleton>
    );
  }

  if (!cycle) {
    return (
      <EmptyState
        title="Cycle not found"
        description="It may have been deleted."
        action={
          <Link
            to={`/projects/${project.id}/cycles`}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-border-strong bg-surface px-3 text-sm font-medium text-text transition-colors hover:bg-surface-2"
          >
            Back to cycles
          </Link>
        }
      />
    );
  }

  const status = getCycleStatus(cycle);
  const allCycles = cycles ?? [];

  async function patchCycle(fields: Parameters<typeof updateCycle>[1]) {
    await updateCycle(cycle!.id, fields);
    reloadCycles();
  }

  function toggleMember(memberId: string) {
    const current = cycle!.memberIds ?? [];
    const next = current.includes(memberId) ? current.filter((id) => id !== memberId) : [...current, memberId];
    patchCycle({ memberIds: next });
  }

  function startEdit() {
    setName(cycle!.name);
    setStartDate(toDateInputValue(cycle!.startDate));
    setEndDate(toDateInputValue(cycle!.endDate));
    setEditing(true);
  }

  const dateOrderValid = Boolean(startDate && endDate && startDate <= endDate);
  const overlapping = editing && dateOrderValid ? findOverlappingCycle(allCycles, startDate, endDate, cycle.id) : null;
  const editValid = name.trim().length > 0 && dateOrderValid && !overlapping;

  async function handleSaveEdit() {
    if (!editValid || saving) return;
    setSaving(true);
    try {
      await patchCycle({ name: name.trim(), startDate, endDate });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function handleDelete() {
    if (!window.confirm(`Delete "${cycle!.name}"? This can't be undone.`)) return;
    deleteCycle(cycle!.id).then(() => navigate(`/projects/${project.id}/cycles`));
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div>
        <Link
          to={`/projects/${project.id}/cycles`}
          className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-text-muted transition-colors hover:text-text"
        >
          <ArrowLeft size={13} />
          Cycles
        </Link>

        {editing ? (
          <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-border-strong bg-surface p-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-text-secondary">Cycle name</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
              />
            </div>
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <label className="text-xs font-medium text-text-secondary">Start date</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <label className="text-xs font-medium text-text-secondary">End date</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
                />
              </div>
            </div>
            {startDate > endDate && <p className="text-xs text-danger">End date must be on or after the start date.</p>}
            {overlapping && (
              <p className="text-xs text-danger">
                These dates overlap with “{overlapping.name}” ({formatDateRange(overlapping.startDate, overlapping.endDate)}). Pick a
                different date range.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="inline-flex h-8 items-center justify-center rounded-[var(--radius-sm)] px-3 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!editValid || saving}
                onClick={handleSaveEdit}
                className="inline-flex h-8 items-center justify-center rounded-[var(--radius-sm)] bg-accent px-3 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="font-display text-lg font-medium text-text">{cycle.name}</h1>
                <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
              </div>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-text-muted">
                <CalendarRange size={13} />
                {formatDateRange(cycle.startDate, cycle.endDate)}
              </p>
              {cycle.description && <p className="mt-2 max-w-2xl text-sm text-text-secondary">{cycle.description}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Dropdown
                align="right"
                trigger={(toggle) => (
                  <IconButton label="Cycle actions" onClick={toggle}>
                    <MoreHorizontal size={16} />
                  </IconButton>
                )}
              >
                {(close) => (
                  <div className="w-40 rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg">
                    <MenuItem
                      icon={<Pencil size={14} />}
                      label="Edit"
                      onClick={() => {
                        close();
                        startEdit();
                      }}
                    />
                    <div className="my-1 h-px bg-border" />
                    <MenuItem
                      icon={<Trash2 size={14} />}
                      label="Delete"
                      danger
                      onClick={() => {
                        close();
                        handleDelete();
                      }}
                    />
                  </div>
                )}
              </Dropdown>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
        <CycleStatsPanel cycle={cycle} items={cycleItems} states={states ?? []} chartHeight={240} />
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_260px]">
        <div>
          <h2 className="mb-3 text-xs font-medium tracking-wide text-text-muted uppercase">Tickets</h2>
          <CycleTicketList
            projectId={project.id}
            cycleId={cycle.id}
            items={cycleItems}
            allItems={items ?? []}
            states={states ?? []}
            members={allMembers ?? []}
            onItemAdded={reloadItems}
          />
        </div>

        <div className="flex flex-col gap-4">
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
                      patchCycle({ leadId: undefined });
                      close();
                    }}
                    className={OPTION_CLASS}
                  >
                    <span className="text-text-muted">No lead</span>
                    {!cycle.leadId && <Check size={14} className="ml-auto shrink-0 text-accent" />}
                  </button>
                  {projectMembers.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        patchCycle({ leadId: m.id });
                        close();
                      }}
                      className={OPTION_CLASS}
                    >
                      <Avatar name={m.displayName} color={m.avatarColor} size={20} />
                      <span className="truncate">{m.displayName}</span>
                      {m.id === cycle.leadId && <Check size={14} className="ml-auto shrink-0 text-accent" />}
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
                  {cycleMembers.length > 0 ? (
                    <AvatarStack people={cycleMembers.map((m) => ({ name: m.displayName, color: m.avatarColor }))} size={20} />
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
                    const checked = (cycle.memberIds ?? []).includes(m.id);
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
        </div>
      </div>
    </div>
  );
}
