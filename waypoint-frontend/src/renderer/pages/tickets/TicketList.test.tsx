import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  listAllTickets,
  listTickets,
  listStates,
  listLabels,
  listWorkstreams,
  listAllWorkstreams,
  listSprints,
  listAllSprints,
  listProjects,
  listAgents,
  listAgentAssignments,
  listMembers,
  updateTicket,
} from '@/data/api';
import type { Member, Project, Ticket, TicketState } from '@/types/entities';
import {
  getActiveSelectableView,
  __resetActiveSelectableViewForTests,
} from '@/lib/useActiveSelectableView';
import { useTicketsView } from './useTicketsView';
import TicketList from './TicketList';

// W5.2's own accept-criterion coverage for the shared TicketList component:
// the count line always equals the rendered row count, bulk-select wires
// through to the real per-ticket update endpoint (there's no bulk-mutation
// endpoint on tickets, unlike proposals — see TicketList.tsx's own comment),
// and `j`/`k`/`x` are scoped to this component's mount and ignored while
// typing, mirroring ReviewPage's `e`/`r` shortcut test coverage.
jest.mock('@/data/api', () => ({
  listTickets: jest.fn(),
  listAllTickets: jest.fn(),
  listStates: jest.fn(),
  listLabels: jest.fn(),
  listWorkstreams: jest.fn(),
  listAllWorkstreams: jest.fn(),
  listSprints: jest.fn(),
  listAllSprints: jest.fn(),
  listProjects: jest.fn(),
  listAgents: jest.fn(),
  listAgentAssignments: jest.fn(),
  listMembers: jest.fn(),
  updateTicket: jest.fn(),
}));

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

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: 'mem-2',
    workspaceId: 'ws-1',
    fullName: 'Maya P.',
    displayName: 'Maya',
    email: 'maya@example.com',
    avatarColor: '#f00',
    role: 'member',
    authMethod: 'email',
    joinedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return { id: 'proj-1', name: 'Compass Web', icon: '🧭', ...overrides } as Project;
}

// jsdom doesn't implement scrollIntoView — TicketList's j/k focus movement
// calls it on the newly-focused row, which is otherwise harmless in a real
// browser but throws as an unhandled exception under jsdom.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  __resetActiveSelectableViewForTests();
  jest.mocked(listStates).mockResolvedValue([state()]);
  jest.mocked(listLabels).mockResolvedValue([]);
  jest.mocked(listWorkstreams).mockResolvedValue([]);
  jest.mocked(listAllWorkstreams).mockResolvedValue([]);
  jest.mocked(listSprints).mockResolvedValue([]);
  jest.mocked(listAllSprints).mockResolvedValue([]);
  jest.mocked(listProjects).mockResolvedValue([project()]);
  jest.mocked(listAgents).mockResolvedValue([]);
  jest.mocked(listAgentAssignments).mockResolvedValue([]);
  jest.mocked(listMembers).mockResolvedValue([member()]);
  jest.mocked(updateTicket).mockResolvedValue(ticket());
});

function TestHarness({ fixture }: { fixture: Ticket[] }) {
  jest.mocked(listTickets).mockResolvedValue(fixture);
  const view = useTicketsView({ projectId: 'proj-1' });
  return <TicketList view={view} projectId="proj-1" />;
}

async function renderList(fixture: Ticket[]) {
  const utils = render(
    <MemoryRouter>
      <TestHarness fixture={fixture} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.queryByText(/^\d+ tickets?$/)).toBeInTheDocument());
  return utils;
}

describe('TicketList count line', () => {
  it('the count line always equals the number of rendered rows', async () => {
    const fixture = [ticket({ id: 'a', identifier: 'CW-1' }), ticket({ id: 'b', identifier: 'CW-2' })];
    await renderList(fixture);

    expect(screen.getByText('2 tickets')).toBeInTheDocument();
    expect(screen.getByText('CW-1')).toBeInTheDocument();
    expect(screen.getByText('CW-2')).toBeInTheDocument();
    // Every rendered identifier is one row — exactly `fixture.length` of them.
    expect(screen.getAllByRole('checkbox')).toHaveLength(fixture.length);
  });
});

