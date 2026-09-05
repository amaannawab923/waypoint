import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { searchJiraAssignableUsers } from '@/data/jiraApi';
import { useFloatingPanel } from '@/components/ui/useFloatingPanel';
import { useJiraConnection } from '@/lib/jiraStore';
import { Avatar } from '@/components/ui/Avatar';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import type { JiraUserOption } from '@/types/jira';

const PANEL_WIDTH = 268; // w-[268px]
const PANEL_HEIGHT_ESTIMATE = 300; // corrected on mount by the hook

// Long enough that a normal typing rate produces one request per word rather
// than one per keystroke, short enough that the list has caught up by the time
// a user stops to read it.
const SEARCH_DEBOUNCE_MS = 250;

/** The "this is where the issue already is" marker, shared by all three kinds
 * of row so the current state is legible whether it's a person, yourself, or
 * nobody. */
function CurrentTag() {
  return (
    <span className="ml-auto shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-text-muted uppercase">
      current
    </span>
  );
}

/**
 * The assignee menu, anchored under the drawer's assignee chip.
 *
 * Unlike JiraPriorityPicker and JiraTransitionPopover, this one owns its own
 * read. Those two are pure because their whole option list is a single fetch
 * their parent can just as easily make; this one's list is a function of a
 * query the user is typing into a box inside the panel, so the debounce, the
 * in-flight cancellation and the loading/error state it produces all belong
 * with the input that drives them. Pushing them up would mean the drawer
 * holding a piece of state whose only reader is this component.
 *
 * The write stays with the parent, exactly as it does for the other two: this
 * turns a click into one `onSelect(accountId)` call — `null` for Unassign —
 * and the drawer owns setJiraTicketAssignee and the chip's saving state.
 *
 * Placement, click-away, Escape (capture-phase, so dismissing this doesn't
 * also close the drawer around it) and focus all come from `useFloatingPanel`.
 * Focus lands on the search box on open, because it is the panel's first
 * focusable child.
 */
