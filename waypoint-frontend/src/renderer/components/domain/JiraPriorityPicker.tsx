import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { useFloatingPanel } from '@/components/ui/useFloatingPanel';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import { PriorityIcon } from '@/components/domain/PriorityIcon';
import type { JiraPriorityOption } from '@/types/jira';
import type { Priority } from '@/types/entities';

const PANEL_WIDTH = 230; // w-[230px]
const PANEL_HEIGHT_ESTIMATE = 200; // corrected on mount by the hook

/**
 * Presentational priority menu, anchored under a ticket row's priority chip.
 * A pure picker, exactly like JiraTransitionPopover: it never calls the data
 * layer itself — JiraTicketRow owns the `setJiraTicketPriority` call and the
 * chip's own "saving" state — so its whole job is turning a click into one
 * `onSelect(option)` call and then getting out of the way.
 *
 * The options are the site's own priority names, verbatim, and deliberately
 * not run through the five-bucket `Priority` normalization the chip's icon
 * uses. That enum is a display convenience shared with this app's native
 * tickets; a site running Blocker/Critical/Major, or one that renamed
 * "Highest", would see its own vocabulary replaced with Waypoint's if this
 * menu spoke in buckets. Showing what Jira calls them is also what makes the
 * footer's claim ("Waypoint doesn't invent them") true.
 *
 * Placement, click-away, Escape, and focus all come from `useFloatingPanel` —
 * this is the second picker built on it and the first one written against it
 * rather than retrofitted, which is the point of the hook existing.
 */
export function JiraPriorityPicker({
  ticketKey,
  currentPriorityId,
  options,
  loading,
  error,
  triggerRef,
  onSelect,
  onClose,
}: {
  ticketKey: string;
  /** Marks the option the issue is already on, so the menu shows where you
   * are rather than only where you could go. Null when the issue has no
   * priority set, in which case nothing is marked — which is accurate. */
  currentPriorityId: string | null;
  options: JiraPriorityOption[];
  loading: boolean;
  /** Set when the options read failed. Kept separate from an empty `options`
   * array on purpose: "Jira offers no priorities here" and "we could not ask
   * Jira" are different answers and must not render the same sentence. */
  error: Error | null;
  /** The priority chip this hangs off — the panel is portaled to <body> and
   * cannot find it by DOM position, and it is also what keeps a click on the
   * chip itself from counting as a click-away. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSelect: (option: JiraPriorityOption) => void;
  onClose: () => void;
}) {
  const { panelProps } = useFloatingPanel({
    triggerRef,
    onClose,
    width: PANEL_WIDTH,
    estimatedHeight: PANEL_HEIGHT_ESTIMATE,
    // Right-aligned, matching the transition popover next to it: both hang
    // off small chips near the right edge of a row.
    align: 'right',
    label: `Set ${ticketKey} priority to`,
    // Each of these swaps the panel's contents for something of a different
    // height, so each has to trigger a re-measure.
    remeasureOn: [loading, error, options],
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
      // z-[60], matching the transition popover and DatePicker: as a child of
      // <body> this is a sibling of the ticket drawer's z-50 backdrop rather
      // than nested in the row. Stays under ToastHost's z-[200].
      className="fixed z-[60] w-[230px] overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface text-left shadow-2xl outline-none"
    >
      <div className="px-3 pt-2.5 pb-1.5 text-[10.5px] font-bold tracking-wide text-text-muted uppercase">
        Set {ticketKey} priority
      </div>
      {loading && (
        <div className="px-3 py-3 text-xs text-text-muted">
          Loading priorities…
        </div>
      )}
      {!loading && error && (
        <JiraLoadError
          compact
          what={`${ticketKey}'s priorities`}
          error={error}
        />
      )}
      {/* An issue whose edit screen has no priority field is a real, ordinary
          answer — not every issue type on every site is prioritized — so it
          reads as an absence, the same way the transition popover renders a
          workflow with no legal moves. */}
      {!loading && !error && options.length === 0 && (
        <div className="px-3 py-3 text-xs text-text-muted">
          No priority options here.
        </div>
      )}
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onSelect(option)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-text hover:bg-surface-2"
        >
          {option.name}
          {option.id === currentPriorityId && (
            <span className="ml-auto rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-text-muted uppercase">
              current
            </span>
          )}
        </button>
      ))}
      {/* Suppressed on error, like the transition popover's: this footer
          asserts that what sits above it is your site's real answer, which is
          exactly the claim a failed read cannot back. */}
      {!error && (
        <div className="border-t border-border px-3 py-2.5 text-[10.5px] leading-relaxed text-text-muted">
          These are the priorities{' '}
          <b className="text-text-secondary">your Jira site</b> offers on this
          issue — Waypoint doesn&apos;t invent them.
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * The row's priority glyph, as a button that opens the picker above.
 *
 * Wraps `PriorityIcon` rather than making it a button. PriorityIcon is shared
 * with this app's own native, non-Jira tickets, where there is no picker to
 * open and nothing to write to — turning it into a control would push a
 * Jira-shaped interaction into a component that has no business carrying one.
 * The same reason `JiraStateChip` wraps a status pill instead of teaching the
 * shared status badge about Jira.
 *
 * The accessible name is an `aria-label`, not the `title`, and that is not
 * interchangeable here: the only thing inside this button is a decorative
 * glyph, so `title` was carrying the whole name — and `title` is also where
 * the "why is this disabled" reason goes, which meant the button silently
 * lost its name in exactly the state a screen-reader user most needs it. The
 * label also carries the site's own priority word ("Blocker", "Highest"),
 * which the five-bucket icon cannot show and which appears nowhere else in
 * the row.
 */
export function JiraPriorityChip({
  priority,
  priorityName,
  disabled,
  disabledTitle,
  saving,
  open,
  buttonRef,
  onClick,
}: {
  priority: Priority;
  priorityName: string;
  disabled?: boolean;
  disabledTitle?: string;
  saving?: boolean;
  open?: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled || saving}
      aria-label={`Priority: ${priorityName}`}
      title={disabled ? disabledTitle : `Priority: ${priorityName}`}
      onClick={onClick}
      className={clsx(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-transparent transition-opacity hover:bg-surface-2',
        open && 'border-accent',
        (disabled || saving) && 'cursor-not-allowed opacity-50',
      )}
    >
      {saving ? (
        // A four-character word in a 24px square would clip, so the saving
        // state is an ellipsis. The chip is also disabled while it shows,
        // which is what actually prevents a second write.
        <span className="text-[11px] font-semibold text-text-muted">…</span>
      ) : (
        <PriorityIcon priority={priority} />
      )}
    </button>
  );
}
