import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from '@/layouts/Sidebar';
import { RAIL_WIDTH_PX, SidebarRail } from '@/layouts/SidebarRail';
import { useLocalSummary } from '@/lib/useLocalSummary';
import { Topbar } from '@/layouts/Topbar';
import { CopilotPanel } from '@/components/domain/CopilotPanel';
import { KeyboardShortcutsModal } from '@/components/domain/KeyboardShortcutsModal';
import { COPILOT_ENABLED, SESSIONS_ENABLED } from '@/lib/featureFlags';
import { setCopilotOpenState } from '@/lib/copilotOpenStore';
import { onRunFocus } from '@/data/engineApi';
import { useGlobalKeyboardShortcuts } from '@/lib/useGlobalKeyboardShortcuts';

/**
 * A focus workspace is a route family where the full sidebar folds to the
 * icon rail (SidebarRail.tsx) — W3's My sessions today
 * (docs/design/w3-sessions-rail.md §1.2). Judged from the pathname alone
 * so this layout needs nothing from the page it hosts.
 */
export function isFocusWorkspace(pathname: string): boolean {
  return SESSIONS_ENABLED && /^\/sessions(\/|$)/.test(pathname);
}

// The one remembered preference: a sidebar the user pinned open inside a
// focus workspace stays open on the next visit (per device). The automatic
// collapse itself is not a preference — it is what "focus workspace" means.
const PINNED_KEY = 'waypoint:sidebarPinned';

export function readSidebarPinned(): boolean {
  try {
    return localStorage.getItem(PINNED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeSidebarPinned(pinned: boolean): void {
  try {
    localStorage.setItem(PINNED_KEY, pinned ? 'true' : 'false');
  } catch {
    // Best effort — the session still behaves, it just forgets.
  }
}

/** The peek overlay lingers this long after the pointer leaves the affordance, so the hand can reach it. */
const PEEK_LINGER_MS = 300;
/** Sidebar.tsx's `w-64`. */
const SIDEBAR_WIDTH_PX = 256;

export function AppShell() {
  // Lifted here, not owned by Topbar (which renders the toggle) or
  // CopilotPanel (which is conditionally mounted by it) — the two are
  // siblings under this component, not parent/child.
  const [copilotOpen, setCopilotOpen] = useState(false);

  // Mirrored into lib/copilotOpenStore.ts so ticket drawers — mounted several
  // route levels away, sometimes under ProjectLayout's own nested <Outlet>
  // context — can lay out around Copilot without AppShell threading this
  // value down through every intermediate route. See that module's own
  // comment for why useOutletContext doesn't reach far enough here. Gated by
  // COPILOT_ENABLED too, matching the condition <CopilotPanel/> itself is
  // mounted under below — the store should say whether Copilot is actually
  // on screen, not just whether the (possibly unreachable) toggle was
  // flipped.
  useEffect(() => {
    setCopilotOpenState(COPILOT_ENABLED && copilotOpen);
  }, [copilotOpen]);
  const toggleCopilot = useCallback(() => setCopilotOpen((v) => !v), []);
  // Stable identity, not an inline arrow — CopilotPanel's Escape-key
  // listener effect depends on this closure, and a fresh function every
  // AppShell render would tear down and re-add that listener on every
  // render for no reason.
  const closeCopilot = useCallback(() => setCopilotOpen(false), []);

  // W5.4: the app-shell-level keyboard layer (Escape cascade, ⌘J, ⌘A,
  // `g`-prefixed navigation, `?`) — mounted once here, the same
  // composition root that already owns copilotOpen/toggleCopilot, rather
  // than a second place that state gets threaded through. See
  // useGlobalKeyboardShortcuts.ts for what it deliberately leaves alone
  // (Topbar's ⌘K, TicketList's/ReviewPage's own local j/k/x/e/r).
  const { shortcutsOpen, openShortcuts, closeShortcuts } =
    useGlobalKeyboardShortcuts({
      copilotEnabled: COPILOT_ENABLED,
      copilotOpen,
      onToggleCopilot: toggleCopilot,
    });

  // W3: the sidebar folds to the rail inside a focus workspace, unless the
  // user pinned it open. The peek overlay is transient hover state.
  const { pathname } = useLocation();
  const focusWorkspace = isFocusWorkspace(pathname);
  const [pinned, setPinned] = useState(readSidebarPinned);
  const [peeking, setPeeking] = useState(false);
  const peekLinger = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const localSummary = useLocalSummary();
  const showRail = focusWorkspace && !pinned;

  const setPin = useCallback((next: boolean) => {
    setPinned(next);
    writeSidebarPinned(next);
    setPeeking(false);
  }, []);

  useEffect(() => {
    if (!focusWorkspace) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'b'
      ) {
        e.preventDefault();
        setPin(!readSidebarPinned());
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusWorkspace, setPin]);

  // W5a: a notification about a run was clicked (main/engine/notifications.ts);
  // main brought the window forward, the shell opens the run.
  const navigate = useNavigate();
  useEffect(() => {
    if (!SESSIONS_ENABLED) return undefined;
    return onRunFocus(({ runId }) => {
      if (typeof runId === 'string' && runId)
        navigate(`/sessions/${encodeURIComponent(runId)}`);
    });
  }, [navigate]);

  // Leaving the workspace ends any peek; the pin itself is remembered.
  useEffect(() => {
    if (!showRail) setPeeking(false);
  }, [showRail]);
  useEffect(
    () => () => {
      if (peekLinger.current) clearTimeout(peekLinger.current);
    },
    [],
  );

  const cancelLinger = () => {
    if (peekLinger.current) clearTimeout(peekLinger.current);
    peekLinger.current = undefined;
  };
  const endPeekSoon = () => {
    cancelLinger();
    peekLinger.current = setTimeout(() => setPeeking(false), PEEK_LINGER_MS);
  };

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-bg text-text">
      {/* The 150 ms width tween of docs/design/w3-sessions-rail.md §1.10:
          the column animates between the rail's 56 px and the sidebar's
          256 px while its content swaps at once; instant under
          prefers-reduced-motion. */}
      <div
        data-sidebar-column
        className="h-full shrink-0 overflow-hidden transition-[width] duration-150 ease-out motion-reduce:transition-none"
        style={{ width: showRail ? RAIL_WIDTH_PX : SIDEBAR_WIDTH_PX }}
      >
        {showRail ? (
          <SidebarRail
            onPeek={() => {
              cancelLinger();
              setPeeking(true);
            }}
            onPeekEnd={endPeekSoon}
            onPin={() => setPin(true)}
            localSummary={localSummary.sentence}
            peeking={peeking}
          />
        ) : (
          <Sidebar
            onCollapse={focusWorkspace ? () => setPin(false) : undefined}
          />
        )}
      </div>
      {showRail && peeking && (
        <div
          data-sidebar-peek
          className="absolute inset-y-0 left-14 z-40 shadow-2xl"
          onMouseEnter={cancelLinger}
          onMouseLeave={() => setPeeking(false)}
        >
          <Sidebar onCollapse={() => setPeeking(false)} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          copilotEnabled={COPILOT_ENABLED}
          copilotOpen={copilotOpen}
          onToggleCopilot={toggleCopilot}
          onOpenShortcuts={openShortcuts}
        />
        <main className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      {COPILOT_ENABLED && copilotOpen && (
        <CopilotPanel onClose={closeCopilot} />
      )}
      <KeyboardShortcutsModal open={shortcutsOpen} onClose={closeShortcuts} />
    </div>
  );
}
