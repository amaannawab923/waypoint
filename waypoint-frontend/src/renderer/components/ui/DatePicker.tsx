import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { Calendar, ChevronLeft } from 'lucide-react';
import { IconChevronRight } from '@/components/icons';
import { IconButton } from './Button';

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const PANEL_WIDTH = 256; // w-64
const PANEL_HEIGHT_ESTIMATE = 320; // corrected against the real panel on mount, see below
const GAP = 4;
const VIEWPORT_MARGIN = 8;

// A 'yyyy-MM-dd'-only string is ambiguous between UTC and local time —
// `new Date(value)` parses it as UTC midnight, which lands on the wrong
// calendar day for anyone west of UTC. `parseISO`/`format` both resolve
// date-only strings against local time instead, so a value picked here
// round-trips through the app's `?.slice(0, 10)`-based ISO strings without
// drifting a day.
function toIsoDate(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

interface Coords {
  top: number;
  left: number;
}

/**
 * Where the panel's top-left corner should sit for a trigger at
 * `triggerRect`, given the actual viewport. Prefers opening below the
 * trigger, flipping above it when there isn't room below (and there's more
 * room above). The result is then clamped fully inside the viewport on both
 * axes — not just picking a side, but pinning the edge — so a trigger that's
 * itself scrolled or resized off-screen (e.g. the window shrinks while the
 * panel is open) can never push the panel off-screen too.
 */
function computeCoords(triggerRect: DOMRect, panelHeight: number): Coords {
  const spaceBelow = window.innerHeight - triggerRect.bottom;
  const spaceAbove = triggerRect.top;
  const placeUp = spaceBelow < panelHeight + GAP && spaceAbove > spaceBelow;
  const rawTop = placeUp ? triggerRect.top - GAP - panelHeight : triggerRect.bottom + GAP;
  const top = Math.min(
    Math.max(rawTop, VIEWPORT_MARGIN),
    window.innerHeight - panelHeight - VIEWPORT_MARGIN,
  );
  const left = Math.min(
    Math.max(triggerRect.left, VIEWPORT_MARGIN),
    window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN,
  );
  return { top, left };
}

/**
 * A small popover month calendar, replacing the browser's native
 * `<input type="date">` — whose picker affordance is invisible under a
 * dark-mode OS/browser preference (see TicketDetailPage.tsx) and whose
 * look otherwise can't be styled to match the rest of the app.
 *
 * The panel is portaled to `document.body` and positioned with real
 * viewport coordinates (`position: fixed`) rather than rendered as a plain
 * `absolute` sibling of the trigger. A sibling gets silently clipped by any
 * scrollable ancestor — e.g. the ticket drawer's own `overflow-y-auto`
 * content column — even when there's plenty of room in the actual browser
 * window. Position is recomputed every time the panel opens, flipping above
 * the trigger when there isn't room below (and vice versa), and clamping
 * horizontally so it never runs off either edge.
 */
export function DatePicker({
  value,
  onChange,
  placeholder = 'Set date',
  className,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selected = value ? parseISO(value) : null;
  const [cursor, setCursor] = useState(() => selected ?? new Date());
  const [coords, setCoords] = useState<Coords | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    setCursor(selected ?? new Date());
    const triggerRect = triggerRef.current.getBoundingClientRect();
    // First pass with an estimate (the panel isn't in the DOM yet), then a
    // second pass once it's actually mounted corrects for its real height —
    // both happen inside layout effects, before the browser paints, so
    // there's no visible flicker between the two.
    setCoords(computeCoords(triggerRect, PANEL_HEIGHT_ESTIMATE));
    // Only re-sync when the popover opens, not on every keystroke-driven
    // `value` change elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !panelRef.current) return;
    setCoords(computeCoords(triggerRef.current.getBoundingClientRect(), panelRef.current.offsetHeight));
  }, [open, cursor]);

  useLayoutEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // Capture phase + stopPropagation, not just closing the picker: the
      // ticket drawer (TicketDrawer.tsx) has its own bubble-phase
      // Escape listener on `document` that closes the whole drawer. Without
      // this, one Escape press while the picker is open closed both —
      // dismissing the calendar took the user's whole drawer with it.
      // Capture fires before that bubble-phase listener regardless of which
      // was registered first, so stopping it here reliably keeps Escape
      // scoped to "close the topmost thing" instead of "close everything".
      e.stopPropagation();
      setOpen(false);
    }
    function onViewportChange() {
      if (triggerRef.current) setCoords(computeCoords(triggerRef.current.getBoundingClientRect(), panelRef.current?.offsetHeight ?? PANEL_HEIGHT_ESTIMATE));
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open]);

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor));
    const end = endOfWeek(endOfMonth(cursor));
    return eachDayOfInterval({ start, end });
  }, [cursor]);

  function pick(day: Date) {
    onChange(toIsoDate(day));
    setOpen(false);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'flex h-8 w-full items-center gap-1.5 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2 text-left text-sm outline-none focus:border-accent',
          selected ? 'text-text' : 'text-text-muted',
          className,
        )}
      >
        <Calendar size={13} className="shrink-0 text-text-muted" />
        <span className="truncate">{selected ? format(selected, 'MMM d, yyyy') : placeholder}</span>
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            // Portaled to <body>, so this sits as a sibling of things like
            // the ticket drawer's own z-50 backdrop (TicketDrawer.tsx)
            // rather than nested inside it — z-30 would render invisibly
            // *behind* that backdrop there. z-[60] clears every modal/drawer
            // backdrop (z-50) while staying below ToastHost's z-[200], which
            // must stay on top of any popover.
            className="fixed z-[60] w-64 rounded-[var(--radius)] border border-border bg-surface p-3 shadow-lg"
            style={{ left: coords.left, top: coords.top }}
          >
            <div className="flex items-center justify-between pb-2">
              <IconButton label="Previous month" onClick={() => setCursor((c) => subMonths(c, 1))}>
                <ChevronLeft size={14} />
              </IconButton>
              <span className="text-sm font-medium text-text">{format(cursor, 'MMMM yyyy')}</span>
              <IconButton label="Next month" onClick={() => setCursor((c) => addMonths(c, 1))}>
                <IconChevronRight size={14} />
              </IconButton>
            </div>
            <div className="grid grid-cols-7 gap-y-1 text-center">
              {WEEKDAY_LABELS.map((label, i) => (
                <span key={`${label}-${i}`} className="text-[11px] font-medium text-text-muted">
                  {label}
                </span>
              ))}
              {days.map((day) => {
                const inMonth = isSameMonth(day, cursor);
                const daySelected = selected !== null && isSameDay(day, selected);
                const dayIsToday = isToday(day);
                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    onClick={() => pick(day)}
                    className={clsx(
                      'mx-auto flex size-7 items-center justify-center rounded-full text-xs transition-colors',
                      !inMonth && 'text-text-muted/50 hover:bg-surface-2',
                      inMonth && !daySelected && 'text-text hover:bg-surface-2',
                      daySelected && 'bg-accent text-on-accent',
                      !daySelected && dayIsToday && 'font-semibold text-accent',
                    )}
                  >
                    {format(day, 'd')}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
              <button
                type="button"
                onClick={() => pick(new Date())}
                className="cursor-pointer text-xs text-text-secondary hover:text-text"
              >
                Today
              </button>
              {selected && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="cursor-pointer text-xs text-danger hover:text-danger"
                >
                  Clear
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
