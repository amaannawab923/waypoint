import '@testing-library/jest-dom';
import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Ticket } from '@/types/entities';
import { ParentTicketPicker } from './ParentTicketPicker';

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'wi-1',
    projectId: 'proj-1',
    identifier: 'CW-1',
    sequenceId: 1,
    title: 'Fix the thing',
    description: '',
    stateId: 'st-1',
    priority: 'medium',
    source: 'manual',
    assigneeIds: [],
    labelIds: [],
    workstreamId: null,
    sprintId: null,
    parentId: null,
    estimatePoints: null,
    estimateValue: null,
    startDate: null,
    dueDate: null,
    createdById: 'mem-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    attachmentCount: 0,
    linkCount: 0,
    links: [],
    isDraft: false,
    ...overrides,
  };
}

function renderPicker(props: Partial<Parameters<typeof ParentTicketPicker>[0]> = {}) {
  const triggerRef = createRef<HTMLButtonElement>();
  // A real trigger button in the DOM — useFloatingPanel positions the panel
  // off its getBoundingClientRect(), and click-away/focus-return logic both
  // read triggerRef.current.
  render(<button ref={triggerRef}>trigger</button>);
  const onSelect = jest.fn();
  const onClose = jest.fn();
  const utils = render(
    <ParentTicketPicker
      tickets={props.tickets ?? []}
      value={props.value ?? null}
      excludeTicketId={props.excludeTicketId}
      triggerRef={triggerRef}
      onSelect={props.onSelect ?? onSelect}
      onClose={props.onClose ?? onClose}
    />,
  );
  return { ...utils, onSelect, onClose };
}

describe('ParentTicketPicker parentless-only filtering (finding 2a)', () => {
  it('lists only tickets with no parent of their own', () => {
    const tickets = [
      ticket({ id: 'a', identifier: 'CW-1', title: 'Epic root', parentId: null }),
      ticket({ id: 'b', identifier: 'CW-2', title: 'Already nested', parentId: 'a' }),
    ];
    renderPicker({ tickets });

    expect(screen.getByText('Epic root')).toBeInTheDocument();
    expect(screen.queryByText('Already nested')).not.toBeInTheDocument();
  });

  it('excludes excludeTicketId from the option list', () => {
    const tickets = [
      ticket({ id: 'a', identifier: 'CW-1', title: 'Self' }),
      ticket({ id: 'b', identifier: 'CW-2', title: 'Other' }),
    ];
    renderPicker({ tickets, excludeTicketId: 'a' });

    expect(screen.queryByText('Self')).not.toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('renders each option as identifier — title', () => {
    renderPicker({
      tickets: [ticket({ id: 'a', identifier: 'ROAD-2', title: 'Ship the roadmap' })],
    });

    expect(screen.getByText('ROAD-2')).toBeInTheDocument();
    expect(screen.getByText('Ship the roadmap')).toBeInTheDocument();
  });
});

describe('ParentTicketPicker type-to-filter (finding 2a)', () => {
  it('filters by identifier or title as the user types, client-side', () => {
    const tickets = [
      ticket({ id: 'a', identifier: 'CW-1', title: 'Redesign onboarding' }),
      ticket({ id: 'b', identifier: 'CW-2', title: 'Fix login bug' }),
    ];
    renderPicker({ tickets });

    fireEvent.change(screen.getByPlaceholderText('Search tickets…'), {
      target: { value: 'CW-2' },
    });

    expect(screen.queryByText('Redesign onboarding')).not.toBeInTheDocument();
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
  });

  it('shows a no-match message rather than an empty panel', () => {
    renderPicker({ tickets: [ticket({ id: 'a', identifier: 'CW-1', title: 'Redesign' })] });

    fireEvent.change(screen.getByPlaceholderText('Search tickets…'), {
      target: { value: 'nothing matches this' },
    });

    expect(screen.getByText(/No parentless tickets match/)).toBeInTheDocument();
  });
});

describe('ParentTicketPicker selection wiring (finding 2a)', () => {
  it('calls onSelect with the ticket id when an option is clicked', () => {
    const tickets = [ticket({ id: 'a', identifier: 'CW-1', title: 'Epic root' })];
    const { onSelect } = renderPicker({ tickets });

    fireEvent.click(screen.getByText('Epic root'));

    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('calls onSelect with null when "No parent" is clicked', () => {
    const { onSelect } = renderPicker({
      tickets: [ticket({ id: 'a', identifier: 'CW-1', title: 'Epic root' })],
    });

    fireEvent.click(screen.getByText('No parent'));

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('marks the currently selected ticket as current', () => {
    renderPicker({
      tickets: [ticket({ id: 'a', identifier: 'CW-1', title: 'Epic root' })],
      value: 'a',
    });

    const option = screen.getByText('Epic root').closest('button') as HTMLElement;
    expect(option).toHaveTextContent('current');
  });
});

// M2: this panel used to render every filtered match with no cap — fine
// for a typical project, but a large/unfiltered project's ticket list
// could dump hundreds of rows into an unvirtualized scroll container.
describe('ParentTicketPicker result cap (M2)', () => {
  function manyTickets(count: number) {
    return Array.from({ length: count }, (_, i) =>
      ticket({ id: `t-${i}`, identifier: `CW-${i}`, title: `Ticket ${i}` }),
    );
  }

  it('renders no more than 100 options even when more than 100 match', () => {
    renderPicker({ tickets: manyTickets(150) });

    // trigger + "No parent" + 100 capped options = 102.
    expect(screen.getAllByRole('button')).toHaveLength(102);
    expect(screen.getByText('Ticket 0')).toBeInTheDocument();
    expect(screen.getByText('Ticket 99')).toBeInTheDocument();
    expect(screen.queryByText('Ticket 100')).not.toBeInTheDocument();
  });

  it('shows a "refine your search" hint only when truncated', () => {
    renderPicker({ tickets: manyTickets(150) });
    expect(screen.getByText(/refine your search/)).toBeInTheDocument();
  });

  it('shows no truncation hint when the result count is at or under the cap', () => {
    renderPicker({ tickets: manyTickets(100) });

    expect(screen.getAllByRole('button')).toHaveLength(102);
    expect(screen.queryByText(/refine your search/)).not.toBeInTheDocument();
  });

  it('narrowing the search below the cap removes the hint and reveals the rest', () => {
    renderPicker({ tickets: manyTickets(150) });
    expect(screen.getByText(/refine your search/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search tickets…'), {
      target: { value: 'Ticket 14' }, // matches "Ticket 14" and "Ticket 140".."Ticket 149" — well under 100
    });

    expect(screen.queryByText(/refine your search/)).not.toBeInTheDocument();
    expect(screen.getByText('Ticket 14')).toBeInTheDocument();
  });
});