export function JiraAssigneePicker({
  ticketKey,
  currentAssigneeAccountId,
  triggerRef,
  onSelect,
  onClose,
}: {
  /** The issue KEY, not its id: Jira's assignable-user search is specified in
   * terms of `issueKey`, and this is the one call in the feature that differs.
   * Also what the panel's heading says, which is why it's needed either way. */
  ticketKey: string;
  /** Marks where the issue already is. `null` marks the Unassign row instead
   * of a person — an unassigned issue is a real state, not an unknown one. */
  currentAssigneeAccountId: string | null;
  /** The assignee chip this hangs off. The panel is portaled to <body> and
   * cannot find it by DOM position, and it is also what keeps a click on the
   * chip itself from counting as a click-away. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** `null` means unassign — a value the user chose, not a missing one. */
  onSelect: (accountId: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<JiraUserOption[]>([]);
  const [loading, setLoading] = useState(true);
  // Kept separate from an empty `users` array on purpose: "nobody on this site
  // can take this issue" and "we could not ask Jira who can" are different
  // answers. A site that restricts the "Browse users and groups" permission
  // answers this search with a 403, and rendering that as an empty result
  // would tell the user their colleagues do not exist.
  const [error, setError] = useState<Error | null>(null);

  const connection = useJiraConnection();
  const myAccountId = connection?.accountId ?? '';
  const myName = connection?.accountName || 'me';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      searchJiraAssignableUsers(ticketKey, query)
        .then((rows) => {
          if (!cancelled) setUsers(rows);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setUsers([]);
          setError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      // Both halves matter: clearing the timer drops a request that hasn't
      // been made yet, and the flag drops the answer to one already in flight
      // — otherwise a slow response to "sa" lands on top of the results for
      // "sam".
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ticketKey, query]);

  const { panelProps } = useFloatingPanel({
    triggerRef,
    onClose,
    width: PANEL_WIDTH,
    estimatedHeight: PANEL_HEIGHT_ESTIMATE,
    label: `Assign ${ticketKey} to`,
    // Each of these swaps the panel's contents for something of a different
    // height, so each has to trigger a re-measure.
    remeasureOn: [loading, error, users],
  });

  return createPortal(
    <div
      // Applied one by one rather than spread: this codebase forbids prop
      // spreading (react/jsx-props-no-spreading), and being able to read
      // exactly what the hook puts on this element is worth the six lines.
      ref={panelProps.ref}
      tabIndex={panelProps.tabIndex}
      role={panelProps.role}
      aria-label={panelProps['aria-label']}
      data-shortcut-guard={panelProps['data-shortcut-guard']}
      style={panelProps.style}
      onClick={panelProps.onClick}
      // z-[60], matching the other two pickers: as a child of <body> this is a
      // sibling of the ticket drawer's z-50 backdrop rather than nested in it.
      // Stays under ToastHost's z-[200].
      className="fixed z-[60] w-[268px] overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface text-left shadow-2xl outline-none"
    >
      <div className="px-3 pt-2.5 pb-1.5 text-[10.5px] font-bold tracking-wide text-text-muted uppercase">
        Assign {ticketKey}
      </div>

      <div className="px-3 pb-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people…"
          aria-label={`Search people who can be assigned ${ticketKey}`}
          className="w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg-inset px-2 py-1.5 text-[12.5px] text-text outline-none focus:border-accent"
        />
      </div>

      {/* Pinned above the results rather than left to be found in them. It is
          the most common reassignment there is, it needs no query, and on a
          site that restricts user search it is the one row that still works —
          because it is built from the connected identity this app already
          holds, not from a search. Hidden entirely when that identity has no
          account id, since "me" would then be a button with nothing to write. */}
      {myAccountId && (
        <button
          type="button"
          onClick={() => onSelect(myAccountId)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-text hover:bg-surface-2"
        >
          {/* Decorative. The initials repeat a name that is already written
              next to them in full, so announcing both would name this button
              "MC Assign to me". Same for every avatar in this panel. */}
          <span aria-hidden="true" className="flex shrink-0">
            <Avatar name={myName} size={20} />
          </span>
          Assign to me
          {currentAssigneeAccountId === myAccountId && <CurrentTag />}
        </button>
      )}

      <button
        type="button"
        onClick={() => onSelect(null)}
        className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm font-medium text-text-secondary hover:bg-surface-2"
      >
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-border-strong text-[10px] text-text-muted"
        >
          –
        </span>
        Unassign
        {currentAssigneeAccountId === null && <CurrentTag />}
      </button>

      {loading && (
        <div className="px-3 py-3 text-xs text-text-muted">
          Searching people…
        </div>
      )}
      {!loading && error && (
        <JiraLoadError
          compact
          what={`who can be assigned ${ticketKey}`}
          error={error}
        />
      )}
      {/* A real zero-result search, and only ever a real one — the error above
          is what a failed or forbidden search renders as. */}
      {!loading && !error && users.length === 0 && (
        <div className="px-3 py-3 text-xs text-text-muted">
          {query.trim()
            ? `Nobody assignable matches “${query.trim()}”.`
            : 'Nobody else can be assigned this issue.'}
        </div>
      )}
      {!error &&
        users.map((user) => (
          <button
            key={user.accountId}
            type="button"
            onClick={() => onSelect(user.accountId)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-text hover:bg-surface-2"
          >
            <span aria-hidden="true" className="flex shrink-0">
              <Avatar name={user.displayName} size={20} />
            </span>
            <span className="min-w-0 truncate">{user.displayName}</span>
            {user.accountId === currentAssigneeAccountId && <CurrentTag />}
          </button>
        ))}

      {/* Suppressed on error, like the other two pickers': this footer asserts
          that what sits above it is your site's real answer, which is exactly
          the claim a failed search cannot back. */}
      {!error && (
        <div className="border-t border-border px-3 py-2.5 text-[10.5px] leading-relaxed text-text-muted">
          These are the people{' '}
          <b className="text-text-secondary">your Jira site</b> allows on this
          issue — Waypoint doesn&apos;t invent them.
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * The drawer's assignee chip, as a button that opens the picker above.
 *
 * The accessible name is an `aria-label`, not the visible text, and that is
 * not interchangeable here: `title` is where the "why is this disabled" reason
 * goes, and on a control whose name came from `title` that would mean losing
 * the name in exactly the state a screen-reader user most needs it. The same
 * trap JiraPriorityChip documents — worth handling identically rather than
 * rediscovering, since this chip is also the one place in the drawer where a
 * write hides behind something that used to be a plain label.
 */
export function JiraAssigneeChip({
  assigneeName,
  disabled,
  disabledTitle,
  saving,
  open,
  compact,
  buttonRef,
  onClick,
}: {
  assigneeName: string;
  disabled?: boolean;
  disabledTitle?: string;
  saving?: boolean;
  open?: boolean;
  /** Drops the "Assignee · " prefix and renders as a full-width property
   * row instead of a pill. For the detail view's properties rail, where the
   * row's own label column already reads "Assignee" — repeating it there
   * both said the word twice and wrapped the pill onto two lines. The
   * accessible name is deliberately unchanged either way: it is what names
   * this control for a screen reader, and it should not depend on which
   * layout the control happens to be sitting in. */
  compact?: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled || saving}
      aria-label={`Assignee: ${assigneeName}`}
      title={disabled ? disabledTitle : `Assignee: ${assigneeName}`}
      onClick={onClick}
      className={clsx(
        compact
          ? 'flex h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-sm text-text hover:bg-surface-2'
          : 'inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-text-secondary hover:bg-surface-3',
        open && (compact ? 'bg-surface-2' : 'border-accent'),
        (disabled || saving) && 'cursor-not-allowed opacity-50',
      )}
    >
      {compact ? (
        <>
          <span aria-hidden="true" className="flex shrink-0">
            <Avatar name={assigneeName} size={20} />
          </span>
          <span className="truncate">{saving ? 'Saving…' : assigneeName}</span>
        </>
      ) : (
        <>Assignee · {saving ? 'Saving…' : assigneeName}</>
      )}
    </button>
  );
}
