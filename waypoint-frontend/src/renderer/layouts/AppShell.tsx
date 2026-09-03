import { useCallback, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from '@/layouts/Sidebar';
import { Topbar } from '@/layouts/Topbar';
import { CopilotPanel } from '@/components/domain/CopilotPanel';
import { KeyboardShortcutsModal } from '@/components/domain/KeyboardShortcutsModal';
import { COPILOT_ENABLED } from '@/lib/featureFlags';
import { useGlobalKeyboardShortcuts } from '@/lib/useGlobalKeyboardShortcuts';

export function AppShell() {
  // Lifted here, not owned by Topbar (which renders the toggle) or
  // CopilotPanel (which is conditionally mounted by it) — the two are
  // siblings under this component, not parent/child.
  const [copilotOpen, setCopilotOpen] = useState(false);
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

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      <Sidebar />
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
