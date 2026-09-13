import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgentRun } from '@/types/agentRuns';
import { groupRuns } from '@/lib/sessionsStore';
import { SessionList } from './SessionList';

jest.mock('@/lib/useTicketLabel', () => ({
  useTicketLabel: (ticketId: string | null) =>
    ticketId === 'wi-61' ? 'ROAD-61 · Session list' : null,
  useTicketSummary: (ticketId: string | null) =>
    ticketId === 'wi-61'
      ? {
          identifier: 'ROAD-61',
          title: 'Session list',
          label: 'ROAD-61 · Session list',
        }
      : null,
}));

const run = (
  id: string,
  status: AgentRun['status'],
  over: Partial<AgentRun> = {},
): AgentRun =>
  ({
    id,
    status,
    providerId: 'claude',
    entry: 'independent',
    ticketId: null,
    branch: `feat/${id}`,
    blockedReason: null,
    updatedAt: '2026-09-12T10:00:00Z',
    ...over,
  }) as AgentRun;

const RUNS = [
  run('run-done', 'done', { updatedAt: '2026-09-12T08:00:00Z' }),
  run('run-run', 'running'),
  run('run-blocked', 'blocked', {
    blockedReason: 'Wants to run pnpm test',
    ticketId: 'wi-61',
    entry: 'dispatched',
  }),
];

function renderList(selected: string | null = null) {
  const onOpen = jest.fn();
  const onNew = jest.fn();
  render(
    <MemoryRouter>
      <SessionList
        groups={groupRuns(RUNS)}
        selectedRunId={selected}
        onOpen={onOpen}
        onNew={onNew}
      />
    </MemoryRouter>,
  );
  return Object.assign(onOpen, { onNew });
}

describe('SessionList', () => {
  it('renders the groups in their fixed order with counts, each row named by ticket or branch, with the waiting reason', () => {
    renderList();
    const groups = screen
      .getAllByRole('group')
      .map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Waiting on you', 'Active', 'Done']);

    const waiting = screen.getByRole('group', { name: 'Waiting on you' });
    expect(waiting).toHaveTextContent('Waiting on you · 1');
    const blocked = within(waiting).getByRole('option');
    expect(blocked).toHaveTextContent('ROAD-61 · Session list');
    expect(blocked).toHaveTextContent('Wants to run pnpm test');
    expect(blocked).toHaveTextContent('Dispatched');

    const active = screen.getByRole('group', { name: 'Active' });
    expect(within(active).getByRole('option')).toHaveTextContent(
      'feat/run-run',
    );
  });

  it('marks the open run selected, opens on click', () => {
    const onOpen = renderList('run-run');
    const options = screen.getAllByRole('option');
    expect(options.find((o) => o.id === 'session-row-run-run')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.click(options.find((o) => o.id === 'session-row-run-done')!);
    expect(onOpen).toHaveBeenCalledWith('run-done');
  });

  it('walks the rows with the arrow keys and opens with Enter — waiting first, then active, then done', () => {
    const onOpen = renderList();
    const box = screen.getByRole('listbox', { name: 'Sessions' });
    box.focus();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box).toHaveAttribute(
      'aria-activedescendant',
      'session-row-run-blocked',
    );
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box).toHaveAttribute('aria-activedescendant', 'session-row-run-run');
    fireEvent.keyDown(box, { key: 'End' });
    expect(box).toHaveAttribute(
      'aria-activedescendant',
      'session-row-run-done',
    );
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('run-run');
  });

  it('the header "+" opens the New session dialog (W4)', () => {
    const { onNew } = renderList();
    const plus = screen.getByLabelText('New session');
    expect(plus).not.toHaveAttribute('aria-disabled');
    fireEvent.click(plus);
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});

describe('group by (W5a)', () => {
  afterEach(() => localStorage.clear());

  it('switches to ticket groups — most recent ticket first, independent runs last — and remembers it', () => {
    renderList();
    fireEvent.click(screen.getByRole('radio', { name: 'Ticket' }));
    expect(screen.getByRole('radio', { name: 'Ticket' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const groups = screen.getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'wi-61',
      'Independent',
    ]);
    expect(within(groups[0]).getByText('ROAD-61')).toBeInTheDocument();
    expect(within(groups[0]).getByText('Session list')).toBeInTheDocument();
    expect(within(groups[1]).getAllByRole('option')).toHaveLength(2);
    expect(localStorage.getItem('waypoint:sessions:groupBy')).toBe('ticket');
    expect(
      screen.queryByRole('group', { name: 'Waiting on you' }),
    ).not.toBeInTheDocument();
  });

  it('keyboard order follows the ticket groups', () => {
    localStorage.setItem('waypoint:sessions:groupBy', 'ticket');
    const onOpen = renderList();
    const box = screen.getByRole('listbox');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('run-blocked');
  });
});
