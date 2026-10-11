import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  ArrowRight,
  CalendarDays,
  CircleDot,
  FilePen,
  GitBranch,
  Hash,
  Layers,
  Link2,
  MessageSquare,
  Paperclip,
  PenLine,
  Plus,
  Route,
  Signal,
  Sparkles,
  Tag,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import type { ActivityEntry, ActivityStateSnapshot, Comment, Priority, TicketState } from '@/types/entities';
import { Avatar } from '@/components/ui/Avatar';
import { StateIcon } from '@/components/domain/StateIcon';
import { PriorityIcon, PRIORITY_LABEL } from '@/components/domain/PriorityIcon';
import { agentLabel } from '@/lib/agentLabel';
import { agentCommentText, isDisclosedAgentHtml } from '@/lib/agentCommentHtml';
import {
  filterActivity,
  groupActivity,
  limitClusters,
  type ActivityFilter,
} from './activityModel';

export interface ActivityActor {
  name: string;
  color: string;
  shape: 'circle' | 'square';
}

const FILTERS: { key: ActivityFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'changes', label: 'Changes' },
  { key: 'comments', label: 'Comments' },
];

/** How many clusters show before "Show older activity". */
const FIRST_CLUSTERS = 8;

const PRIORITIES = new Set(Object.keys(PRIORITY_LABEL));

