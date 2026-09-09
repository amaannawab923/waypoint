import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  createTicket,
  ensureAgentAssignments,
  listAgents,
  listLabels,
  listMembers,
  listStates,
  listTickets,
} from '@/data/api';
import type { Ticket, TicketState } from '@/types/entities';
import { CreateTicketModal } from './CreateTicketModal';

// First-ever coverage for this file. Focused on finding 2a (the new
// "Parent" field) rather than a full sweep — state/priority/assignee/label
// pickers here are the same ad-hoc `Dropdown` pattern already covered
// indirectly by every screen that renders this modal.
jest.mock('@/data/api', () => ({
  createTicket: jest.fn(),
  ensureAgentAssignments: jest.fn(),
  listAgents: jest.fn(),
  listLabels: jest.fn(),
  listMembers: jest.fn(),
  listStates: jest.fn(),
  listTickets: jest.fn(),
}));

function state(overrides: Partial<TicketState> = {}): TicketState {
  return {
    id: 'st-1',
    projectId: 'proj-1',
    name: 'Todo',
    group: 'unstarted',
    color: '#888',
    isDefault: true,
    sortOrder: 0,
    ...overrides,
  };
}

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

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(listStates).mockResolvedValue([state()]);
  jest.mocked(listMembers).mockResolvedValue([]);
  jest.mocked(listAgents).mockResolvedValue([]);
  jest.mocked(listLabels).mockResolvedValue([]);
  jest.mocked(listTickets).mockResolvedValue([]);
  jest.mocked(createTicket).mockResolvedValue(ticket());
  jest.mocked(ensureAgentAssignments).mockResolvedValue(undefined as never);
});

// H1: the modal is always mounted at every call site (Modal's `open` prop
// just gates visibility, not whether CreateTicketModal itself is in the
// tree) — so an ungated listTickets(projectId) call fired on every
// navigation everywhere in the app, including from global chrome
// (Topbar.tsx), whether or not the modal was ever opened. It was also
// stale: since nothing remounts this component, a ticket created during
// one open wasn't offered as a parent option the next time the modal
// opened, without a full page reload.
describe('CreateTicketModal → parent-picker fetch is gated on `open` (H1)', () => {
  it('does not fetch the project ticket list while closed', async () => {
    render(<CreateTicketModal open={false} onClose={jest.fn()} projectId="proj-1" onCreated={jest.fn()} />);

    // Give any stray effect a tick to fire, then confirm it never did.
    await act(async () => {
      await Promise.resolve();
    });
    expect(listTickets).not.toHaveBeenCalled();
  });

  it('fetches fresh data on every open, not just once — a ticket created during a prior open is offered next time', async () => {
    jest.mocked(listTickets).mockResolvedValueOnce([]);

    const { rerender } = render(
      <CreateTicketModal open={false} onClose={jest.fn()} projectId="proj-1" onCreated={jest.fn()} />,
    );
    expect(listTickets).not.toHaveBeenCalled();

    // First open: no tickets exist yet.
    rerender(<CreateTicketModal open onClose={jest.fn()} projectId="proj-1" onCreated={jest.fn()} />);
    await waitFor(() => expect(listTickets).toHaveBeenCalledTimes(1));

    // Simulate a ticket being created elsewhere while the modal is closed
    // (e.g. via this same modal on a prior open, or another view) — the
    // next open's fetch must see it, not a cached result from the first.
    jest.mocked(listTickets).mockResolvedValueOnce([
      ticket({ id: 'new-1', identifier: 'CW-9', title: 'Just created' }),
    ]);

    // Close, then re-open — this is exactly what toggling the toolbar's
    // "Add ticket" button twice does; the component never unmounts.
    rerender(<CreateTicketModal open={false} onClose={jest.fn()} projectId="proj-1" onCreated={jest.fn()} />);
    rerender(<CreateTicketModal open onClose={jest.fn()} projectId="proj-1" onCreated={jest.fn()} />);

    await waitFor(() => expect(listTickets).toHaveBeenCalledTimes(2));

    fireEvent.click(await screen.findByText('Parent'));
    expect(await screen.findByText('Just created')).toBeInTheDocument();
  });
});

