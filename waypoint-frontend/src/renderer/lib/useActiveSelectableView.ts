// Minimal module-singleton registry (same "plain module state, no context"
// shape as toast.ts) letting the global keyboard layer's ⌘A binding
// (useGlobalKeyboardShortcuts.ts) reach whichever bulk-selectable list is
// currently on screen, without prop-drilling from AppShell down into
// TicketList/ReviewPage or centralizing their actual selection state.
//
// Exactly two real consumers today — TicketList.tsx (project/workspace/
// sparse ticket lists) and ReviewPage.tsx (the proposal queue) — each
// registers its own `selectAll`/`clear` pair on mount and unregisters on
// unmount. React Router only ever mounts one of them at a time (this is a
// single-page-at-a-time layout, not a multi-pane one), so "last registered
// wins" is equivalent to "the one currently on screen" — no need for a
// stack or a keyed registry to support that.
//
// Read imperatively from a keydown handler, not rendered, so this is plain
// module state rather than React context — nothing here needs to trigger a
// re-render when the active view changes.
export interface SelectableView {
  /** Select every currently visible row/proposal — mirrors the mockup's
   * own "Select all visible" (not "select every row matching the filter,
   * including ones scrolled/paginated out of view"). */
  selectAll: () => void;
  /** Clear the current selection. Safe to call even when nothing is
   * selected. */
  clear: () => void;
}

let activeView: SelectableView | null = null;

/** Call on mount with a stable-identity `view` (wrap in useCallback/useMemo
 * so this doesn't re-register on every render); call the returned function
 * on unmount. */
export function registerActiveSelectableView(view: SelectableView): () => void {
  activeView = view;
  return () => {
    // Only clear if this registration is still the current one — an
    // out-of-order unmount (e.g. StrictMode's mount/unmount/mount in dev)
    // must not let a stale cleanup wipe out a newer, still-mounted view's
    // registration.
    if (activeView === view) activeView = null;
  };
}

export function getActiveSelectableView(): SelectableView | null {
  return activeView;
}

/** Test-only: reset between tests so one test's registration can't leak
 * into the next. */
export function __resetActiveSelectableViewForTests(): void {
  activeView = null;
}
