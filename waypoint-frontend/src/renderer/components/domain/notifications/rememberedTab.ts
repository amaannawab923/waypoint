import type { NotificationTab } from '@/types/entities';
import { NOTIFICATION_TAB_LABELS } from './NotificationTabs';

const KEY = 'waypoint.notifications.tab';

/** The last tab used, per viewer. Storage can be missing or throw; All is the fallback. */
export function readRememberedTab(): NotificationTab {
  try {
    const v = window.localStorage.getItem(KEY);
    return NOTIFICATION_TAB_LABELS.some((t) => t.key === v)
      ? (v as NotificationTab)
      : 'all';
  } catch {
    return 'all';
  }
}

export function rememberTab(tab: NotificationTab): void {
  try {
    window.localStorage.setItem(KEY, tab);
  } catch {
    // Not remembering the tab is fine.
  }
}
