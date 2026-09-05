import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';

// Everything a portaled floating panel needs to behave, in one place:
// positioning, live repositioning, click-away, Escape, and focus.
//
// This exists because the pattern had already been copy-pasted once —
// DatePicker.tsx into JiraTransitionPopover.tsx — and the copy silently
// dropped a real fix. DatePicker registers Escape in the capture phase and
// calls stopPropagation(), specifically so one Escape press doesn't also
// reach an ancestor drawer's own document-level Escape listener and close
// that too. The popover copy registered a plain bubble listener with no
// stopPropagation(), which is a live bug the moment a panel using it opens
// inside a drawer. A third hand-copy would have inherited the same gap, so
// the fix belongs here, where it is correct by construction for everything
// built on it.
//
// Two things neither hand-written copy had: focus moves into the panel when
// it opens (a keyboard user could not reach the transition popover's options
// at all — Tab skipped the open panel entirely and jumped to the next row),
// and focus returns to the trigger when it closes.
//
// The hook assumes the panel component is mounted only while open — the
// shape both existing callers already have — so "on open" is mount and "on
// close" is unmount.

const GAP = 4;
const VIEWPORT_MARGIN = 8;
const DEFAULT_HEIGHT_ESTIMATE = 260;

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface Coords {
  top: number;
  left: number;
}

/**
 * Where the panel's top-left corner should sit for a trigger at
 * `triggerRect`, given the actual viewport. Prefers opening below the
 * trigger, flipping above when there isn't room below and there's more room
 * above. The result is then clamped fully inside the viewport on both axes —
 * not just picking a side, but pinning the edge — so a trigger that is itself
 * near an edge, or scrolled/resized off-screen while the panel is open, can
 * never push the panel off-screen too.
 *
 * `align` is which of the panel's own edges lines up with the matching edge
 * of the trigger: 'left' hangs it off the trigger's left (DatePicker's
 * behaviour), 'right' pins its right edge to the trigger's right (how the
 * transition popover has always hung off its state chip).
 */
function computeCoords(
  triggerRect: DOMRect,
  panelHeight: number,
  width: number,
  align: 'left' | 'right',
): Coords {
  const spaceBelow = window.innerHeight - triggerRect.bottom;
  const spaceAbove = triggerRect.top;
  const placeUp = spaceBelow < panelHeight + GAP && spaceAbove > spaceBelow;
  const rawTop = placeUp
    ? triggerRect.top - GAP - panelHeight
    : triggerRect.bottom + GAP;
  const top = Math.min(
    Math.max(rawTop, VIEWPORT_MARGIN),
    Math.max(
      VIEWPORT_MARGIN,
      window.innerHeight - panelHeight - VIEWPORT_MARGIN,
    ),
  );
  const rawLeft =
    align === 'right' ? triggerRect.right - width : triggerRect.left;
  const left = Math.min(
    Math.max(rawLeft, VIEWPORT_MARGIN),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
  );
  return { top, left };
}

/** The first thing inside the panel a keyboard user could land on, or null
 * when the panel is pure content (a message, a spinner) — in which case the
 * panel container itself takes focus, which is why it carries tabIndex -1. */
function firstFocusable(panel: HTMLElement): HTMLElement | null {
  return panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
}

export interface FloatingPanelOptions {
  /** The element the panel hangs off, and the one focus returns to. */
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** The panel's rendered width, needed to clamp it inside the viewport. */
  width: number;
  /** Used for the first placement pass, before the panel is measurable. */
  estimatedHeight?: number;
  align?: 'left' | 'right';
  /** The panel's accessible name, e.g. "Move ENG-421 to". */
  label: string;
  /** Content swaps that change the panel's height and so need a re-measure. */
  remeasureOn?: unknown[];
}

export interface FloatingPanelResult {
  panelProps: {
    ref: RefObject<HTMLDivElement | null>;
    tabIndex: -1;
    role: 'dialog';
    'aria-label': string;
    'data-shortcut-guard': true;
    style: CSSProperties;
    onClick: (e: ReactMouseEvent) => void;
  };
  panelRef: RefObject<HTMLDivElement | null>;
}

