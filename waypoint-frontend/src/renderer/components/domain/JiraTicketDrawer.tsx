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
        'thin-scroll fixed top-12 bottom-0 z-50 flex w-full max-w-[720px] flex-col border-l border-border bg-surface transition-[right,transform] duration-200 ease-out',
        // Shifted left by Copilot's own width while it's open, so the two
        // dock side by side instead of one covering the other — see
        // lib/copilotOpenStore.ts.
        copilotOpen ? 'right-[400px]' : 'right-0',
        // shadow-2xl belongs only to the "floating over the main content
        // list" state. A negative x-offset was tried first to keep it while
        // aiming the blur away from Copilot, but box-shadow's blur has no
        // hard edge — any offset small enough to still read as a shadow
        // still left a soft, real (measured via pixel sampling, not
        // eyeballed) gray tail 60-90px into Copilot's white, because this
        // drawer sits above it in stacking order (z-50 vs z-40) and paints
        // on top of it. Once Copilot is docked beside it, this drawer isn't
        // floating over anything on its right — it's a peer panel with its
        // own `border-l` divider, which is already the correct affordance
        // for "these are two separate surfaces." No shadow there means no
        // amount of blur tuning can ever bleed onto a docked neighbor again.
        copilotOpen ? 'shadow-none' : 'shadow-2xl',
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
