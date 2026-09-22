import { humanizeAgo, humanizeDuration } from './duration';

describe('humanizeDuration', () => {
  it.each([
    [0, '0s'],
    [45, '45s'],
    [59.4, '59s'],
    [60, '1 min'],
    [825, '14 min'],
    [3599, '1h'],
    [3600, '1h'],
    [16620, '4h 37min'],
    [7200, '2h'],
  ])('%s seconds → %s', (secs, label) => {
    expect(humanizeDuration(secs)).toBe(label);
  });

  it('never prints a negative', () => {
    expect(humanizeDuration(-5)).toBe('0s');
  });
});

describe('humanizeAgo', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z');
  it('277 minutes ago reads as hours, not minutes', () => {
    expect(humanizeAgo('2026-09-21T07:23:00.000Z', now)).toBe('4h 37min ago');
  });
  it('under a second is just now', () => {
    expect(humanizeAgo('2026-09-21T12:00:00.000Z', now)).toBe('just now');
  });
  it('an unparseable time is just now, never NaN', () => {
    expect(humanizeAgo('garbage', now)).toBe('just now');
  });
});
