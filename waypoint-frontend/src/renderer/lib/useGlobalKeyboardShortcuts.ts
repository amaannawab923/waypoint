import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getActiveSelectableView } from '@/lib/useActiveSelectableView';

// The mockup's own key→screen map (docs/design/waypoint-revamp-mockup.html,
// "/* ---------------- keyboard ---------------- */", around line 2272):
// `{ h: 'home', r: 'review', t: 'tickets', m: 'mywork', a: 'alltickets',
// l: 'machine', d: 'docs', s: 'sprints' }`. Those screen names are
// illustrative, not literal routes — this is the translation to this app's
// real router (router.tsx):
//   h -> '/'                              (Home)
//   r -> '/review'                        (Review queue)
//   m -> '/your-work'                     (My work)
//   a -> '/views'                         (workspace-wide All tickets)
//   t -> the OPEN project's ticket list if one is open, else the
//        workspace-wide '/views' — the mockup's own "Tickets" nav item
//        (line 620) is a project-scoped sidebar row, so "no project open"
//        has no literal equivalent; falling back to the workspace list is
//        the closest sensible target rather than a no-op.
//   d -> the open project's Docs tab — no-ops with no project route open,
//        since a workspace-wide docs screen doesn't exist.
//   s -> the open project's Sprints tab — same caveat as `d`.
//   l -> UNBOUND. The mockup's "This machine" (line 1088, "local-first
//        machine strip") is a local-first status/settings screen this app
//        has no equivalent of yet (grep for "machine" in the mockup finds
//        no current-app route it maps to). Left unbound rather than
//        invented.
const GO_TO: Record<string, (projectId: string | undefined) => string | null> =
  {
    h: () => '/',
    r: () => '/review',
    m: () => '/your-work',
    a: () => '/views',
    t: (projectId) => (projectId ? `/projects/${projectId}/tickets` : '/views'),
    d: (projectId) => (projectId ? `/projects/${projectId}/docs` : null),
    s: (projectId) => (projectId ? `/projects/${projectId}/sprints` : null),
  };

// How long a leading `g` stays "pending" for a second key — verbatim from
// the mockup's own `setTimeout(() => { gPending = false; }, 900)`.
const G_PENDING_MS = 900;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    el?.tagName === 'INPUT' ||
    el?.tagName === 'TEXTAREA' ||
    !!el?.isContentEditable
  );
}

/**
 * The app-shell-level keyboard layer (architecture §P5, W5.4): the mockup's
 * full keyboard map minus what already exists elsewhere. Deliberately does
 * NOT touch TicketList.tsx's or ReviewPage.tsx's own local `j`/`k`/`x`/`e`/`r`
 * listeners (W5.2/P4, each scoped to its own component's mount/unmount) or
 * Topbar.tsx's existing ⌘K search-palette binding — this hook owns only the
 * bindings that had nowhere else to live: the Escape cascade, ⌘J, ⌘A,
 * `g`-prefixed navigation, and `?`.
 *
 * Mounted once, at AppShell.tsx (the "Sidebar/Topbar/Outlet" composition
 * root) — see that file for why copilot open/close state is passed in
 * rather than reached for here: it's already lifted there as a sibling of
 * Topbar and CopilotPanel, so this hook receives it as a prop instead of
 * inventing a second place that state lives.
 *
 * ⌘A ("select all, in whatever view is currently active") needs to know
 * which list is on screen without prop-drilling from this app-shell level
 * down into whichever route happens to be rendered — see
 * useActiveSelectableView.ts for the small mount-time registration pattern
 * TicketList.tsx and ReviewPage.tsx each opt into for this.
 *
 * Escape's cascade (architecture §P5's "context-sensitive cascade", ported
 * from the mockup's own priority-ordered `if`/`return` chain) mostly
 * doesn't need new coordination: Modal.tsx (which the new
 * KeyboardShortcutsModal is built on), the local Popover.tsx dropdowns, and
 * TicketDrawer.tsx already each close themselves on Escape via their own
 * effect, independently — that's this codebase's established convention
 * (every dismissable surface owns its own Escape listener), not something
 * this hook should centralize. What it DOES need is to know when one of
 * those already-self-closing surfaces is about to consume this same Escape
 * keypress, so its own fallback (clearing the active view's selection,
 * blurring a focused input) doesn't ALSO fire on the same keystroke — e.g.
 * closing a ticket peek drawer must not simultaneously wipe out an
 * unrelated bulk selection in the list underneath it. Two lightweight,
 * additive signals make that possible without moving any of that
 * close-logic:
 *   - a `[data-ticket-drawer]` marker on TicketDrawer.tsx's root (mount by
 *     definition means "open" — TicketsLayout/AllTicketsPage only render it
 *     while `peek` is set)
 *   - a `[data-copilot-panel]` marker on CopilotPanel.tsx's root, read
 *     alongside the `copilotOpen` prop the same way CopilotPanel's OWN
 *     Escape handler already checks "is focus inside this panel" internally
 * Popovers are deliberately left uncoordinated: they're small, transient,
 * and already correctly self-close — adding a presence registry to the
 * shared Popover.tsx (used broadly) and Topbar.tsx's local AccountMenu for
 * this one rare stacked-with-a-selection edge case wasn't judged worth the
 * extra surface area. See the W5.4 handoff notes for the full reasoning.
 */
