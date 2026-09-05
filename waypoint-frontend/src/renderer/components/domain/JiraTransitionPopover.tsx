import { useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import { useFloatingPanel } from '@/components/ui/useFloatingPanel';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import type { JiraTransition } from '@/types/jira';

const PANEL_WIDTH = 270; // w-[270px]
const PANEL_HEIGHT_ESTIMATE = 260; // corrected on mount by the hook

/**
 * Presentational transition menu, anchored under a ticket row's state chip.
 * Purely a picker: it never calls the mock API itself — the caller (
 * JiraTicketRow) owns the actual `transitionJiraTicket` call and the row's
 * own "saving" chip state, so this component's only job is turning a click
 * into one `onSelect(transition, fieldValues)` call, then getting out of the
 * way (the caller closes it, whether or not the write ultimately succeeds).
 *
 * A transition with no required fields fires `onSelect` immediately. One
 * that does swaps this SAME panel's content into a small form in place
 * (never a second popover/modal) — a "Cancel" reverts to the option list.
 *
 * Portaled to `document.body` and positioned with real viewport coordinates.
 * This used to be a plain `position: absolute` sibling of the state chip,
 * which put it inside the ticket list's `overflow-hidden` container — so a
 * panel several hundred pixels tall opening downward from a ~44px row was cut
 * off on every row that wasn't near the top of the list, and on the last row
 * it was very nearly invisible. The required-field form, being taller than
 * the option list, failed sooner still.
 *
 * All of the mechanism for that — placement, re-measuring on a content swap,
 * scroll/resize repositioning, click-away, Escape, focus — now lives in
 * `useFloatingPanel`, which is where it belongs: this file used to carry a
 * hand-copied version of DatePicker.tsx's, and the copy had dropped the
 * capture-phase `stopPropagation()` that keeps one Escape press from also
 * closing an ancestor drawer. It also never moved focus into the panel, so a
 * keyboard user could not reach these options at all — Tab skipped the open
 * popover entirely and jumped to the next row.
 */
export function JiraTransitionPopover({
  ticketKey,
  projectKey,
  currentStateName,
  transitions,
  loading,
  error,
  triggerRef,
  onSelect,
  onClose,
}: {
  ticketKey: string;
  projectKey: string;
  currentStateName: string;
  transitions: JiraTransition[];
  loading: boolean;
  /** Set when the transitions read failed. Kept separate from an empty
   * `transitions` array on purpose: "Jira offers no moves from here" and
   * "we could not ask Jira" are different answers and used to render the
   * same sentence. */
  error: Error | null;
  /** The state chip this hangs off. Needed now that the panel is portaled
   * out of the row: it is the only handle on where to draw, and it is also
   * what keeps a click on the chip from counting as a click-away. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSelect: (
    transition: JiraTransition,
    fieldValues: Record<string, string>,
  ) => void;
  onClose: () => void;
}) {
  const [formTransition, setFormTransition] = useState<JiraTransition | null>(
    null,
  );
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  // `formTransition` and the loading/error flags each swap the panel's
  // contents for something of a different height, so each has to trigger a
  // re-measure — a panel that grew downward past the viewport would be
  // exactly the bug portaling it was meant to fix.
  const { panelProps } = useFloatingPanel({
    triggerRef,
    onClose,
    width: PANEL_WIDTH,
    estimatedHeight: PANEL_HEIGHT_ESTIMATE,
    // Right-aligned, which is how this popover has always hung off its chip.
    align: 'right',
    label: `Move ${ticketKey} to`,
    remeasureOn: [formTransition, loading, error, transitions],
  });

  // The `panelRef.current?.focus()` blur guards that used to sit in `pick`
  // and `submitForm` are gone, and deliberately so. They existed for
  // CopilotProposalCard.tsx's hazard — focus falling through to <body> when a
  // control unmounts, where the next keystroke leaks to the global `g`-then-
  // key shortcuts — but they never actually fixed it here: `onSelect` makes
  // the parent unmount this whole popover on the next render, so focus landed
  // on <body> a frame later regardless. The hook's focus-restore is the real
  // answer: on unmount it puts focus back on the state chip the user opened
  // this from, which is both a better destination and an actually durable one.
  function pick(transition: JiraTransition) {
    if (transition.requiresFields.length === 0) {
      onSelect(transition, {});
      return;
    }
    setFormTransition(transition);
    setFieldValues({});
  }

  function submitForm() {
    if (!formTransition) return;
    onSelect(formTransition, fieldValues);
  }

  const requiredMissing = formTransition?.requiresFields.some(
    (f) => f.required && !fieldValues[f.key]?.trim(),
  );

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
      // z-[60], matching DatePicker.tsx: as a child of <body> this is a
      // sibling of the ticket drawer's z-50 backdrop rather than nested in
      // the row, so the old z-30 would render behind it. Stays under
      // ToastHost's z-[200], which must sit above any popover.
      className="fixed z-[60] w-[270px] overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface text-left shadow-2xl outline-none"
    >
      {!formTransition ? (
        <>
          <div className="px-3 pt-2.5 pb-1.5 text-[10.5px] font-bold tracking-wide text-text-muted uppercase">
            Move {ticketKey} to
          </div>
          {loading && (
            <div className="px-3 py-3 text-xs text-text-muted">
              Loading transitions…
            </div>
          )}
          {!loading && error && (
            <JiraLoadError
              compact
              what={`${ticketKey}'s transitions`}
              error={error}
            />
          )}
          {!loading && !error && transitions.length === 0 && (
            <div className="px-3 py-3 text-xs text-text-muted">
              No transitions available from here.
            </div>
          )}
          {transitions.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => pick(t)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-text hover:bg-surface-2"
            >
              <span
                className="size-[7px] shrink-0 rounded-full"
                style={{ background: t.targetStateColor }}
              />
              {t.targetStateName}
              {t.requiresFields.length > 0 && (
                <span className="ml-auto rounded bg-warning-bg px-1.5 py-0.5 text-[10px] font-bold text-warning">
                  needs a field
                </span>
              )}
            </button>
          ))}
          {/* Suppressed on error: this footer asserts that what's above it is
              your workflow's real answer, which is exactly the claim a failed
              read cannot back. */}
          {!error && (
            <div className="border-t border-border px-3 py-2.5 text-[10.5px] leading-relaxed text-text-muted">
              These are the transitions{' '}
              <b className="text-text-secondary">your Jira workflow</b> allows
              from {currentStateName} — Waypoint doesn't invent them.
            </div>
          )}
        </>
      ) : (
        <div className="p-3">
          <h4 className="mb-0.5 text-[12.5px] font-semibold text-text">
            Jira needs one more field
          </h4>
          <p className="mb-2.5 text-[11px] leading-relaxed text-text-muted">
            The{' '}
            <b className="text-text-secondary">
              {formTransition.targetStateName}
            </b>{' '}
            transition on the {projectKey} workflow requires a{' '}
            {formTransition.requiresFields[0]?.label}. Waypoint asks here so the
            move doesn't fail silently in Jira.
          </p>
          {formTransition.requiresFields.map((field) => (
            <div key={field.key} className="mb-2.5">
              <label className="mb-1 block text-[11px] font-bold text-text-secondary">
                {field.label}{' '}
                {field.required && <span className="text-danger">*</span>}
              </label>
              {field.type === 'select' ? (
                <select
                  value={fieldValues[field.key] ?? ''}
                  onChange={(e) =>
                    setFieldValues((v) => ({
                      ...v,
                      [field.key]: e.target.value,
                    }))
                  }
                  className="w-full rounded-[var(--radius-sm)] border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-text outline-none focus:border-accent"
                >
                  <option value="">Select…</option>
                  {(field.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={fieldValues[field.key] ?? ''}
                  onChange={(e) =>
                    setFieldValues((v) => ({
                      ...v,
                      [field.key]: e.target.value,
                    }))
                  }
                  placeholder="e.g. 3h 30m"
                  className="w-full rounded-[var(--radius-sm)] border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-text outline-none focus:border-accent"
                />
              )}
              {field.hint && (
                <div className="mt-1 text-[10.5px] text-text-muted">
                  {field.hint}
                </div>
              )}
            </div>
          ))}
          <div className="mt-1 flex gap-2">
            <Button
              size="xs"
              variant="primary"
              disabled={requiredMissing}
              onClick={submitForm}
            >
              Move to {formTransition.targetStateName}
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                setFormTransition(null);
                setFieldValues({});
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Small pill trigger for a ticket's current state — opens/closes the
 * popover above. Kept here (not in JiraTicketRow) since it's tightly coupled
 * to the popover's own open/saving visual language (the mockup's
 * `.chip-btn`/`.chip-btn.saving`). */
export function JiraStateChip({
  stateName,
  stateColor,
  disabled,
  disabledTitle,
  saving,
  open,
  buttonRef,
  onClick,
}: {
  stateName: string;
  stateColor: string;
  disabled?: boolean;
  disabledTitle?: string;
  saving?: boolean;
  open?: boolean;
  /** Handed to the popover so it knows what to anchor to — the panel is
   * portaled to <body> and can no longer find the chip by DOM position. */
  buttonRef?: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled || saving}
      title={disabled ? disabledTitle : undefined}
      onClick={onClick}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border-strong bg-surface px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-text transition-opacity',
        open && 'border-accent',
        (disabled || saving) && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className="size-[7px] shrink-0 rounded-full"
        style={{ background: stateColor }}
      />
      {saving ? 'Saving…' : stateName}
    </button>
  );
}
