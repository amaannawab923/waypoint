import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FolderPlus,
  UserPlus,
  Settings2,
  Sparkles,
  X,
  Clock,
  LayoutList,
  FileText,
  RefreshCw,
  Boxes,
  Check,
  ChevronDown,
  ClipboardCheck,
} from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import {
  getCurrentUser,
  listProjects,
  listSprints,
  listStates,
  listTickets,
  getProposalCounts,
  type ReviewQueueCounts,
} from '@/data/api';
import type { Sprint } from '@/types/entities';
import { listRecents, type RecentEntry, type RecentType } from '@/lib/recents';
import { EmptyState } from '@/components/ui/EmptyState';
import { parseSprintDate } from '@/pages/sprints/sprint-utils';

interface ActiveSprintSummary {
  sprint: Sprint;
  projectName: string;
  projectId: string;
  done: number;
  total: number;
  daysLeft: number;
}

// Home shows at most one sprint card — the mockup's own Home only ever
// surfaces a single active sprint, not a per-project list. Scans every
// project that actually has sprints (sparse projects have none) and
// returns the first one whose date range currently contains today, so a
// workspace mid-sprint on more than one project just shows whichever is
// found first rather than trying to rank them.
async function findActiveSprint(projectIds: { id: string; name: string }[]): Promise<ActiveSprintSummary | null> {
  const now = new Date();
  for (const project of projectIds) {
    const sprints = await listSprints(project.id);
    const active = sprints.find((s) => parseSprintDate(s.startDate) <= now && now <= parseSprintDate(s.endDate));
    if (!active) continue;
    const [tickets, states] = await Promise.all([
      listTickets(project.id, { v: 1, sprintIds: [active.id] }),
      listStates(project.id),
    ]);
    const completedStateIds = new Set(states.filter((s) => s.group === 'completed').map((s) => s.id));
    const done = tickets.filter((t) => completedStateIds.has(t.stateId)).length;
    const daysLeft = Math.max(0, Math.ceil((parseSprintDate(active.endDate).getTime() - now.getTime()) / 86_400_000));
    return { sprint: active, projectName: project.name, projectId: project.id, done, total: tickets.length, daysLeft };
  }
  return null;
}

const RECENTS_FETCH_LIMIT = 20;
const RECENTS_DISPLAY_LIMIT = 8;

type RecentsFilter = RecentType | 'all';

const RECENTS_FILTER_OPTIONS: { value: RecentsFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'ticket', label: 'Tickets' },
  { value: 'doc', label: 'Docs' },
  { value: 'sprint', label: 'Sprints' },
  { value: 'workstream', label: 'Workstreams' },
];

