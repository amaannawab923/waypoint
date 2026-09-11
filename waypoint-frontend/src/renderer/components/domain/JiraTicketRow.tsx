import { useEffect, useRef, useState } from 'react';
import {
  getJiraPriorityOptions,
  getJiraTransitions,
  setJiraTicketPriority,
  transitionJiraTicket,
} from '@/data/jiraApi';
import { showErrorToast } from '@/lib/toast';
import { Avatar } from '@/components/ui/Avatar';
import {
  JiraPriorityChip,
  JiraPriorityPicker,
} from '@/components/domain/JiraPriorityPicker';
import {
  JiraStateChip,
  JiraTransitionPopover,
} from '@/components/domain/JiraTransitionPopover';
import { jiraProjectColor } from '@/types/jira';
import type {
  JiraPriorityOption,
  JiraTicket,
  JiraTransition,
} from '@/types/jira';

function roleLabel(ticket: JiraTicket): string {
  if (ticket.isTombstoned) return 'was yours';
  if (ticket.role === 'watcher') return 'watching';
  // None of the three roles the queue's query matches on — and Jira said so
  // outright rather than this app failing to work it out (see jiraMap's
  // roleOf). "not yours", next to the tombstone strip's "was yours".
  if (ticket.role === 'none') return 'not yours';
  return ticket.role;
}

/**
 * One row in the My Jira ticket list. Owns everything about that ticket's
 * own interaction: fetching/opening its transition and priority pickers, the
 * actual transitionJiraTicket / setJiraTicketPriority writes (and each chip's
 * own "saving" state while one is in flight — both pickers are pure and
 * neither calls the data layer itself), and the conflict/tombstone
 * quiet-strip variants.
 *
 * The two pickers keep separate open/loading/error/saving state rather than
 * sharing one set. They read different endpoints and fail independently, and
 * collapsing them would mean a failed transitions read putting an error in
 * the priority menu.
 */
