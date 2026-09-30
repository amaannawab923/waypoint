import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { CheckCheck, Maximize2, Settings2 } from 'lucide-react';
import { IconX } from '@/components/icons';
import { IconButton } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { NotWired } from '@/components/ui/NotWired';
import { useCopilotOpenState } from '@/lib/copilotOpenStore';
import { useCopilotPanelResizingState, useCopilotPanelWidthState } from '@/lib/useCopilotPanelWidth';
import type { NotificationItem, NotificationTab } from '@/types/entities';
import { NotificationList } from './NotificationList';
import { NotificationTabs, UnreadSwitch } from './NotificationTabs';
import { PANE_PAGE_SIZE, useNotificationFeed } from './useNotificationFeed';
import { openNotificationTarget } from './openNotification';
import { readRememberedTab, rememberTab } from './rememberedTab';

export const NOTIFICATIONS_PANE_WIDTH = 460;

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
  const [unreadOnly, setUnreadOnly] = useState(false);
  const feed = useNotificationFeed(tab, { unreadOnly, active: open, pageSize: PANE_PAGE_SIZE });
  const copilotOpen = useCopilotOpenState();
  const copilotWidth = useCopilotPanelWidthState();
  const copilotResizing = useCopilotPanelResizingState();

  // The full page shares the remembered tab; pick up a change made there
  // since this (persistent) pane was last open.
  useEffect(() => {
    if (open) setTab(readRememberedTab());
  }, [open]);

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
      // Only take focus back if it's still ours to give: inside the pane,
      // or dropped to <body>. If something else has already taken it — the
      // ⌘K palette's search box, or whatever a click-away landed on — it
      // stays there.
      const active = document.activeElement;
      if (active && active !== document.body && !panelRef.current?.contains(active)) return;
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

  function openSettings() {
    onClose();
    navigate('/profile/notifications');
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
      <div className="shrink-0 border-b border-border">
        <div className="flex items-center gap-2 px-5 pt-4 pb-3">
          <h2 className="font-display text-[17px] font-medium tracking-tight text-text">Notifications</h2>
          {feed.unreadCount > 0 && (
            <span className="rounded-full bg-info-bg px-2 py-0.5 text-[11px] font-semibold text-info tabular-nums">
              {feed.unreadCount} new
            </span>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            {/* Always mounted, only disabled: unmounting the focused button on
                success would drop focus to <body>, and Escape with it. */}
            <Tooltip label={hasUnread ? 'Mark all as read' : 'Nothing unread'}>
              <IconButton
                label="Mark all as read"
                aria-disabled={!hasUnread}
                className={hasUnread ? undefined : 'cursor-default opacity-40 hover:bg-transparent'}
                onClick={() => {
                  if (hasUnread) void feed.markAllRead();
                }}
              >
                <CheckCheck size={16} />
              </IconButton>
            </Tooltip>
            <Tooltip label="Notification settings">
              <IconButton label="Notification settings" onClick={openSettings}>
                <Settings2 size={15} />
              </IconButton>
            </Tooltip>
            <Tooltip label="Open full page">
              <IconButton label="Open full page" onClick={expand}>
                <Maximize2 size={14} />
              </IconButton>
            </Tooltip>
            <Tooltip label="Close">
              <IconButton label="Close notifications" onClick={onClose}>
                <IconX size={16} />
              </IconButton>
            </Tooltip>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 px-5 pb-3">
          <NotificationTabs idPrefix="notifications-pane" value={tab} onChange={changeTab} />
          <UnreadSwitch id="notifications-pane-unread" checked={unreadOnly} onChange={setUnreadOnly} />
        </div>
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        <NotificationList
          feed={feed}
          tab={tab}
          panelId="notifications-pane-panel"
          labelledBy={`notifications-pane-tab-${tab}`}
          onOpen={(n) => void openRow(n)}
          unreadOnly={unreadOnly}
          footer={
            <div className="px-4 pt-2 pb-4">
              <NotWired capability="notifications.production" />
            </div>
          }
        />
      </div>
    </div>,
    document.body,
  );
}