export function useFloatingPanel({
  triggerRef,
  onClose,
  width,
  estimatedHeight = DEFAULT_HEIGHT_ESTIMATE,
  align = 'left',
  label,
  remeasureOn,
}: FloatingPanelOptions): FloatingPanelResult {
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<Coords | null>(null);

  // Whether focus is (or last was) inside the panel. Consulted on unmount to
  // decide whether returning focus to the trigger is a courtesy or a theft:
  // if the user dismissed the panel by clicking some other control, that
  // control should keep the focus it just earned.
  const focusIsInsideRef = useRef(true);

  // Two passes, both inside layout effects so neither is painted: the first
  // places the panel from an estimate (it isn't measurable yet), the second
  // corrects against its real height. A panel that grew downward past the
  // viewport is exactly the bug portaling it was meant to fix.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setCoords(
      computeCoords(
        trigger.getBoundingClientRect(),
        estimatedHeight,
        width,
        align,
      ),
    );
  }, [triggerRef, estimatedHeight, width, align]);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    setCoords(
      computeCoords(
        trigger.getBoundingClientRect(),
        panel.offsetHeight,
        width,
        align,
      ),
    );
    // `remeasureOn` is spread so a caller's content-swap flags each count as
    // their own dependency; the rule can't see through the spread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerRef, width, align, ...(remeasureOn ?? [])]);

  // Announce the panel on the trigger itself. Set imperatively rather than
  // returned as props to spread, because the trigger is routinely rendered by
  // a different component than the panel (a ticket row owns the state chip;
  // the popover owns only itself) — and returning props no caller could apply
  // would be a promise this hook can't keep. Prior values are restored on
  // close so a trigger that already had its own semantics keeps them.
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return undefined;
    const previousExpanded = trigger.getAttribute('aria-expanded');
    const previousPopup = trigger.getAttribute('aria-haspopup');
    trigger.setAttribute('aria-expanded', 'true');
    // "dialog", not "menu": the options inside are plain buttons reached by
    // Tab, not arrow-key roving-focus menu items, and claiming `menu` would
    // promise a keyboard contract this doesn't implement.
    trigger.setAttribute('aria-haspopup', 'dialog');
    return () => {
      if (previousExpanded === null) trigger.removeAttribute('aria-expanded');
      else trigger.setAttribute('aria-expanded', previousExpanded);
      if (previousPopup === null) trigger.removeAttribute('aria-haspopup');
      else trigger.setAttribute('aria-haspopup', previousPopup);
    };
  }, [triggerRef]);

  // Focus, in a passive effect on purpose: the layout effects above force a
  // synchronous re-render to apply the real coordinates, and until that
  // lands the panel is still `visibility: hidden` — which a real browser
  // refuses to focus. By the time passive effects flush, it is placed and
  // visible.
  useEffect(() => {
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (panel) (firstFocusable(panel) ?? panel).focus();

    return () => {
      if (!focusIsInsideRef.current) return;
      if (!trigger?.isConnected) return;
      // A trigger that has become disabled (a chip mid-save, say) silently
      // refuses focus and it falls to <body> — the same place it landed
      // before this hook existed, so nothing regresses, but it is not
      // something this can promise its way out of.
      trigger.focus();
    };
    // Deliberately mount/unmount only: this is "on open" and "on close".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onFocusIn(e: FocusEvent) {
      focusIsInsideRef.current =
        panelRef.current?.contains(e.target as Node) ?? false;
    }
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      // The trigger is not an ancestor of a portaled panel, so without this
      // the trigger's own toggle and this click-away fight each other:
      // mousedown closes the panel and the following click reopens it.
      if (triggerRef.current?.contains(target)) return;
      // Dismissing by clicking something else is the user choosing where
      // focus goes; don't drag it back to the trigger on the way out.
      focusIsInsideRef.current = false;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // Capture phase plus stopPropagation, not merely closing this panel.
      // An ancestor drawer registers its own bubble-phase Escape listener on
      // `document` that closes the whole drawer; without this, one Escape
      // press closes both, so dismissing a picker takes the user's drawer
      // with it. Capture fires before any bubble-phase listener regardless of
      // registration order, which is what keeps Escape scoped to "close the
      // topmost thing" instead of "close everything".
      e.stopPropagation();
      onClose();
    }
    function onViewportChange() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      setCoords(
        computeCoords(
          trigger.getBoundingClientRect(),
          panelRef.current?.offsetHeight ?? estimatedHeight,
          width,
          align,
        ),
      );
    }
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onViewportChange);
    // Capture, so a scroll inside any scrollable ancestor repositions the
    // panel too — scroll doesn't bubble.
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [onClose, triggerRef, estimatedHeight, width, align]);

  return {
    panelRef,
    panelProps: {
      ref: panelRef,
      tabIndex: -1,
      role: 'dialog',
      'aria-label': label,
      'data-shortcut-guard': true,
      // Hidden rather than unmounted for the one frame before the first
      // measurement lands, so the panel is never painted at 0,0.
      style: coords
        ? { top: coords.top, left: coords.left }
        : { top: 0, left: 0, visibility: 'hidden' },
      onClick: (e: ReactMouseEvent) => e.stopPropagation(),
    },
  };
}