describe('CreateTicketModal → Parent field (finding 2a)', () => {
  it('offers only parentless tickets, not one that already has a parent', async () => {
    jest.mocked(listTickets).mockResolvedValue([
      ticket({ id: 'a', identifier: 'CW-1', title: 'Epic root', parentId: null }),
      ticket({ id: 'b', identifier: 'CW-2', title: 'Already a subtask', parentId: 'a' }),
    ]);

    render(<CreateTicketModal open onClose={jest.fn()} projectId="proj-1" onCreated={jest.fn()} />);

    fireEvent.click(await screen.findByText('Parent'));

    expect(await screen.findByText('Epic root')).toBeInTheDocument();
    expect(screen.queryByText('Already a subtask')).not.toBeInTheDocument();
  });

  it('filters the option list as the user types', async () => {
    jest.mocked(listTickets).mockResolvedValue([
      ticket({ id: 'a', identifier: 'CW-1', title: 'Redesign onboarding' }),
      ticket({ id: 'b', identifier: 'CW-2', title: 'Fix login bug' }),
    ]);

    render(<CreateTicketModal open onClose={jest.fn()} projectId="proj-1" onCreated={jest.fn()} />);

    fireEvent.click(await screen.findByText('Parent'));
    expect(await screen.findByText('Redesign onboarding')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search tickets…'), {
      target: { value: 'login' },
    });

    expect(screen.queryByText('Redesign onboarding')).not.toBeInTheDocument();
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
  });

  it('selecting a parent shows it on the trigger and submits it with the new ticket', async () => {
    jest.mocked(listTickets).mockResolvedValue([
      ticket({ id: 'a', identifier: 'CW-1', title: 'Epic root' }),
    ]);

    render(<CreateTicketModal open onClose={jest.fn()} projectId="proj-1" onCreated={jest.fn()} />);

    fireEvent.click(await screen.findByText('Parent'));
    fireEvent.click(await screen.findByText('Epic root'));

    expect(await screen.findByText('CW-1 — Epic root')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Ticket title'), {
      target: { value: 'A new subtask' },
    });
    await act(async () => {
      screen.getByText('Create ticket').click();
    });

    await waitFor(() =>
      expect(createTicket).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'A new subtask', parentId: 'a' }),
      ),
    );
  });

  it('defaultParentId seeds the field for the "Add subtask" flow, with no parent PATCH needed after create', async () => {
    jest.mocked(listTickets).mockResolvedValue([
      ticket({ id: 'parent-1', identifier: 'CW-1', title: 'Epic root' }),
    ]);

    render(
      <CreateTicketModal
        open
        onClose={jest.fn()}
        projectId="proj-1"
        defaultParentId="parent-1"
        onCreated={jest.fn()}
      />,
    );

    expect(await screen.findByText('CW-1 — Epic root')).toBeInTheDocument();

    fireEvent.change(await screen.findByPlaceholderText('Ticket title'), {
      target: { value: 'A subtask' },
    });
    await act(async () => {
      screen.getByText('Create ticket').click();
    });

    await waitFor(() =>
      expect(createTicket).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: 'parent-1' }),
      ),
    );
  });

  it('"No parent" clears a seeded defaultParentId', async () => {
    jest.mocked(listTickets).mockResolvedValue([
      ticket({ id: 'parent-1', identifier: 'CW-1', title: 'Epic root' }),
    ]);

    render(
      <CreateTicketModal
        open
        onClose={jest.fn()}
        projectId="proj-1"
        defaultParentId="parent-1"
        onCreated={jest.fn()}
      />,
    );

    expect(await screen.findByText('CW-1 — Epic root')).toBeInTheDocument();
    fireEvent.click(screen.getByText('CW-1 — Epic root'));
    fireEvent.click(await screen.findByText('No parent'));

    expect(screen.getByText('Parent')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Ticket title'), {
      target: { value: 'Standalone ticket' },
    });
    await act(async () => {
      screen.getByText('Create ticket').click();
    });

    await waitFor(() =>
      expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({ parentId: null })),
    );
  });
});
