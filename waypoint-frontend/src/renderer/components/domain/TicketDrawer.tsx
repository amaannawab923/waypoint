import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { TicketDetailContent } from '@/pages/tickets/TicketDetailPage';

/**
 * Controlled "peek" panel: slides in from the right edge showing a ticket's
 * full detail without navigating away.
 *
 * MY_JIRA_IMPROVEMENTS.md §5: this used to be a `fixed inset-0` modal (a
 * backdrop covering the whole window, Modal.tsx's own portal/backdrop/
 * ESC-to-close convention borrowed wholesale) — which made the topbar's
 * Copilot toggle physically unreachable while any ticket was open, no matter
 * what z-index anything else carried. De-modalized to the same docked-panel
 * shape components/domain/CopilotPanel.tsx already uses: no backdrop, `top-12`
 * instead of `inset-y-0` so the topbar stays visible and clickable, and
 * Escape only closes this when focus is actually inside it (see panelRef
 * below) rather than firing regardless of where the user's focus is.
 *
 * This component is intentionally dumb — it does not track which item (if any)
 * is peeked; the caller mounts it with a `projectId`/`identifier` pair and
 * unmounts (or swaps) it to change what's shown.
 */
export function TicketDrawer({
  projectId,
  identifier,
  onClose,
}: {
  projectId: string;
  identifier: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  // Mount closed, then flip to open on the next frame so the initial render
  // starts off-screen and the transition actually animates in.
  const [visible, setVisible] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Same guard as CopilotPanel.tsx's own Escape handler: keydown bubbles
      // to `document` regardless of what actually has focus, so without this
      // an Escape meant for some unrelated focused control elsewhere in the
      // document would also close this drawer.
      if (
        panelRef.current &&
        !panelRef.current.contains(document.activeElement)
      )
        return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Restores focus to whatever opened this drawer once it closes — same fix
  // as CopilotPanel.tsx's previousFocusRef. Without it, closing via the
  // header's own × button (TicketDetailContent's close control, whose click
  // handler unmounts this whole drawer) or via Escape above drops focus to
  // <body> with nothing to return it to.
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, []);

  function handleExpand() {
    // Clear the peek param (via replace, while still on the list route)
    // BEFORE navigating away, so the list's history entry is clean. If this
    // ran after navigate(), it would fire against the wrong route and the
    // list entry would keep peek=identifier — back from the full page would
    // land on "list with drawer open" instead of the plain list.
    onClose();
    navigate(`/projects/${projectId}/tickets/${identifier}`);
  }

  return createPortal(
    // data-ticket-drawer: a presence marker, not a style hook — the W5.4
    // global Escape cascade (useGlobalKeyboardShortcuts.ts) checks for this
    // to know a drawer is open (and about to close itself, via this
    // component's own Escape listener above) so its own fallback doesn't
    // ALSO clear an unrelated selection on the same keystroke. No longer the
    // backdrop itself (there is no backdrop) — moved onto the drawer's own
    // root, same as data-copilot-panel lives on CopilotPanel's root.
    <div
      ref={panelRef}
      data-ticket-drawer
      className="thin-scroll fixed top-12 right-0 bottom-0 z-50 flex w-full max-w-[720px] flex-col border-l border-border bg-surface shadow-2xl transition-transform duration-200 ease-out"
      style={{ transform: visible ? 'translateX(0)' : 'translateX(100%)' }}
    >
      <TicketDetailContent
        projectId={projectId}
        identifier={identifier}
        variant="drawer"
        onClose={onClose}
        onExpand={handleExpand}
      />
    </div>,
    document.body,
  );
}
