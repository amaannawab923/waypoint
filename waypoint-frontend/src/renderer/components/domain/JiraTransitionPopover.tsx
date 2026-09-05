import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import { JiraLoadError } from '@/components/domain/JiraLoadError';
import type { JiraTransition } from '@/types/jira';

const PANEL_WIDTH = 270; // w-[270px]
const PANEL_HEIGHT_ESTIMATE = 260; // corrected on mount, see below
const GAP = 4;
const VIEWPORT_MARGIN = 8;

interface Coords {
  top: number;
  left: number;
}

/**
 * Where the panel's top-left corner goes for a trigger at `triggerRect`.
 * Same shape as DatePicker.tsx's `computeCoords` and for the same reason —
 * prefer below, flip above when there isn't room, then clamp fully inside
 * the viewport on both axes so a trigger near an edge can't push the panel
 * off-screen. Right-aligned to the trigger, which is how this popover has
 * always hung off its state chip.
 */
function computeCoords(triggerRect: DOMRect, panelHeight: number): Coords {
  const spaceBelow = window.innerHeight - triggerRect.bottom;
  const spaceAbove = triggerRect.top;
  const placeUp = spaceBelow < panelHeight + GAP && spaceAbove > spaceBelow;
  const rawTop = placeUp
    ? triggerRect.top - GAP - panelHeight
    : triggerRect.bottom + GAP;
  const top = Math.min(
    Math.max(rawTop, VIEWPORT_MARGIN),
    Math.max(VIEWPORT_MARGIN, window.innerHeight - panelHeight - VIEWPORT_MARGIN),
  );
  const left = Math.min(
    Math.max(triggerRect.right - PANEL_WIDTH, VIEWPORT_MARGIN),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN),
  );
  return { top, left };
}

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
 * Portaled to `document.body` and positioned with real viewport coordinates,
 * exactly as DatePicker.tsx is and for exactly the same reason. This used to
 * be a plain `position: absolute` sibling of the state chip, which put it
 * inside the ticket list's `overflow-hidden` container — so a panel several
 * hundred pixels tall opening downward from a ~44px row was cut off on every
 * row that wasn't near the top of the list, and on the last row it was very
 * nearly invisible. The required-field form, being taller than the option
 * list, failed sooner still. Position is recomputed on open, on any content
 * swap that changes the panel's height, and on scroll/resize, flipping above
 * the chip when there isn't room below.
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
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<Coords | null>(null);

  // Two passes, both inside layout effects so neither is painted: the first
  // places the panel from an estimate (it isn't in the DOM yet), the second
  // corrects against its real height. `formTransition` and the loading/error
  // flags are dependencies because each of them swaps the panel's contents
  // for something of a different height, and a panel that grew downward past
  // the viewport would be exactly the bug this portal exists to fix.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setCoords(computeCoords(trigger.getBoundingClientRect(), PANEL_HEIGHT_ESTIMATE));
  }, [triggerRef]);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    setCoords(computeCoords(trigger.getBoundingClientRect(), panel.offsetHeight));
  }, [triggerRef, formTransition, loading, error, transitions]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      // The chip is no longer an ancestor-sibling of this panel, so without
      // this the chip's own toggle and this click-away would fight: mousedown
      // closed the panel and the following click reopened it.
      if (triggerRef.current?.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onViewportChange() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      setCoords(
        computeCoords(
          trigger.getBoundingClientRect(),
          panelRef.current?.offsetHeight ?? PANEL_HEIGHT_ESTIMATE,
        ),
      );
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [onClose, triggerRef]);

  function pick(transition: JiraTransition) {
    if (transition.requiresFields.length === 0) {
      // Same focus-blur hazard as CopilotProposalCard.tsx's Approve/Reject:
      // onSelect below causes the parent to unmount this popover on the very
      // next render, which would otherwise blur focus to <body>. Land it on
      // this panel's own (about-to-unmount, but not yet) container first.
      panelRef.current?.focus();
      onSelect(transition, {});
      return;
    }
    setFormTransition(transition);
    setFieldValues({});
  }

  function submitForm() {
    if (!formTransition) return;
    panelRef.current?.focus();
    onSelect(formTransition, fieldValues);
  }

  const requiredMissing = formTransition?.requiresFields.some(
    (f) => f.required && !fieldValues[f.key]?.trim(),
  );

  return createPortal(
    <div
      ref={panelRef}
      tabIndex={-1}
      data-shortcut-guard
      onClick={(e) => e.stopPropagation()}
      // z-[60], matching DatePicker.tsx: as a child of <body> this is a
      // sibling of the ticket drawer's z-50 backdrop rather than nested in
      // the row, so the old z-30 would render behind it. Stays under
      // ToastHost's z-[200], which must sit above any popover.
      className="fixed z-[60] w-[270px] overflow-hidden rounded-[var(--radius)] border border-border-strong bg-surface text-left shadow-2xl outline-none"
      // Hidden rather than unmounted for the one frame before the first
      // measurement lands, so the panel is never painted at 0,0.
      style={
        coords
          ? { top: coords.top, left: coords.left }
          : { top: 0, left: 0, visibility: 'hidden' }
      }
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
