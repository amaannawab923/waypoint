import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { CheckCheck, Maximize2 } from 'lucide-react';
import { IconX } from '@/components/icons';
import { IconButton } from '@/components/ui/Button';
import { NotWired } from '@/components/ui/NotWired';
import { useCopilotOpenState } from '@/lib/copilotOpenStore';
import {
  useCopilotPanelResizingState,
  useCopilotPanelWidthState,
} from '@/lib/useCopilotPanelWidth';
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
 * Closes on Escape (while focus is inside), on a click anywhere outside it
 * other than the bell (the bell toggles it), and after opening a row.
 */
export function NotificationsPane({
  onClose,
  bellId,
}: {
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

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Focus moves into the pane (so Escape and Tab work from the start) and
  // returns to the bell on close. The pane itself takes focus, not a tab,
  // so opening it with the mouse doesn't paint a focus ring on "All".
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
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
  }, [bellId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Same guard as TicketDrawer/CopilotPanel: only an Escape meant for
      // this pane closes it.
      if (
        panelRef.current &&
        !panelRef.current.contains(document.activeElement)
      )
        return;
      e.stopPropagation();
      onClose();
    };
    // Capture phase, so a ticket drawer underneath doesn't also close.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || panelRef.current?.contains(target)) return;
      if (document.getElementById(bellId)?.contains(target)) return; // the bell toggles
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose, bellId]);

  function changeTab(next: NotificationTab) {
    setTab(next);
    rememberTab(next);
  }

  async function open(n: NotificationItem) {
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
      data-notifications-pane
      tabIndex={-1}
      className={clsx(
        'fixed top-12 outline-none bottom-0 z-[55] flex flex-col border-l border-border bg-surface duration-200 ease-out motion-reduce:transition-none',
        copilotResizing
          ? 'transition-transform'
          : 'transition-[right,transform]',
        copilotOpen ? 'shadow-none' : 'shadow-2xl',
      )}
      style={{
        width: `min(${NOTIFICATIONS_PANE_WIDTH}px, 100vw)`,
        right: copilotOpen ? copilotWidth : 0,
        transform: visible ? 'translateX(0)' : 'translateX(100%)',
      }}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <h2 className="font-display text-base font-medium text-text">
          Notifications
        </h2>
        {feed.unreadCount > 0 && (
          <span className="rounded-full bg-accent-soft-bg px-2 py-0.5 text-xs font-medium text-accent-soft-text">
            {feed.unreadCount} unread
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {hasUnread && (
            <IconButton
              label="Mark all as read"
              title="Mark all as read"
              onClick={() => void feed.markAllRead()}
            >
              <CheckCheck size={16} />
            </IconButton>
          )}
          <IconButton
            label="Open full page"
            title="Open full page"
            onClick={expand}
          >
            <Maximize2 size={15} />
          </IconButton>
          <IconButton
            label="Close notifications"
            title="Close"
            onClick={onClose}
          >
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
          onOpen={(n) => void open(n)}
        />
      </div>
    </div>,
    document.body,
  );
}
