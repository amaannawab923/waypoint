import type { NotificationItem } from '@/types/entities';
import { dayLabel, notificationSentence, rowTime } from './notificationText';

const base = {
  id: 'n',
  recipientId: 'm1',
  actorId: 'm2',
  ticketId: null,
  commentId: null,
  runId: null,
  message: null,
  read: false,
  readAt: null,
  kind: 'mention',
  groupKey: null,
  payload: {},
  createdAt: '',
  updatedAt: '',
  cursor: '',
} as NotificationItem;

describe('notificationSentence', () => {
  it('renders from the payload, so a renamed ticket reads right', () => {
    const n = {
      ...base,
      payload: { ticketKey: 'WP-1', ticketTitle: 'Auth flow' },
    };
    expect(notificationSentence(n)).toBe('mentioned you on WP-1 Auth flow');
    expect(notificationSentence({ ...n, kind: 'reply' })).toBe(
      'replied to your comment on WP-1 Auth flow',
    );
  });

  it('falls back to the frozen message on rows written before the payload existed', () => {
    expect(
      notificationSentence({
        ...base,
        message: 'mentioned you on "Old title"',
      }),
    ).toBe('mentioned you on "Old title"');
  });
});

describe('dayLabel / rowTime', () => {
  const now = new Date(2026, 8, 30, 15, 0); // Wed 30 Sep 2026, 15:00 local
  it('labels today, yesterday, this week by weekday, older by date', () => {
    expect(dayLabel(new Date(2026, 8, 30, 9).toISOString(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 8, 29, 9).toISOString(), now)).toBe(
      'Yesterday',
    );
    expect(dayLabel(new Date(2026, 8, 26, 9).toISOString(), now)).toBe(
      new Date(2026, 8, 26).toLocaleDateString(undefined, { weekday: 'long' }),
    );
    expect(dayLabel(new Date(2026, 8, 1, 9).toISOString(), now)).toBe(
      new Date(2026, 8, 1).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      }),
    );
  });

  it('is relative within today and clock time before it', () => {
    expect(rowTime(new Date(2026, 8, 30, 14, 59, 40).toISOString(), now)).toBe(
      'just now',
    );
    expect(rowTime(new Date(2026, 8, 30, 14, 48).toISOString(), now)).toBe(
      '12m',
    );
    expect(rowTime(new Date(2026, 8, 30, 12, 0).toISOString(), now)).toBe('3h');
    expect(rowTime(new Date(2026, 8, 29, 16, 12).toISOString(), now)).toBe(
      new Date(2026, 8, 29, 16, 12).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
  });
});