function RecentsFilterDropdown({
  value,
  onChange,
}: {
  value: RecentsFilter;
  onChange: (value: RecentsFilter) => void;
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

  const current = RECENTS_FILTER_OPTIONS.find((o) => o.value === value) ?? RECENTS_FILTER_OPTIONS[0];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2.5 text-xs font-medium text-text-secondary hover:bg-surface-2 hover:text-text"
      >
        {current.label}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="thin-scroll absolute right-0 z-30 mt-1 min-w-[160px] overflow-y-auto rounded-[var(--radius-sm)] border border-border bg-surface p-1 shadow-lg">
          {RECENTS_FILTER_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-sm text-text hover:bg-surface-2"
            >
              {option.label}
              {option.value === value && <Check size={14} className="text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const QUICKSTART_DISMISSED_KEY = 'waypoint:quickstart-dismissed';

function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 45) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  const diffYear = Math.round(diffMonth / 12);
  return `${diffYear}y ago`;
}

const RECENT_TYPE_ICON: Record<RecentType, typeof LayoutList> = {
  ticket: LayoutList,
  doc: FileText,
  sprint: RefreshCw,
  workstream: Boxes,
};

const QUICKSTART_CARDS = [
  {
    icon: FolderPlus,
    title: 'Create a project',
    description: 'Spin up a project to start tracking tickets, sprints, and workstreams.',
    to: '/projects',
  },
  {
    icon: UserPlus,
    title: 'Invite your team',
    description: 'Bring teammates in so work can be assigned and reviewed together.',
    to: '/settings/members',
  },
  {
    icon: Settings2,
    title: 'Set up your workspace',
    description: 'Configure workspace name, timezone, and defaults.',
    to: '/settings/general',
  },
  {
    icon: Sparkles,
    title: 'Make Waypoint yours',
    description: 'Pick a theme and tune your personal preferences.',
    to: '/profile/preferences',
  },
];

export default function Home() {
  const { data: user } = useAsync(() => getCurrentUser(), []);
  const { data: projects } = useAsync(() => listProjects(), []);
  const { data: proposalCounts } = useAsync<ReviewQueueCounts>(() => getProposalCounts(), []);
  const { data: activeSprint } = useAsync(async () => {
    if (!projects) return null;
    return findActiveSprint(projects.filter((p) => p.primitiveCounts.sprints > 0));
  }, [projects]);
  const [quickstartDismissed, setQuickstartDismissed] = useState(true);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [recentsFilter, setRecentsFilter] = useState<RecentsFilter>('all');

  useEffect(() => {
    setQuickstartDismissed(localStorage.getItem(QUICKSTART_DISMISSED_KEY) === '1');
    setRecents(listRecents(RECENTS_FETCH_LIMIT));
  }, []);

  function dismissQuickstart() {
    localStorage.setItem(QUICKSTART_DISMISSED_KEY, '1');
    setQuickstartDismissed(true);
  }

  // Onboarding only earns its place on an actually-empty workspace — once
  // there's a real project, the mockup's Home has no room for it at all
  // (it shows proposals-waiting + the active sprint + Recents instead), so
  // showing a permanent "get started" block on top of real content would
  // be exactly the kind of unconditional promotional clutter the removed
  // Quicklinks card was cut for.
  const showQuickstart = !quickstartDismissed && projects !== undefined && projects.length === 0;

  const projectById = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects]);

  const filteredRecents = useMemo(
    () =>
      recents
        .filter((r) => recentsFilter === 'all' || r.type === recentsFilter)
        .slice(0, RECENTS_DISPLAY_LIMIT),
    [recents, recentsFilter],
  );

  const now = new Date();
  const greeting = greetingForHour(now.getHours());
  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6 md:p-8">
      <div>
        <h1 className="font-display text-2xl font-medium text-text">
          {greeting}
          {user ? `, ${user.displayName}` : ''}
        </h1>
        <p className="mt-1 text-sm text-text-secondary">{dateLabel} · running locally, on this machine</p>
      </div>

      {showQuickstart && (
        <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-display text-sm font-medium text-text">Quickstart guide</h2>
              <p className="mt-0.5 text-xs text-text-secondary">A few things to get your workspace going.</p>
            </div>
            <button
              type="button"
              onClick={dismissQuickstart}
              className="inline-flex size-7 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text"
              aria-label="Dismiss quickstart guide"
            >
              <X size={16} />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {QUICKSTART_CARDS.map((card) => (
              <Link
                key={card.title}
                to={card.to}
                className="group flex flex-col gap-3 rounded-[var(--radius)] border border-border bg-bg p-4 transition-colors hover:border-accent"
              >
                <div className="flex size-9 items-center justify-center rounded-[var(--radius-sm)] bg-accent-soft-bg text-accent-soft-text">
                  <card.icon size={17} />
                </div>
                <div>
                  <p className="text-sm font-medium text-text">{card.title}</p>
                  <p className="mt-1 text-xs text-text-secondary">{card.description}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {proposalCounts && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Link
            to="/review"
            className="flex flex-col gap-1.5 rounded-[var(--radius-lg)] border border-border bg-surface p-5 transition-colors hover:border-accent"
          >
            <div className="flex items-center gap-2 font-display text-sm font-medium text-text">
              <ClipboardCheck size={16} />
              {proposalCounts.proposed} proposal{proposalCounts.proposed === 1 ? '' : 's'} waiting on you
            </div>
            <p className="text-xs text-text-secondary">
              {proposalCounts.blocked} blocked · {proposalCounts.recent} resolved in the last 24h
            </p>
          </Link>

          {activeSprint && (
            <Link
              to={`/projects/${activeSprint.projectId}/sprints/${activeSprint.sprint.id}`}
              className="flex flex-col gap-1.5 rounded-[var(--radius-lg)] border border-border bg-surface p-5 transition-colors hover:border-accent"
            >
              <div className="font-display text-sm font-medium text-text">
                {activeSprint.sprint.name} — {activeSprint.projectName}
              </div>
              <p className="text-xs text-text-secondary">
                {activeSprint.done} of {activeSprint.total} tickets done ·{' '}
                {activeSprint.daysLeft === 0
                  ? 'ends today'
                  : `ends in ${activeSprint.daysLeft} day${activeSprint.daysLeft === 1 ? '' : 's'}`}
              </p>
            </Link>
          )}
        </div>
      )}

      <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-medium text-text">Recents</h2>
          {recents.length > 0 && <RecentsFilterDropdown value={recentsFilter} onChange={setRecentsFilter} />}
        </div>
        <div className="mt-2">
          {filteredRecents.length > 0 ? (
            <div className="flex flex-col divide-y divide-border">
              {filteredRecents.map((recent) => {
                const Icon = RECENT_TYPE_ICON[recent.type];
                const project = projectById.get(recent.projectId);
                return (
                  <Link
                    key={`${recent.type}:${recent.id}`}
                    to={recent.path}
                    className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0 hover:text-text"
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-accent-soft-bg text-accent-soft-text">
                      <Icon size={15} />
                    </div>
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{recent.title}</span>
                    {project && (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-secondary">
                        <span>{project.icon}</span>
                        <span className="max-w-[120px] truncate">{project.name}</span>
                      </span>
                    )}
                    <span className="shrink-0 text-xs text-text-muted">{formatRelativeTime(recent.viewedAt)}</span>
                  </Link>
                );
              })}
            </div>
          ) : recents.length > 0 ? (
            <EmptyState
              icon={<Clock size={28} />}
              title="No matching recents"
              description="Try a different type filter."
            />
          ) : (
            <EmptyState
              icon={<Clock size={28} />}
              title="Nothing here yet"
              description="Tickets, docs, sprints, and workstreams you open will show up here."
            />
          )}
        </div>
      </section>
    </div>
  );
}
