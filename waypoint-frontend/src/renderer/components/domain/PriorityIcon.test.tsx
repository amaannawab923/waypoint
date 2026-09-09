import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { PRIORITY_LABEL, PriorityIcon } from './PriorityIcon';

// First-ever coverage for this file (waypoint-revamp ticket-UX pass,
// polish item 1): the icon used to carry no accessible name at all, even at
// the List/Board call sites where it is the ONLY signal of priority (no
// adjacent visible text) — a screen-reader user got nothing there. Most
// call sites keep a visible PRIORITY_LABEL string next to the icon, so the
// default stays decorative rather than forcing every icon to carry a label.
describe('PriorityIcon', () => {
  it('is decorative (aria-hidden, no accessible name) when no label is passed', () => {
    render(<PriorityIcon priority="high" />);

    const icon = document.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).not.toHaveAttribute('aria-label');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('exposes a real accessible name when a label is passed', () => {
    render(<PriorityIcon priority="urgent" label={PRIORITY_LABEL.urgent} />);

    const icon = screen.getByRole('img', { name: 'Urgent' });
    expect(icon).not.toHaveAttribute('aria-hidden');
  });

  it.each(['urgent', 'high', 'medium', 'low', 'none'] as const)(
    'labels %s with its display name',
    (priority) => {
      render(<PriorityIcon priority={priority} label={PRIORITY_LABEL[priority]} />);
      expect(screen.getByRole('img', { name: PRIORITY_LABEL[priority] })).toBeInTheDocument();
    },
  );
});
