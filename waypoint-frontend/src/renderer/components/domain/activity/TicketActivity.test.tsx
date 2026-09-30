import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ActivityEntry, Comment, TicketState } from '@/types/entities';
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

function Hash() {
  return <p data-testid="hash">{useLocation().hash}</p>;
}
function mount(entries: ActivityEntry[], comments: Comment[] = []) {
  return render(
    <MemoryRouter initialEntries={['/projects/p/tickets/T-1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <TicketActivity entries={entries} comments={comments} statesById={states} resolveActor={actor} projectId="p" />
              <Hash />
            </>
          }
        />
      </Routes>
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

  it('quotes the comment an entry is about, even for older entries without its id, and jumps to it', () => {
    const c: Comment = { id: 'c9', ticketId: 't', authorId: 'm1', bodyHtml: '**Found it** — the pager stops early', createdAt: now } as Comment;
    mount([entry({ verb: 'commented', detail: 'left a comment', payload: {} })], [c]);
    const quote = screen.getByRole('button', { name: 'Found it — the pager stops early' });
    fireEvent.click(quote);
    expect(screen.getByTestId('hash')).toHaveTextContent('#comment-c9');
  });

  it('says a comment was deleted instead of linking to nothing', () => {
    mount([entry({ verb: 'commented', payload: { commentId: 'gone' } })]);
    expect(screen.getByText('(since deleted)')).toBeInTheDocument();
  });

  it('marks changes applied from a proposal', () => {
    mount([entry({ verb: 'priority_changed', payload: { from: 'low', to: 'high', via: 'copilot' } })]);
    expect(screen.getByText('via Copilot')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
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

  it('filters to comments or changes', () => {
    mount([entry({ verb: 'commented', payload: { commentId: 'gone' } }), entry({ verb: 'label_added', payload: { labelName: 'bug' } })]);
    fireEvent.click(screen.getByRole('button', { name: 'Comments' }));
    expect(screen.queryByText('bug')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }));
    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.queryByText('(since deleted)')).not.toBeInTheDocument();
  });

  it('holds older activity behind "Show older activity"', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      entry({ actorId: i % 2 ? 'm1' : 'm2', verb: 'label_added', payload: { labelName: `l${i}` }, createdAt: new Date(Date.now() - i * 3_600_000).toISOString() }),
    );
    mount(many);
    expect(screen.queryByText('l11')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show older activity \(4\)/ }));
    expect(screen.getByText('l11')).toBeInTheDocument();
  });

  it('has an honest empty state', () => {
    mount([]);
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });
});