export function useGlobalKeyboardShortcuts({
  copilotEnabled,
  copilotOpen,
  onToggleCopilot,
}: {
  copilotEnabled: boolean;
  copilotOpen: boolean;
  onToggleCopilot: () => void;
}): {
  shortcutsOpen: boolean;
  openShortcuts: () => void;
  closeShortcuts: () => void;
} {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId?: string }>();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const gPendingRef = useRef(false);
  const gTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);

  useEffect(() => {
    function clearGPending() {
      gPendingRef.current = false;
      if (gTimeoutRef.current !== null) {
        clearTimeout(gTimeoutRef.current);
        gTimeoutRef.current = null;
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        clearGPending();
        const typing = isTypingTarget(e.target);

        // Tier 1: the shortcuts-help modal. Built on Modal.tsx, which
        // already closes itself on Escape (see that component) — this
        // branch exists only to stop the fallback below from ALSO running
        // on the same keystroke.
        if (shortcutsOpen) return;

        // Tier 2 (ticket detail drawer) and tier 3 (Copilot panel, only
        // when focus is inside it) — see this hook's own doc comment for
        // why these are presence checks rather than owned state.
        if (document.querySelector('[data-ticket-drawer]')) return;
        if (
          copilotOpen &&
          (e.target as HTMLElement | null)?.closest?.('[data-copilot-panel]')
        ) {
          return;
        }

        // Fallback: clear the active view's selection, and/or blur a
        // focused input — NOT mutually exclusive (mirrors the mockup's own
        // `v.clear(); if (typing) e.target.blur();`, both unconditional
        // once the tiers above don't apply).
        getActiveSelectableView()?.clear();
        if (typing) (e.target as HTMLElement).blur();
        return;
      }

      if (isTypingTarget(e.target)) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        if (!copilotEnabled) return;
        e.preventDefault();
        onToggleCopilot();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        const view = getActiveSelectableView();
        if (view) {
          e.preventDefault();
          view.selectAll();
        }
        return;
      }
      // ⌘K (search palette) is Topbar.tsx's own binding — deliberately not
      // duplicated here. Any other modifier combination (including a bare
      // Alt) falls through to nothing, same as the mockup's own
      // `if (e.metaKey || e.ctrlKey || e.altKey) return;` guard ahead of
      // `g` and `?`.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (gPendingRef.current) {
        clearGPending();
        const target = GO_TO[e.key];
        if (target) {
          const path = target(projectId);
          if (path) navigate(path);
        }
        return;
      }
      if (e.key === 'g') {
        gPendingRef.current = true;
        gTimeoutRef.current = setTimeout(() => {
          gPendingRef.current = false;
          gTimeoutRef.current = null;
        }, G_PENDING_MS);
        return;
      }
      if (e.key === '?') {
        setShortcutsOpen((open) => !open);
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      clearGPending();
    };
  }, [
    copilotEnabled,
    copilotOpen,
    navigate,
    onToggleCopilot,
    projectId,
    shortcutsOpen,
  ]);

  return { shortcutsOpen, openShortcuts, closeShortcuts };
}
