/**
 * Fired on `window` after something changes a notification's read state, so
 * the topbar bell — mounted once for the whole session — refetches its unread
 * count instead of holding whatever was true at launch.
 */
export const NOTIFICATIONS_CHANGED_EVENT = 'waypoint:notifications-changed';

export function announceNotificationsChanged(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}
