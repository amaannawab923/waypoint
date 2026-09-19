import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

const STORAGE_KEY = 'waypoint:copilot-panel-width';

export const MIN_PANEL_WIDTH = 360;
export const MAX_PANEL_WIDTH = 900;
export const DEFAULT_PANEL_WIDTH = 400;

function clamp(width: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clamp(parsed) : DEFAULT_PANEL_WIDTH;
  } catch {
    // localStorage can throw in restricted contexts (private browsing, etc.)
    return DEFAULT_PANEL_WIDTH;
  }
}

function writeStoredWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // The resize still works for the current session, it just won't persist.
  }
}

// Module-level, not component state: TicketDrawer.tsx and
// JiraTicketDrawer.tsx dock beside the Copilot panel and shift left by
// exactly its width (see copilotOpenStore.ts for the sibling "is Copilot
// open" store and why a module-level store, not route-scoped context, is
// what a drawer mounted from several different routes can rely on) — they
// need to read the SAME live width CopilotPanel's own drag handle is
// writing, not a value frozen at the old fixed 400px. A drawer that only
// ever read component state private to <CopilotPanel/> would overlap it the
// moment someone actually resized the panel — exactly this bug, filed live:
// "if I open a ticket, it can overlap the Copilot because the Copilot is
// resizable."
let sharedWidth = readStoredWidth();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function setSharedWidth(next: number): void {
  const clamped = clamp(next);
  if (clamped === sharedWidth) return;
  sharedWidth = clamped;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return sharedWidth;
}

/** Live read of the Copilot panel's current width — for anything that only
 * needs to lay out around it (the ticket drawers), not drive the resize
 * itself. Falls back to DEFAULT_PANEL_WIDTH before the store has hydrated
 * from storage, same as useCopilotOpenState's own getSnapshot fallback. */
export function useCopilotPanelWidthState(): number {
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_PANEL_WIDTH,
  );
}

// A second, equally small store for "is a drag in progress right now" — the
// ticket drawers need this too, not just CopilotPanel: they animate their
// own `right` offset with a CSS transition (for the ordinary open/close
// slide), and that same transition would make the offset LAG a few frames
// behind the panel's true width while actively dragging, opening a brief
// visible gap or overlap on every pointermove instead of tracking the
// pointer 1:1. Suspending it for exactly the drag's duration — the same
// thing CopilotPanel already does for its own slide-in transition — keeps
// both edges moving in lockstep.
let resizing = false;
const resizingListeners = new Set<() => void>();

function notifyResizing(): void {
  resizingListeners.forEach((listener) => listener());
}

function setSharedResizing(value: boolean): void {
  if (resizing === value) return;
  resizing = value;
  notifyResizing();
}

function subscribeToResizing(listener: () => void): () => void {
  resizingListeners.add(listener);
  return () => resizingListeners.delete(listener);
}

function getResizingSnapshot(): boolean {
  return resizing;
}

/** Live read of whether the Copilot panel is currently being dragged —
 * see the store comment above for why the ticket drawers need this. */
export function useCopilotPanelResizingState(): boolean {
  return useSyncExternalStore(
    subscribeToResizing,
    getResizingSnapshot,
    () => false,
  );
}

/**
 * The Copilot panel's own width, resizable by dragging a handle on its left
 * edge and persisted across restarts — same localStorage-backed pattern as
 * theme.ts's useTheme. Width tracks the pointer directly during a drag
 * (a plain window pointermove listener, not React state on every tick) and
 * is written to storage once the drag ends, not on every move — a resize is
 * one user intent, not hundreds of ones. Backed by the module-level store
 * above (not local useState) so every other reader of the width — today,
 * just the two ticket drawers via useCopilotPanelWidthState — sees the same
 * live value, not one frozen at whatever it was when they last rendered.
 * `isResizing` stays plain component state: only this one caller
 * (CopilotPanel, to disable its slide transition and highlight the handle
 * while dragging) ever needs it.
 */
export function useCopilotPanelWidth(): {
  width: number;
  isResizing: boolean;
  startResize: (e: ReactPointerEvent) => void;
} {
  const width = useCopilotPanelWidthState();
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const startResize = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      setIsResizing(true);
      setSharedResizing(true);
    },
    [width],
  );

  useEffect(() => {
    if (!isResizing) return undefined;

    function onMove(e: PointerEvent) {
      // The panel is pinned to the right edge, so dragging the left edge
      // further left (a negative delta) must WIDEN the panel — the delta is
      // subtracted, not added.
      const delta = e.clientX - startXRef.current;
      setSharedWidth(startWidthRef.current - delta);
    }
    function onUp() {
      setIsResizing(false);
      setSharedResizing(false);
    }

    // A fast drag otherwise selects the transcript text the pointer sweeps
    // over — the handle itself is only 6px wide and easy to outrun.
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [isResizing]);

  useEffect(() => {
    if (!isResizing) writeStoredWidth(width);
  }, [width, isResizing]);

  return { width, isResizing, startResize };
}
