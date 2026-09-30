import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { CheckCheck, Maximize2 } from 'lucide-react';
import { IconX } from '@/components/icons';
import { IconButton } from '@/components/ui/Button';
import { NotWired } from '@/components/ui/NotWired';
import { useCopilotOpenState } from '@/lib/copilotOpenStore';
import { useCopilotPanelResizingState, useCopilotPanelWidthState } from '@/lib/useCopilotPanelWidth';
import type { NotificationItem, NotificationTab } from '@/types/entities';
import { NotificationList } from './NotificationList';
import { NotificationTabs } from './NotificationTabs';
import { useNotificationFeed } from './useNotificationFeed';
import { openNotificationTarget } from './openNotification';
import { readRememberedTab, rememberTab } from './rememberedTab';

export const NOTIFICATIONS_PANE_WIDTH = 440;

/**
 * The bell's side pane: slides in from the right edge under the topbar, the
 * same docked shape as TicketDrawer (no backdrop, docks beside Copilot
 * rather than under it). "Open full page" expands it to /notifications.
 *
 * Closes on Escape (while focus is inside), on a left click anywhere outside
 * it other than the bell (the bell toggles it), on ⌘K (the search palette
 * opens over where the pane was), and after opening a row.
 *
 * Mounted from its first open onward and only slid out of view when closed,
 * so reopening keeps the loaded pages, the tab and the scroll position
 * instead of starting from a skeleton. Closed, it is `inert`: nothing in it
 * can be focused, clicked or read out.
 */
export function NotificationsPane({
  open,
  onClose,
  bellId,
}: {
  open: boolean;
  onClose: () => void;
  bellId: string;
}) {
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [tab, setTab] = useState<NotificationTab>(() => readRememberedTab());
  const feed = useNotificationFeed(tab);
  const copilotOpen = useCopilotOpenState();
  const copilotWidth = useCopilotPanelWidthState();
  const copilotResizing = useCopilotPanelResizingState();

  // Slide in on the frame after opening, so the transition runs from the
  // off-screen position instead of appearing in place.
  useEffect(() => {
    if (!open) {
      setVisible(false);
      return undefined;
    }
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Focus moves into the pane on open (so Escape and Tab work from the
  // start) and returns to the bell on close. The pane itself takes focus,
  // not a tab, so opening it with the mouse doesn't paint a ring on "All".
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      const previous = previousFocusRef.current;
      // A pointer click doesn't always focus the bell (it depends on the
      // platform), so "nothing" falls back to the bell rather than <body>.
      const target =
        previous && previous !== document.body && previous.isConnected
          ? previous
          : document.getElementById(bellId);
      target?.focus?.();
    };
  }, [open, bellId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      // ⌘K opens the search palette over this spot; let it, and get out of the way.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        onClose();
        return;
      }
      if (e.key !== 'Escape') return;
      // Same guard as TicketDrawer/CopilotPanel: only an Escape meant for
      // this pane closes it.
      if (panelRef.current && !panelRef.current.contains(document.activeElement)) return;
      e.stopPropagation();
      onClose();
    };
    // Capture phase, so a ticket drawer underneath doesn't also close.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: PointerEvent) => {
      if (e.button > 0) return; // a right- or middle-click elsewhere isn't "leave"
      const target = e.target as Node | null;
      if (!target || panelRef.current?.contains(target)) return;
      if (document.getElementById(bellId)?.contains(target)) return; // the bell toggles
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, onClose, bellId]);

  function changeTab(next: NotificationTab) {
    setTab(next);
    rememberTab(next);
  }

  async function openRow(n: NotificationItem) {
    void feed.setRead(n, true);
    onClose();
    await openNotificationTarget(n, navigate);
  }

  function expand() {
    onClose();
    navigate('/notifications');
  }

  const hasUnread = (feed.items ?? []).some((n) => !n.read);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Notifications"
      aria-hidden={!open}
      inert={!open}
      // Global single-key shortcuts (?, g-chords) stay off while focus is in
      // here, the same marker other focus containers use.
      data-shortcut-guard
      data-notifications-pane
      tabIndex={-1}
      className={clsx(
        'fixed top-12 bottom-0 z-[55] flex flex-col border-l border-border bg-surface outline-none duration-200 ease-out motion-reduce:transition-none',
        copilotResizing ? 'transition-transform' : 'transition-[right,transform,visibility]',
        copilotOpen ? 'shadow-none' : 'shadow-2xl',
        !open && 'invisible',
      )}
      style={{
        width: `min(${NOTIFICATIONS_PANE_WIDTH}px, 100vw)`,
        right: copilotOpen ? copilotWidth : 0,
        transform: open && visible ? 'translateX(0)' : 'translateX(100%)',
      }}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <h2 className="font-display text-base font-medium text-text">Notifications</h2>
        {feed.unreadCount > 0 && (
          <span className="rounded-full bg-accent-soft-bg px-2 py-0.5 text-xs font-medium text-accent-soft-text">
            {feed.unreadCount} unread
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {/* Always mounted, only disabled: unmounting the focused button on
              success would drop focus to <body>, and Escape with it. */}
          <IconButton
            label="Mark all as read"
            title={hasUnread ? 'Mark all as read' : 'Nothing unread'}
            aria-disabled={!hasUnread}
            className={hasUnread ? undefined : 'cursor-default opacity-40 hover:bg-transparent'}
            onClick={() => {
              if (hasUnread) void feed.markAllRead();
            }}
          >
            <CheckCheck size={16} />
          </IconButton>
          <IconButton label="Open full page" title="Open full page" onClick={expand}>
            <Maximize2 size={15} />
          </IconButton>
          <IconButton label="Close notifications" title="Close" onClick={onClose}>
            <IconX size={16} />
          </IconButton>
        </div>
      </div>
      <NotificationTabs
        idPrefix="notifications-pane"
        value={tab}
        onChange={changeTab}
        className="shrink-0 px-2"
      />
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="px-3 pt-3 pb-1">
          <NotWired capability="notifications.production" />
        </div>
        <NotificationList
          feed={feed}
          tab={tab}
          panelId="notifications-pane-panel"
          labelledBy={`notifications-pane-tab-${tab}`}
          onOpen={(n) => void openRow(n)}
        />
      </div>
    </div>,
    document.body,
  );
}
