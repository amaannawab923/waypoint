import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { RAIL_WIDTH_PX, Sidebar, SIDEBAR_WIDTH_PX } from '@/layouts/Sidebar';
import { Topbar } from '@/layouts/Topbar';
import { CopilotPanel } from '@/components/domain/CopilotPanel';
import { KeyboardShortcutsModal } from '@/components/domain/KeyboardShortcutsModal';
import { COPILOT_ENABLED, SESSIONS_ENABLED } from '@/lib/featureFlags';
import { setCopilotOpenState } from '@/lib/copilotOpenStore';
import { onRunFocus } from '@/data/engineApi';
import { useGlobalKeyboardShortcuts } from '@/lib/useGlobalKeyboardShortcuts';

// ROAD-159 (docs/design/shell-ux-v3.md): the sidebar is always the same
// 56px rail. Pinning it open — one global on/off switch, not a per-page
// behavior — is the only thing that ever makes it wider, and it stays that
// width everywhere until switched back. This replaces the former
// isFocusWorkspace()-gated fold (only /sessions ever showed the rail); the
// rule above has no route in it anywhere, on purpose — see that doc for
// why a route-conditional version of this was deleted rather than
// generalized.
const PINNED_KEY = 'waypoint:sidebarPinned';

export function readSidebarPinned(): boolean {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    // No stored preference yet: default to pinned (the 256px panel),
    // matching what every route other than /sessions already looked like
    // before this rewrite (shell-ux-v3.md §2.5) — first run and every
    // existing user land on the shell they already know. Only an explicit
    // 'false' (someone unpinned it, on whichever route they did that on)
    // collapses to the rail by default from here on.
    if (raw === null) return true;
    return raw === 'true';
  } catch {
    return true;
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

  // ROAD-159: the sidebar's one piece of state — pinned open (the 256px
  // panel) or not (the 56px rail). Global, remembered per device
  // (waypoint:sidebarPinned), and never read from useLocation(): the route
  // this shell hosts has nothing to do with the sidebar's width.
  const [pinned, setPinned] = useState(readSidebarPinned);
  const [peeking, setPeeking] = useState(false);
  const peekLinger = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      writeSidebarPinned(next);
      return next;
    });
    setPeeking(false);
  }, []);

  // W5.4: the app-shell-level keyboard layer (Escape cascade, ⌘J, ⌘A, ⌘B,
  // `g`-prefixed navigation, `?`) — mounted once here, the same
  // composition root that already owns copilotOpen/toggleCopilot and the
  // sidebar's pin, rather than a second place that state gets threaded
  // through or a bare window.addEventListener for ⌘B specifically. See
  // useGlobalKeyboardShortcuts.ts for what it deliberately leaves alone
  // (Topbar's ⌘K, TicketList's/ReviewPage's own local j/k/x/e/r).
  const { shortcutsOpen, openShortcuts, closeShortcuts } =
    useGlobalKeyboardShortcuts({
      copilotEnabled: COPILOT_ENABLED,
      copilotOpen,
      onToggleCopilot: toggleCopilot,
      onToggleSidebarPin: togglePin,
    });

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
      {/* The 150 ms width tween of docs/design/w3-sessions-rail.md §1.10,
          carried over unchanged: the column animates between the rail's
          56 px and the sidebar's 256 px while its content swaps at once;
          instant under prefers-reduced-motion. */}
      <div
        data-sidebar-column
        className="h-full shrink-0 overflow-hidden transition-[width] duration-150 ease-out motion-reduce:transition-none"
        style={{ width: pinned ? SIDEBAR_WIDTH_PX : RAIL_WIDTH_PX }}
      >
        <Sidebar
          pinned={pinned}
          onPeek={() => {
            cancelLinger();
            setPeeking(true);
          }}
          onPeekEnd={endPeekSoon}
          onTogglePin={togglePin}
          peeking={peeking}
        />
      </div>
      {!pinned && peeking && (
        <div
          data-sidebar-peek
          className="absolute inset-y-0 left-14 z-40 shadow-2xl"
          style={{ width: SIDEBAR_WIDTH_PX }}
          onMouseEnter={cancelLinger}
          onMouseLeave={() => setPeeking(false)}
        >
          {/* A second mount of the same component, forced to the panel
              (§6 of the write-up) — its own collapse control only closes
              the peek, it doesn't touch the real pin, matching the pin
              affordance's hover-to-peek/click-to-pin split above it. */}
          <Sidebar pinned onTogglePin={() => setPeeking(false)} />
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
