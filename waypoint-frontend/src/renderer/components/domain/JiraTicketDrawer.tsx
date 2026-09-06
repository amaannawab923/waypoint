import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { JiraTicketDetail } from '@/components/domain/JiraTicketDetail';
import { useCopilotOpenState } from '@/lib/copilotOpenStore';
import type { JiraTicket } from '@/types/jira';

/**
 * Right-side "peek" panel for one Jira issue — now a thin shell around
 * `JiraTicketDetail`, exactly as components/domain/TicketDrawer.tsx is a
 * thin shell around TicketDetailContent for this app's native tickets.
 *
 * That symmetry is the point rather than a coincidence: the drawer owns the
 * portal, the slide-in, and Escape, and knows nothing about what a Jira
 * issue *is*. Everything about the issue itself — including whether it's
 * being shown docked or full-page — lives in the one component both routes
 * share, so the two views cannot drift apart into two different ideas of
 * what looking at a ticket feels like.
 *
 * MY_JIRA_IMPROVEMENTS.md §5: no longer a `fixed inset-0` backdrop — that
 * made the topbar's Copilot toggle physically unreachable while this was
 * open, the same defect TicketDrawer.tsx had (confirmed byte-identical), so
 * both were fixed together rather than just this one. De-modalized to
 * CopilotPanel.tsx's own docked-panel shape: no backdrop, `top-12` so the
 * topbar stays visible, and a focus-gated Escape (see panelRef below)
 * instead of one that fires no matter where focus actually is.
 *
 * Expanding navigates to /my-jira/:key rather than widening this panel. A
 * 460px column stretched to 1700px is not the same thing as a page: the
 * native ticket answers this by leaving the drawer for its own route, and
 * so does this.
 */
export function JiraTicketDrawer({
  ticket,
  onTicketUpdated,
  onClose,
}: {
  ticket: JiraTicket;
  /**
   * Hands a re-read ticket back up to whoever owns the list behind this
   * drawer. Without it a reassign made here would update nothing but the
   * drawer's own header, and closing it would reveal a row still naming the
   * previous assignee — a stale row the user has no reason to distrust.
   */
  onTicketUpdated: (updated: JiraTicket) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  // Mount closed, then flip to open on the next frame so the initial render
  // starts off-screen and the transition actually animates in.
  const [visible, setVisible] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Docked beside Copilot rather than under it once Copilot is open — same
  // side-by-side layout TicketDrawer.tsx now supports for native tickets;
  // see lib/copilotOpenStore.ts for why this reads a module-level store
  // instead of route-scoped context.
  const copilotOpen = useCopilotOpenState();

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Same guard as CopilotPanel.tsx's own Escape handler: keydown bubbles
      // to `document` regardless of what actually has focus, so without this
      // an Escape meant for some unrelated focused control (e.g. the
      // mention popover in JiraCommentComposer, which already stops its own
      // Escape from reaching here) would also close this drawer.
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
  // as CopilotPanel.tsx's previousFocusRef. Without it, closing via
  // JiraTicketDetail's own × button or via Escape above drops focus to
  // <body> with nothing to return it to.
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, []);

  function handleExpand() {
    // Close first, then navigate — the same order TicketDrawer uses, so the
    // list's own history entry is left clean rather than carrying an open
    // drawer that Back would restore.
    onClose();
    navigate(`/my-jira/${ticket.key}`);
  }

  return createPortal(
    // data-ticket-drawer: same presence marker TicketDrawer.tsx's root
    // carries, read by the W5.4 global Escape cascade
    // (useGlobalKeyboardShortcuts.ts) to know a drawer is open and about to
    // close itself (via this component's own Escape listener above) so its
    // own fallback doesn't ALSO clear an unrelated selection on the same
    // keystroke. Previously absent here — this drawer's Escape handling used
    // to be an unconditional `onClose()` with nothing else on screen to
    // coordinate with; now that it's focus-gated the same way
    // CopilotPanel.tsx's is, the same double-fire this marker prevents for
    // TicketDrawer.tsx was possible here too, so it's added for the same
    // reason rather than left asymmetric.
    <div
      ref={panelRef}
      data-ticket-drawer
      className={clsx(
        // 720px, matching TicketDrawer — the 460px this used to be is what
        // made "Open in Jira" the only comfortable way to read a real thread.
        //
        // shadow-2xl (Tailwind's default, unblurred rect ± its own edges) is
        // symmetric, so with this drawer stacked above Copilot (z-50 vs
        // z-40) its own drop shadow painted a visible gray gradient across
        // Copilot's left edge whenever both were docked side by side —
        // Copilot wasn't a different white, it was being shadowed by the
        // drawer sitting on top of it. A negative x-offset keeps the same
        // depth cue toward the main content on the left, the only side this
        // panel actually floats over, without ever reaching past its own
        // right edge onto whatever's docked next to it.
        'thin-scroll fixed top-12 bottom-0 z-50 flex w-full max-w-[720px] flex-col border-l border-border bg-surface shadow-[-20px_25px_50px_-12px_rgba(0,0,0,0.25)] transition-[right,transform] duration-200 ease-out',
        // Shifted left by Copilot's own width while it's open, so the two
        // dock side by side instead of one covering the other — see
        // lib/copilotOpenStore.ts.
        copilotOpen ? 'right-[400px]' : 'right-0',
      )}
      style={{ transform: visible ? 'translateX(0)' : 'translateX(100%)' }}
    >
      <JiraTicketDetail
        ticket={ticket}
        variant="drawer"
        onTicketUpdated={onTicketUpdated}
        onClose={onClose}
        onExpand={handleExpand}
      />
    </div>,
    document.body,
  );
}
