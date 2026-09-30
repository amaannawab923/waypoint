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

function Where() {
  const { pathname, search, hash } = useLocation();
  return <p data-testid="where">{pathname + search + hash}</p>;
}
function mount(
  entries: ActivityEntry[],
  comments: Comment[] = [],
  { onJump = jest.fn(), commentsLoaded = true }: { onJump?: (id: string) => void; commentsLoaded?: boolean } = {},
) {
  return render(
    <MemoryRouter initialEntries={['/projects/p/tickets?peek=T-1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <TicketActivity
                entries={entries}
                comments={comments}
                commentsLoaded={commentsLoaded}
                statesById={states}
                resolveActor={actor}
                projectId="p"
                onJumpToComment={onJump}
              />
              <Where />
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
    const onJump = jest.fn();
    mount([entry({ verb: 'commented', detail: 'left a comment', payload: {} })], [c], { onJump });
    const quote = screen.getByRole('button', { name: 'Jump to comment: Found it — the pager stops early' });
    fireEvent.click(quote);
    fireEvent.click(quote);
    // Scrolls in place every time; never routes (which would drop ?peek= and close the drawer).
    expect(onJump).toHaveBeenCalledTimes(2);
    expect(onJump).toHaveBeenCalledWith('c9');
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/projects\/p\/tickets\?peek=T-1$/);
  });

  it("quotes a Copilot comment's words, not its HTML or its disclosure", () => {
    const c = {
      id: 'c1',
      ticketId: 't',
      authorId: 'm1',
      bodyHtml: "<p><em>Hi, this is Copilot — Maya’s agent — commenting on their behalf: </em>Repro &amp; fix are in</p><p>Second &lt;b&gt; para</p>",
      createdAt: now,
    } as Comment;
    mount([entry({ verb: 'commented', payload: { commentId: 'c1' } })], [c]);
    expect(screen.getByRole('button', { name: 'Jump to comment: Repro & fix are in Second <b> para' })).toBeInTheDocument();
    expect(screen.queryByText(/<p>|<em>|Hi, this is Copilot/)).not.toBeInTheDocument();
  });

  it('says a comment was deleted instead of linking to nothing', () => {
    mount([entry({ verb: 'commented', payload: { commentId: 'gone' } })]);
    expect(screen.getByText('(since deleted)')).toBeInTheDocument();
  });

  it('does not call a comment deleted while comments are still loading', () => {
    mount([entry({ verb: 'commented', payload: { commentId: 'c1' } })], [], { commentsLoaded: false });
    expect(screen.getByText('commented')).toBeInTheDocument();
    expect(screen.queryByText('(since deleted)')).not.toBeInTheDocument();
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

  it('says "themselves" when someone assigns themselves', () => {
    mount([entry({ verb: 'assignee_added', actorId: 'm1', payload: { personId: 'm1', personName: 'Maya P.' } })]);
    expect(screen.getByText('assigned themselves')).toBeInTheDocument();
  });

  it('reads sprint moves, and tells story points from the estimate', () => {
    mount([
      entry({ verb: 'sprint_changed', payload: { fromName: 'Sprint 11', toName: 'Sprint 12' } }),
      entry({ verb: 'sprint_changed', payload: { fromName: 'Sprint 12', toName: null } }),
      entry({ verb: 'points_changed', payload: { from: null, to: 3 } }),
      entry({ verb: 'estimate_changed', payload: { from: 'S', to: 'M' } }),
    ]);
    expect(screen.getByText(/moved sprint/).textContent).toBe('moved sprint Sprint 11 to Sprint 12');
    expect(screen.getByText(/removed from/).textContent).toBe('removed from Sprint 12');
    expect(screen.getByText('3 story points')).toBeInTheDocument();
    expect(screen.getByText(/changed the estimate/).textContent).toBe('changed the estimate S to M');
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

  it('holds older activity back, counts it in updates, and folds it away again', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      entry({ actorId: i % 2 ? 'm1' : 'm2', verb: 'label_added', payload: { labelName: `l${i}` }, createdAt: new Date(Date.now() - i * 3_600_000).toISOString() }),
    );
    mount(many);
    expect(screen.queryByText('l11')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 4 older updates' }));
    expect(screen.getByText('l11')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText('l11')).not.toBeInTheDocument();
  });

  it('has an honest empty state', () => {
    mount([]);
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });
});
