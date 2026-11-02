import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ActivityEntry, TicketState } from '@/types/entities';
import { TicketActivity } from './TicketActivity';

const TODO: TicketState = { id: 's1', projectId: 'p', name: 'Todo', group: 'unstarted', color: '#111', isDefault: true, sortOrder: 0 };
const DOING: TicketState = { id: 's2', projectId: 'p', name: 'Doing', group: 'started', color: '#222', isDefault: false, sortOrder: 1 };
const states = new Map([TODO, DOING].map((s) => [s.id, s]));
const now = new Date().toISOString();
let n = 0;
function entry(partial: Partial<ActivityEntry>): ActivityEntry {
  n += 1;
  return { id: `a${n}`, ticketId: 't', actorId: 'm1', verb: 'created', detail: 'did a thing', payload: {}, createdAt: now, ...partial };
}
const actor = (id: string) => ({ name: id === 'm1' ? 'Maya P.' : 'Jonas R.', color: '#000', shape: 'circle' as const });

function mount(entries: ActivityEntry[] | undefined) {
  return render(
    <MemoryRouter>
      <TicketActivity entries={entries} statesById={states} resolveActor={actor} projectId="p" />
    </MemoryRouter>,
  );
}

describe('TicketActivity', () => {
  it('shows a status change as the two statuses, using live names', () => {
    mount([
      entry({
        verb: 'state_changed',
        payload: {
          fromState: { id: 's1', name: 'Old todo name', group: 'unstarted', color: '#111' },
          toState: { id: 's2', name: 'Doing', group: 'started', color: '#222' },
        },
      }),
    ]);
    const line = screen.getByText('changed status').closest('li')!;
    expect(within(line).getByText('Todo')).toBeInTheDocument(); // renamed since: live name wins
    expect(within(line).getByText('Doing')).toBeInTheDocument();
  });

  it('falls back to the written sentence for entries without a payload', () => {
    mount([entry({ verb: 'state_changed', detail: 'changed state', payload: {} })]);
    expect(screen.getByText('changed state')).toBeInTheDocument();
  });

  it('is the change history only: comments are not repeated here', () => {
    mount([
      entry({ verb: 'commented', detail: 'left a comment', payload: { commentId: 'c1' } }),
      entry({ verb: 'label_added', payload: { labelName: 'bug' } }),
    ]);
    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.queryByText(/comment/)).not.toBeInTheDocument();
  });

  it('says so when there are comments but no changes', () => {
    mount([entry({ verb: 'commented', payload: { commentId: 'c1' } })]);
    expect(screen.getByText('No changes yet.')).toBeInTheDocument();
  });

  it('marks changes applied from a proposal', () => {
    mount([entry({ verb: 'priority_changed', payload: { from: 'low', to: 'high', via: 'copilot' } })]);
    expect(screen.getByText('via Copilot')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('gives Copilot changes and hand edits by the same person their own headers', () => {
    mount([
      entry({ verb: 'priority_changed', payload: { from: 'low', to: 'high', via: 'copilot' } }),
      entry({ verb: 'label_added', payload: { labelName: 'bug' } }),
    ]);
    expect(screen.getAllByText('Maya P.')).toHaveLength(2);
    const badge = screen.getByText('via Copilot').closest('li')!;
    expect(within(badge).getByText('High')).toBeInTheDocument();
    expect(within(badge).queryByText('bug')).not.toBeInTheDocument();
  });

  it('reads labels, people, dates and renames plainly', () => {
    mount([
      entry({ verb: 'label_added', payload: { labelName: 'bug', labelColor: '#f00' } }),
      entry({ verb: 'assignee_added', payload: { personId: 'm2', personName: 'Jonas' } }),
      entry({ verb: 'due_date_set', payload: { from: '2026-10-01', to: null } }),
      entry({ verb: 'title_changed', payload: { from: 'Old', to: 'New' } }),
    ]);
    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.getByText('Jonas')).toBeInTheDocument();
    expect(screen.getByText(/removed the due date/)).toBeInTheDocument();
    expect(screen.getByText('Old')).toHaveClass('line-through');
    expect(screen.getByText('New')).toBeInTheDocument();
  });

  it('says "themselves" when someone assigns themselves', () => {
    mount([entry({ verb: 'assignee_added', actorId: 'm1', payload: { personId: 'm1', personName: 'Maya P.' } })]);
    expect(screen.getByText('assigned themselves')).toBeInTheDocument();
  });

  it('reads sprint moves, and tells story points from the estimate', () => {
    mount([
      entry({ verb: 'sprint_changed', payload: { fromName: 'Sprint 11', toName: 'Sprint 12' } }),
      entry({ verb: 'sprint_changed', payload: { fromName: 'Sprint 12', toName: null } }),
      entry({ verb: 'points_changed', payload: { from: null, to: 3 } }),
      entry({ verb: 'points_changed', payload: { from: 3, to: 5 } }),
      entry({ verb: 'estimate_changed', payload: { from: 'S', to: 'M' } }),
    ]);
    expect(screen.getByText(/moved sprint/).textContent).toBe('moved sprint Sprint 11 to Sprint 12');
    expect(screen.getByText(/removed from/).textContent).toBe('removed from sprint Sprint 12');
    expect(screen.getByText('3 story points')).toBeInTheDocument();
    expect(screen.getByText(/changed story points/).textContent).toBe('changed story points 3 to 5');
    expect(screen.getByText(/changed the estimate/).textContent).toBe('changed the estimate S to M');
  });

  it('holds older changes back, counts them, and folds them away again', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      entry({ actorId: i % 2 ? 'm1' : 'm2', verb: 'label_added', payload: { labelName: `l${i}` }, createdAt: new Date(Date.now() - i * 3_600_000).toISOString() }),
    );
    mount(many);
    expect(screen.queryByText('l11')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show 4 older changes' });
    toggle.focus();
    fireEvent.click(toggle);
    expect(screen.getByText('l11')).toBeInTheDocument();
    // Same element, relabelled: keyboard focus is not dropped.
    expect(screen.getByRole('button', { name: 'Show less' })).toBe(toggle);
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(screen.queryByText('l11')).not.toBeInTheDocument();
  });

  it('has honest loading and empty states', () => {
    const { unmount } = mount(undefined);
    expect(screen.getByText('Loading activity…')).toBeInTheDocument();
    unmount();
    mount([]);
    expect(screen.getByText('No changes yet.')).toBeInTheDocument();
  });
});