export function JiraTicketRow({
  ticket,
  onOpenDrawer,
  onTicketUpdated,
  onResolveConflict,
  onDismissTombstone,
}: {
  ticket: JiraTicket;
  onOpenDrawer: (ticketId: string) => void;
  onTicketUpdated: (updated: JiraTicket) => void;
  onResolveConflict: (ticketId: string) => Promise<void>;
  onDismissTombstone: (ticketId: string) => Promise<void>;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [transitions, setTransitions] = useState<JiraTransition[]>([]);
  const [loadingTransitions, setLoadingTransitions] = useState(false);
  const [transitionsError, setTransitionsError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [priorityOptions, setPriorityOptions] = useState<JiraPriorityOption[]>(
    [],
  );
  const [loadingPriorities, setLoadingPriorities] = useState(false);
  const [prioritiesError, setPrioritiesError] = useState<Error | null>(null);
  const [savingPriority, setSavingPriority] = useState(false);
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const stateChipRef = useRef<HTMLButtonElement>(null);
  const priorityChipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    let cancelled = false;
    setLoadingTransitions(true);
    setTransitionsError(null);
    getJiraTransitions(ticket.id)
      .then((rows) => {
        if (!cancelled) setTransitions(rows);
      })
      // This chain had no `.catch()` at all, so a broken connection produced
      // an unhandled rejection *and* left the popover rendering "No
      // transitions available from here." — telling the user their Jira
      // workflow is a dead end when the real cause is that Waypoint never
      // reached Jira. Two different facts; they now render differently.
      .catch((err: unknown) => {
        if (cancelled) return;
        setTransitions([]);
        setTransitionsError(
          err instanceof Error ? err : new Error(String(err)),
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingTransitions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [popoverOpen, ticket.id]);

  // Fetched on open, never cached: a project's priority scheme is an admin
  // setting that can change under a menu, and unlike transitions there is no
  // already-paid-for copy riding along with the ticket list. Same lazy shape
  // as the transitions read above, including the `.catch()` — without one, a
  // broken connection would render "No priority options here.", which is a
  // claim about the user's Jira that a failed request cannot support.
  useEffect(() => {
    if (!priorityOpen) return undefined;
    let cancelled = false;
    setLoadingPriorities(true);
    setPrioritiesError(null);
    getJiraPriorityOptions(ticket.id)
      .then((rows) => {
        if (!cancelled) setPriorityOptions(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPriorityOptions([]);
        setPrioritiesError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoadingPriorities(false);
      });
    return () => {
      cancelled = true;
    };
  }, [priorityOpen, ticket.id]);

  async function handleSelectPriority(option: JiraPriorityOption) {
    setPriorityOpen(false);
    setSavingPriority(true);
    try {
      const updated = await setJiraTicketPriority(ticket.id, option.id);
      onTicketUpdated(updated);
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : "Could not change this ticket's priority in Jira.",
      );
    } finally {
      setSavingPriority(false);
    }
  }

  async function handleSelectTransition(
    transition: JiraTransition,
    fieldValues: Record<string, string>,
  ) {
    setPopoverOpen(false);
    setSaving(true);
    try {
      const updated = await transitionJiraTicket(
        ticket.id,
        transition.id,
        fieldValues,
      );
      onTicketUpdated(updated);
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : 'Could not move this ticket in Jira.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleResolveConflict() {
    setResolvingConflict(true);
    try {
      await onResolveConflict(ticket.id);
    } finally {
      setResolvingConflict(false);
    }
  }

  async function handleDismissTombstone() {
    setDismissing(true);
    try {
      await onDismissTombstone(ticket.id);
    } finally {
      setDismissing(false);
    }
  }

  const projectColor = jiraProjectColor(ticket.projectKey);

  if (ticket.isTombstoned) {
    return (
      <div className="border-b border-border last:border-b-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-3.5 py-2 text-[11.5px] text-text-secondary">
          <span>
            <b className="text-text">
              Reassigned to {ticket.tombstone?.reassignedTo}
            </b>{' '}
            {relativeMinutesLabel(ticket.tombstone?.reassignedAt)} — no longer
            yours. Kept here for 24 hours so it doesn't vanish mid-thought.
          </span>
          <span className="ml-auto flex shrink-0 gap-3">
            <button
              type="button"
              disabled
              title="Opening a ticket in Jira isn't wired up yet."
              className="text-[11.5px] font-bold text-text-muted underline decoration-border-strong"
            >
              Open in Jira
            </button>
            <button
              type="button"
              disabled={dismissing}
              onClick={handleDismissTombstone}
              className="text-[11.5px] font-bold text-accent underline disabled:opacity-50"
            >
              {dismissing ? 'Dismissing…' : 'Dismiss now'}
            </button>
          </span>
        </div>
        <div
          className="flex items-center gap-2.5 bg-surface-2 px-3.5 py-2.5"
          style={{ borderLeft: '3px solid var(--border-strong)' }}
        >
          <span className="w-[76px] shrink-0 font-mono text-[11.5px] font-semibold text-text-muted">
            <b className="font-bold">{ticket.projectKey}</b>-
            {ticket.key.split('-')[1]}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text-muted line-through decoration-border-strong">
            {ticket.title}
          </span>
          {/* Same reflow fix as the live row below — see the ROAD-27 /
              JIRA-157 arithmetic on its badge wrapper for the full numbers. */}
          <div className="flex flex-wrap items-center justify-end gap-2.5">
            <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-text-muted uppercase">
              {roleLabel(ticket)}
            </span>
            <JiraStateChip
              stateName={ticket.stateName}
              stateColor={ticket.stateColor}
              disabled
              disabledTitle="Not yours to move any more"
              onClick={() => {}}
            />
            <JiraPriorityChip
              priority={ticket.priority}
              priorityName={ticket.priorityName}
              disabled
              disabledTitle="Not yours to change any more"
              onClick={() => {}}
            />
            <Avatar name={ticket.assigneeName} size={22} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-border last:border-b-0">
      {ticket.hasConflict && ticket.conflict && (
        <div className="flex items-center gap-2 border-b border-border bg-warning-bg px-3.5 py-1.5 text-[11.5px] text-warning">
          <span>
            {ticket.conflict.changedBy} changed this in Jira{' '}
            {relativeSecondsLabel(ticket.conflict.changedAt)} — your first
            conflict in 3 weeks.
          </span>
          <button
            type="button"
            disabled={resolvingConflict}
            onClick={handleResolveConflict}
            className="ml-auto shrink-0 text-[11.5px] font-bold text-warning underline disabled:opacity-60"
          >
            {resolvingConflict ? 'Reloading…' : 'Reload'}
          </button>
        </div>
      )}
      <div
        className="relative flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-surface-2"
        style={{ borderLeft: `3px solid ${projectColor}` }}
      >
        <span className="w-[76px] shrink-0 font-mono text-[11.5px] font-semibold text-text-muted">
          <b style={{ color: projectColor }}>{ticket.projectKey}</b>-
          {ticket.key.split('-')[1]}
        </span>
        <button
          type="button"
          onClick={() => onOpenDrawer(ticket.id)}
          className="min-w-0 flex-1 truncate text-left text-[13.5px] font-medium text-text hover:underline"
        >
          {ticket.title}
        </button>
        {/*
         * ROAD-27 / JIRA-157: at a 600px viewport this row's content box is
         * only ~222px (600 − 256 sidebar `w-64` − 48 the page's `p-6` − 41
         * `ml-[41px]` − 2 MyJiraPage.tsx's list-wrapper border − 3 this row's
         * own borderLeft − 28 this row's own `px-3.5`). Before this fix, the
         * six children here (key, title, role tag, state chip, priority
         * chip, avatar) were all direct siblings on one non-wrapping flex
         * row: the five `shrink-0` children plus five `gap-2.5` gaps alone
         * summed to ~300px ("Done") – ~344px ("In Progress"), which already
         * exceeds the 222px content box even with the title (`min-w-0
         * flex-1 truncate`) collapsed to 0 — the row silently overflowed by
         * 80-120px and was clipped by the list wrapper's `overflow-hidden`.
         * An unbounded custom workflow state name ("Waiting for customer
         * response", ~225px) pushed the failure as high as ~850px
         * viewports.
         *
         * Two changes fix it together — bounding the chip alone cannot: even
         * shrinking the state chip to 0 width, the other four `shrink-0`
         * children plus their gaps still sum to ~227px, already over the
         * 222px budget.
         *
         * (1) JiraTransitionPopover.tsx's JiraStateChip now bounds its label
         * to `max-w-[80px]` + `truncate`, removing the one unbounded
         * contributor — ordinary state names stay fully visible ("In
         * Progress"'s label is ~72px, under the cap).
         *
         * (2) The four trailing badges below are grouped into their own
         * `flex flex-wrap` sub-row instead of being direct children of this
         * non-wrapping outer row. On a wide window they still lay out on one
         * line — the wrapper has no `flex-grow`, so it only ever claims the
         * width its content needs. Once the outer row runs out of space, the
         * wrapper is squeezed toward its own min-content width, and for a
         * *wrapping* flex container that min-content width is the width of
         * its single widest child (not the sum of all four) — so the badges
         * wrap onto their own lines inside it instead of being clipped by
         * the list wrapper.
         *
         * Re-running the arithmetic for the worst realistic case (state "In
         * Progress", role "ASSIGNEE", chip unclipped since its 72px label is
         * under the 80px cap): the wrapper's min-content width is
         * max(role ~65, chip ~107, priority ~24, avatar ~22) = ~107px.
         * Minimum row width with the title at 0 is key 76 + wrapper 107 + 2
         * remaining `gap-2.5` (20) = 203px of content box, i.e. a ~581px
         * viewport (203 + 378 non-content chrome) — under the 600px target,
         * leaving ~19px for the title itself at exactly 600px. The
         * pathological long-name case (chip clipped to its 80px-label cap,
         * ~115px total) needs 76 + 115 + 20 = 211px content box, a ~589px
         * viewport — still under 600. Every fixed child stays visible in
         * both cases; nothing here is hidden.
         *
         * This is a predicted, not measured, arithmetic — jsdom does no
         * layout, so it cannot be proven from these tests. The class
         * assertions below pin the pieces this depends on; the live 600px
         * check happens in the running app.
         */}
        <div className="flex flex-wrap items-center justify-end gap-2.5">
          <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-text-muted uppercase">
            {roleLabel(ticket)}
          </span>
          <JiraStateChip
            stateName={ticket.stateName}
            stateColor={ticket.stateColor}
            disabled={ticket.hasConflict}
            disabledTitle="Write paused until reloaded"
            saving={saving}
            open={popoverOpen}
            buttonRef={stateChipRef}
            onClick={() => setPopoverOpen((o) => !o)}
          />
          <JiraPriorityChip
            priority={ticket.priority}
            priorityName={ticket.priorityName}
            disabled={ticket.hasConflict}
            disabledTitle="Write paused until reloaded"
            saving={savingPriority}
            open={priorityOpen}
            buttonRef={priorityChipRef}
            onClick={() => setPriorityOpen((o) => !o)}
          />
          <Avatar name={ticket.assigneeName} size={22} />
        </div>

        {priorityOpen && (
          <JiraPriorityPicker
            ticketKey={ticket.key}
            currentPriorityId={ticket.priorityId}
            options={priorityOptions}
            loading={loadingPriorities}
            error={prioritiesError}
            triggerRef={priorityChipRef}
            onSelect={handleSelectPriority}
            onClose={() => setPriorityOpen(false)}
          />
        )}

        {popoverOpen && (
          <JiraTransitionPopover
            ticketKey={ticket.key}
            projectKey={ticket.projectKey}
            currentStateName={ticket.stateName}
            transitions={transitions}
            loading={loadingTransitions}
            error={transitionsError}
            triggerRef={stateChipRef}
            onSelect={handleSelectTransition}
            onClose={() => setPopoverOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function relativeSecondsLabel(iso?: string): string {
  if (!iso) return 'just now';
  const secs = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}

function relativeMinutesLabel(iso?: string): string {
  if (!iso) return 'just now';
  const mins = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60_000),
  );
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  return `${Math.round(mins / 60)}h ago`;
}
