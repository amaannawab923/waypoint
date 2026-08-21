import {
  cloneElement,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactElement,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';

interface AnchorProps {
  ref?: Ref<HTMLElement>;
  onMouseEnter?: (e: MouseEvent) => void;
  onMouseLeave?: (e: MouseEvent) => void;
  onFocus?: (e: FocusEvent) => void;
  onBlur?: (e: FocusEvent) => void;
}

const GAP = 6;
const VIEWPORT_MARGIN = 6;
const SHOW_DELAY_MS = 250;

interface Coords {
  top: number;
  left: number;
  placeBelow: boolean;
}

/** Centered above the anchor by default, flipping below it (and clamping
 * horizontally) when there isn't room — same discipline as DatePicker's
 * popover positioning, just for a much smaller floating element. */
function computeCoords(anchorRect: DOMRect, tooltipWidth: number, tooltipHeight: number): Coords {
  const placeBelow = anchorRect.top - tooltipHeight - GAP < VIEWPORT_MARGIN;
  const top = placeBelow ? anchorRect.bottom + GAP : anchorRect.top - GAP;
  const rawLeft = anchorRect.left + anchorRect.width / 2 - tooltipWidth / 2;
  const left = Math.min(Math.max(rawLeft, VIEWPORT_MARGIN), window.innerWidth - tooltipWidth - VIEWPORT_MARGIN);
  return { top, left, placeBelow };
}

/**
 * Wraps a single focusable/hoverable child (typically an icon-only button)
 * and shows a small floating label on hover/focus — for controls whose
 * meaning isn't obvious from the icon alone. Portaled to `document.body`
 * with `position: fixed` rather than a CSS `absolute` sibling, so it can't
 * get clipped by a scrollable ancestor the way a plain sibling would.
 */
export function Tooltip({ label, children }: { label: string; children: ReactElement<AnchorProps> }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function show() {
    timerRef.current = setTimeout(() => setOpen(true), SHOW_DELAY_MS);
  }

  function hide() {
    clearTimeout(timerRef.current);
    setOpen(false);
  }

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    // First pass with a small estimate (the tooltip isn't in the DOM yet),
    // corrected against its real size once mounted — both before paint, so
    // there's no visible jump between the two.
    setCoords(computeCoords(anchorRef.current.getBoundingClientRect(), 60, 28));
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !tooltipRef.current) return;
    setCoords(
      computeCoords(
        anchorRef.current.getBoundingClientRect(),
        tooltipRef.current.offsetWidth,
        tooltipRef.current.offsetHeight,
      ),
    );
  }, [open, label]);

  const childRef = (children as { ref?: Ref<HTMLElement> }).ref;

  const child = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      if (typeof childRef === 'function') childRef(node);
      else if (childRef && typeof childRef === 'object') (childRef as { current: HTMLElement | null }).current = node;
    },
    onMouseEnter: (e: MouseEvent) => {
      children.props.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e: MouseEvent) => {
      children.props.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: FocusEvent) => {
      children.props.onFocus?.(e);
      show();
    },
    onBlur: (e: FocusEvent) => {
      children.props.onBlur?.(e);
      hide();
    },
  });

  return (
    <>
      {child}
      {open &&
        coords &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            className="pointer-events-none fixed z-[70] -translate-x-0 rounded-[var(--radius-sm)] bg-[var(--text)] px-2 py-1 text-xs font-medium whitespace-nowrap text-[var(--bg)] shadow-lg"
            style={{
              top: coords.top,
              left: coords.left,
              transform: coords.placeBelow ? undefined : 'translateY(-100%)',
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