function clockOrRelative(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  if (!sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const mins = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function absolute(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function shortDate(value: string | number | null | undefined): string | null {
  if (value == null || value === '') return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A comment as one quiet line of words, whether typed markdown or an agent's HTML. */
function commentLine(body: string): string {
  if (isDisclosedAgentHtml(body)) return agentCommentText(body);
  return body
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function Arrow() {
  return (
    <>
      <ArrowRight size={12} aria-hidden="true" className="mx-1 inline shrink-0 align-[-1px] text-text-muted" />
      <span className="sr-only"> to </span>
    </>
  );
}

function StatePill({ state, live }: { state: ActivityStateSnapshot | null | undefined; live?: TicketState }) {
  if (!state) return <span className="text-text-muted">none</span>;
  // The live state when it still exists (it may have been renamed or
  // recoloured since), else the snapshot taken when this was written.
  const shown = live ?? state;
  return (
    <span className="inline-flex items-center gap-1 rounded-[6px] border border-border bg-surface px-1.5 py-px align-[1px] text-[12px] font-medium text-text">
      <StateIcon state={{ group: shown.group as TicketState['group'], color: shown.color }} size={11} />
      {shown.name}
    </span>
  );
}

function PriorityPill({ value }: { value: string | number | null | undefined }) {
  if (typeof value !== 'string' || !PRIORITIES.has(value)) return <span className="text-text-muted">none</span>;
  const p = value as Priority;
  return (
    <span className="inline-flex items-center gap-1 rounded-[6px] border border-border bg-surface px-1.5 py-px align-[1px] text-[12px] font-medium text-text">
      <PriorityIcon priority={p} size={11} />
      {PRIORITY_LABEL[p]}
    </span>
  );
}

function Strong({ children }: { children: ReactNode }) {
  return <span className="font-medium text-text">{children}</span>;
}

/** One change, as an icon and a sentence (the actor's name is in the cluster header). */
function describe(
  e: ActivityEntry,
  ctx: {
    statesById: Map<string, TicketState>;
    commentsById: Map<string, Comment>;
    /** Older entries carry no commentId; they share the comment's author and instant. */
    commentsByAuthorAt: Map<string, Comment>;
    /** Until comments load, a missing one is unknown, not deleted. */
    commentsLoaded: boolean;
    projectId: string;
    onJumpToComment: (id: string) => void;
  },
): { Icon: typeof CircleDot; body: ReactNode } {
  const p = e.payload ?? {};
  const legacy = <span>{e.detail}</span>;
  switch (e.verb) {
    case 'created':
      return {
        Icon: Sparkles,
        body: p.toState ? (
          <span>
            created the ticket in <StatePill state={p.toState} live={ctx.statesById.get(p.toState.id)} />
          </span>
        ) : (
          <span>created the ticket</span>
        ),
      };
    case 'state_changed':
      return {
        Icon: CircleDot,
        body:
          p.toState !== undefined ? (
            <span>
              changed status <StatePill state={p.fromState} live={p.fromState ? ctx.statesById.get(p.fromState.id) : undefined} />
              <Arrow />
              <StatePill state={p.toState} live={p.toState ? ctx.statesById.get(p.toState.id) : undefined} />
            </span>
          ) : (
            legacy
          ),
      };
    case 'priority_changed':
      return {
        Icon: Signal,
        body:
          p.to !== undefined ? (
            <span>
              changed priority <PriorityPill value={p.from} />
              <Arrow />
              <PriorityPill value={p.to} />
            </span>
          ) : (
            legacy
          ),
      };
    case 'assignee_added':
    case 'assignee_removed': {
      const verb = e.verb === 'assignee_added' ? 'assigned' : 'unassigned';
      const Icon = e.verb === 'assignee_added' ? UserPlus : UserMinus;
      if (p.personId === e.actorId) return { Icon, body: <span>{verb} themselves</span> };
      return { Icon, body: p.personName ? <span>{verb} <Strong>{p.personName}</Strong></span> : legacy };
    }
    case 'label_added':
    case 'label_removed':
      return {
        Icon: Tag,
        body: p.labelName ? (
          <span>
            {e.verb === 'label_added' ? 'added label' : 'removed label'}{' '}
            <span
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-px align-[1px] text-[12px] font-medium text-text',
                e.verb === 'label_removed' && 'line-through decoration-text-muted',
              )}
            >
              <span aria-hidden="true" className="size-2 rounded-full" style={{ background: p.labelColor ?? 'var(--text-muted)' }} />
              {p.labelName}
            </span>
          </span>
        ) : (
          legacy
        ),
      };
    case 'start_date_set':
    case 'due_date_set': {
      const which = e.verb === 'due_date_set' ? 'due date' : 'start date';
      if (p.to === undefined) return { Icon: CalendarDays, body: legacy };
      const from = shortDate(p.from);
      const to = shortDate(p.to);
      return {
        Icon: CalendarDays,
        body: !to ? (
          <span>
            removed the {which}
            {from && <span className="text-text-muted"> ({from})</span>}
          </span>
        ) : from ? (
          <span>
            moved the {which} <Strong>{from}</Strong>
            <Arrow />
            <Strong>{to}</Strong>
          </span>
        ) : (
          <span>
            set the {which} to <Strong>{to}</Strong>
          </span>
        ),
      };
    }
    case 'points_changed': {
      const pts = (n: string | number) => `${n} ${Number(n) === 1 ? 'story point' : 'story points'}`;
      return {
        Icon: Hash,
        body:
          p.to == null ? (
            <span>removed the story points</span>
          ) : p.from == null ? (
            <span>
              set <Strong>{pts(p.to)}</Strong>
            </span>
          ) : (
            <span>
              changed story points <Strong>{p.from}</Strong>
              <Arrow />
              <Strong>{p.to}</Strong>
            </span>
          ),
      };
    }
    case 'estimate_changed':
      return {
        Icon: Hash,
        body:
          p.to === undefined ? (
            legacy
          ) : p.to == null ? (
            <span>removed the estimate</span>
          ) : p.from == null ? (
            <span>
              estimated it at <Strong>{p.to}</Strong>
            </span>
          ) : (
            <span>
              changed the estimate <Strong>{p.from}</Strong>
              <Arrow />
              <Strong>{p.to}</Strong>
            </span>
          ),
      };
    case 'title_changed':
      return {
        Icon: PenLine,
        body: (
          <span>
            renamed the ticket
            {p.from != null && (
              <span className="mt-0.5 block text-[12.5px]">
                <span className="text-text-muted line-through decoration-text-muted/60">{p.from}</span>
                <Arrow />
                <span className="text-text">{p.to}</span>
              </span>
            )}
          </span>
        ),
      };
    case 'description_changed':
      return { Icon: FilePen, body: <span>{p.to === null ? 'cleared the description' : 'updated the description'}</span> };
    case 'sprint_changed':
    case 'workstream_changed': {
      const Icon = e.verb === 'sprint_changed' ? Layers : Route;
      const what = e.verb === 'sprint_changed' ? 'sprint' : 'workstream';
      if (p.toName === undefined && p.fromName === undefined) return { Icon, body: legacy };
      return {
        Icon,
        body:
          p.fromName && p.toName ? (
            <span>
              moved {what} <Strong>{p.fromName}</Strong>
              <Arrow />
              <Strong>{p.toName}</Strong>
            </span>
          ) : p.toName ? (
            <span>
              added to {what} <Strong>{p.toName}</Strong>
            </span>
          ) : p.fromName ? (
            <span>
              removed from {what} <Strong>{p.fromName}</Strong>
            </span>
          ) : (
            <span>removed from the {what}</span>
          ),
      };
    }
    case 'commented': {
      const c = p.commentId
        ? ctx.commentsById.get(p.commentId)
        : ctx.commentsByAuthorAt.get(`${e.actorId}|${new Date(e.createdAt).getTime()}`);
      if (!c && (!p.commentId || !ctx.commentsLoaded)) {
        return { Icon: MessageSquare, body: p.commentId ? <span>commented</span> : legacy };
      }
      if (!c) {
        return {
          Icon: MessageSquare,
          body: (
            <span>
              commented <span className="text-text-muted">(since deleted)</span>
            </span>
          ),
        };
      }
      const line = commentLine(c.bodyHtml);
      return {
        Icon: MessageSquare,
        body: (
          <span>
            {e.detail !== 'left a comment' ? e.detail : 'commented'}
            {line && (
              <button
                type="button"
                onClick={() => ctx.onJumpToComment(c.id)}
                className="mt-0.5 block w-full cursor-pointer truncate border-l-2 border-border-strong pl-2 text-left text-[12.5px] text-text-secondary hover:text-text"
                title="Jump to the comment"
                aria-label={`Jump to comment: ${line}`}
              >
                {line}
              </button>
            )}
          </span>
        ),
      };
    }
    case 'link_added':
    case 'link_removed':
      return {
        Icon: Link2,
        body: p.url ? (
          <span>
            {e.verb === 'link_added' ? 'added a link' : 'removed a link'}{' '}
            {e.verb === 'link_added' ? (
              <a href={p.url} target="_blank" rel="noreferrer" className="font-medium text-text underline decoration-border-strong underline-offset-2 hover:decoration-text">
                {p.label || p.url}
              </a>
            ) : (
              <Strong>{p.label || p.url}</Strong>
            )}
          </span>
        ) : (
          legacy
        ),
      };
    case 'attachment_added':
    case 'attachment_removed':
      return {
        Icon: Paperclip,
        body: p.filename ? (
          <span>
            {e.verb === 'attachment_added' ? 'attached' : 'removed'} <Strong>{p.filename}</Strong>
          </span>
        ) : (
          legacy
        ),
      };
    case 'sub_item_added':
      return {
        Icon: GitBranch,
        body: p.childKey ? (
          <span>
            added a sub-item{' '}
            <Link to={`/projects/${ctx.projectId}/tickets/${p.childKey}`} className="font-medium text-text hover:underline">
              <span className="font-mono text-[12px] text-text-muted">{p.childKey}</span> {p.childTitle}
            </Link>
          </span>
        ) : (
          legacy
        ),
      };
    default:
      return { Icon: Plus, body: legacy };
  }
}

/**
 * The ticket's history as something you can read: newest first, sectioned
 * by day, and each person's burst of changes folded under one header, with
 * statuses, priorities and labels shown as the pills they are elsewhere.
 */
export function TicketActivity({
  entries,
  comments,
  commentsLoaded,
  statesById,
  resolveActor,
  projectId,
  onJumpToComment,
}: {
  entries: ActivityEntry[] | undefined;
  comments: Comment[] | undefined;
  /** False while comments are loading or failed to: nothing reads as deleted then. */
  commentsLoaded: boolean;
  statesById: Map<string, TicketState>;
  resolveActor: (id: string) => ActivityActor;
  projectId: string;
  /** Scrolls to the comment in the thread on this same page (no navigation). */
  onJumpToComment: (commentId: string) => void;
}) {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const commentsById = useMemo(() => new Map((comments ?? []).map((c) => [c.id, c])), [comments]);
  const commentsByAuthorAt = useMemo(
    () => new Map((comments ?? []).map((c) => [`${c.authorId}|${new Date(c.createdAt).getTime()}`, c])),
    [comments],
  );
  const grouped = useMemo(() => groupActivity(filterActivity(entries ?? [], filter)), [entries, filter]);
  const { days, hidden } = showAll ? { days: grouped, hidden: 0 } : limitClusters(grouped, FIRST_CLUSTERS);
  const ctx = {
    statesById,
    commentsById,
    commentsByAuthorAt,
    commentsLoaded,
    projectId,
    onJumpToComment,
  };

  return (
    <section aria-labelledby="ticket-activity-heading">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 id="ticket-activity-heading" className="font-display text-sm font-medium text-text">
          Activity
        </h3>
        <div role="group" aria-label="Show" className="inline-flex items-center gap-0.5 rounded-[9px] bg-surface-2 p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => {
                setFilter(f.key);
                setShowAll(false);
              }}
              className={clsx(
                'h-6 cursor-pointer rounded-[7px] px-2.5 text-[12px] font-medium transition-colors',
                filter === f.key ? 'bg-surface text-text shadow-[0_1px_2px_rgb(0_0_0/0.08)]' : 'text-text-secondary hover:text-text',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {days.length === 0 ? (
        <p className="rounded-[var(--radius)] border border-dashed border-border px-4 py-5 text-center text-[13px] text-text-muted">
          {filter === 'comments' ? 'No comments yet.' : filter === 'changes' ? 'No changes yet.' : 'No activity yet.'}
        </p>
      ) : (
        <div className="space-y-5">
          {days.map((day) => (
            <div key={day.label}>
              <h4 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">{day.label}</h4>
              <ol className="relative space-y-4 before:absolute before:top-3 before:bottom-3 before:left-[11px] before:w-px before:bg-border">
                {day.clusters.map((cluster) => {
                  const actor = resolveActor(cluster.actorId);
                  const name = actor.shape === 'square' ? agentLabel(actor.name) : actor.name;
                  const { via } = cluster;
                  return (
                    <li key={cluster.key} className="relative flex gap-3">
                      <span className="relative z-[1] shrink-0">
                        <Avatar name={actor.name} color={actor.color} shape={actor.shape} size={24} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] leading-6">
                          <span className="font-medium text-text">{name}</span>
                          <span className="text-[12px] text-text-muted tabular-nums" title={absolute(cluster.at)}>
                            {clockOrRelative(cluster.at)}
                          </span>
                          {via && (
                            <span className="rounded-full bg-info-bg px-1.5 py-px text-[10.5px] font-semibold text-info">
                              via {via === 'copilot' ? 'Copilot' : 'session'}
                            </span>
                          )}
                        </div>
                        <ul className="mt-0.5 space-y-1.5">
                          {cluster.entries.map((e) => {
                            const { Icon, body } = describe(e, ctx);
                            return (
                              <li key={e.id} className="flex min-w-0 items-start gap-2 text-[13px] leading-5 text-text-secondary" title={absolute(e.createdAt)}>
                                <Icon size={14} strokeWidth={1.9} aria-hidden="true" className="mt-[3px] shrink-0 text-text-muted" />
                                <span className="min-w-0 flex-1">{body}</span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
          {/* One button whose label flips, so keyboard focus stays on it. */}
          {(hidden > 0 || showAll) && (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
              className="cursor-pointer text-[12.5px] font-medium text-text-secondary hover:text-text"
            >
              {showAll ? 'Show less' : `Show ${hidden} older ${hidden === 1 ? 'update' : 'updates'}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
