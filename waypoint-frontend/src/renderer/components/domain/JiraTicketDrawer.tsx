import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { JiraTicketDetail } from '@/components/domain/JiraTicketDetail';
import type { JiraTicket } from '@/types/jira';

/**
 * Right-side "peek" panel for one Jira issue — now a thin shell around
 * `JiraTicketDetail`, exactly as components/domain/TicketDrawer.tsx is a
 * thin shell around TicketDetailContent for this app's native tickets.
 *
 * That symmetry is the point rather than a coincidence: the drawer owns the
 * portal, the backdrop, the slide-in and Escape, and knows nothing about
 * what a Jira issue *is*. Everything about the issue itself — including
 * whether it's being shown docked or full-page — lives in the one component
 * both routes share, so the two views cannot drift apart into two different
 * ideas of what looking at a ticket feels like.
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

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleExpand() {
    // Close first, then navigate — the same order TicketDrawer uses, so the
    // list's own history entry is left clean rather than carrying an open
    // drawer that Back would restore.
    onClose();
    navigate(`/my-jira/${ticket.key}`);
  }

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <div
        // 720px, matching TicketDrawer — the 460px this used to be is what
        // made "Open in Jira" the only comfortable way to read a real
        // thread.
        className="thin-scroll absolute inset-y-0 right-0 flex h-full w-full max-w-[720px] flex-col border-l border-border bg-surface shadow-2xl transition-transform duration-200 ease-out"
        style={{ transform: visible ? 'translateX(0)' : 'translateX(100%)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <JiraTicketDetail
          ticket={ticket}
          variant="drawer"
          onTicketUpdated={onTicketUpdated}
          onClose={onClose}
          onExpand={handleExpand}
        />
      </div>
    </div>,
    document.body,
  );
}