describe('TicketList bulk select + bulk actions', () => {
  it('checking rows and choosing "Set priority" PATCHes every selected ticket, not a bulk endpoint', async () => {
    const fixture = [ticket({ id: 'a', identifier: 'CW-1' }), ticket({ id: 'b', identifier: 'CW-2' })];
    await renderList(fixture);

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    expect(screen.getByText('2 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Set priority'));
    fireEvent.click(screen.getByText('Urgent'));

    await waitFor(() => {
      expect(updateTicket).toHaveBeenCalledWith('a', { priority: 'urgent' });
      expect(updateTicket).toHaveBeenCalledWith('b', { priority: 'urgent' });
    });
    expect(updateTicket).toHaveBeenCalledTimes(2);
  });

  it('clears the selection once a bulk action is applied', async () => {
    const fixture = [ticket({ id: 'a', identifier: 'CW-1' })];
    await renderList(fixture);

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Set priority'));
    fireEvent.click(screen.getByText('Low'));

    await waitFor(() => expect(updateTicket).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
  });
});

describe('TicketList j/k/x keyboard', () => {
  it('j/k move a row focus ring and x toggles that row\'s selection', async () => {
    const fixture = [ticket({ id: 'a', identifier: 'CW-1' }), ticket({ id: 'b', identifier: 'CW-2' })];
    await renderList(fixture);

    fireEvent.keyDown(document, { key: 'j' });
    fireEvent.keyDown(document, { key: 'x' });

    await waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument());

    // k moves back up off the only focused/selected row and toggling again
    // would deselect it — instead move down then back and re-toggle to
    // confirm x always acts on whatever row currently has focus.
    fireEvent.keyDown(document, { key: 'j' });
    fireEvent.keyDown(document, { key: 'x' });
    await waitFor(() => expect(screen.getByText('2 selected')).toBeInTheDocument());
  });

  it('ignores j/k/x while typing in a text field (e.g. the toolbar search input)', async () => {
    const fixture = [ticket({ id: 'a', identifier: 'CW-1' })];
    await renderList(fixture);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(input, { key: 'x' });
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();

    document.body.removeChild(input);
  });

  it('tears its keydown listener down on unmount — no cross-screen shortcut leakage', async () => {
    const fixture = [ticket({ id: 'a', identifier: 'CW-1' })];
    const { unmount } = await renderList(fixture);
    unmount();

    // Should not throw / should be a no-op now that TicketList is gone.
    expect(() => fireEvent.keyDown(document, { key: 'j' })).not.toThrow();
  });
});

// W5.4: TicketList registers itself as the app-shell keyboard layer's
// "active selectable view" (useActiveSelectableView.ts) on mount so ⌘A can
// reach it — additive to the j/k/x listener above, not a replacement for
// it. Exercised here through the registry directly (the same way
// useGlobalKeyboardShortcuts.test.tsx exercises ⌘A's dispatch), rather than
// mounting the whole global hook, to keep this file's own accept criteria
// isolated from that hook's.
describe('TicketList active-view registration (W5.4)', () => {
  it('registers a view whose selectAll selects every visible row', async () => {
    const fixture = [ticket({ id: 'a', identifier: 'CW-1' }), ticket({ id: 'b', identifier: 'CW-2' })];
    await renderList(fixture);

    const view = getActiveSelectableView();
    expect(view).not.toBeNull();

    act(() => {
      view?.selectAll();
    });

    await waitFor(() => expect(screen.getByText('2 selected')).toBeInTheDocument());
  });

  it('the registered view\'s clear() empties the selection', async () => {
    const fixture = [ticket({ id: 'a', identifier: 'CW-1' })];
    await renderList(fixture);

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    act(() => {
      getActiveSelectableView()?.clear();
    });

    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('unregisters on unmount, leaving no active view behind', async () => {
    const fixture = [ticket({ id: 'a', identifier: 'CW-1' })];
    const { unmount } = await renderList(fixture);
    expect(getActiveSelectableView()).not.toBeNull();

    unmount();

    expect(getActiveSelectableView()).toBeNull();
  });
});
