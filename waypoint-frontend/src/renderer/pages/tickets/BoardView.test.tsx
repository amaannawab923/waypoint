import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import {
  listAgentAssignments,
  listAgents,
  listLabels,
  listMembers,
  listStates,
  listTickets,
} from '@/data/api';
import type { Ticket, TicketState } from '@/types/entities';
import type { TicketGroup, TicketsView } from './useTicketsView';
import BoardView from './BoardView';

// First-ever coverage for this file (waypoint-revamp ticket-UX pass):
// covers the new epic badge (finding 2b), parent chip (finding 2c), and
// priority-colored left border (finding 5) — not a full sweep of the
// existing drag-and-drop machinery.
jest.mock('@/data/api', () => ({
  listAgentAssignments: jest.fn(),
  listAgents: jest.fn(),
  listLabels: jest.fn(),
  listMembers: jest.fn(),
  listStates: jest.fn(),
  listTickets: jest.fn(),
  updateTicket: jest.fn(),
  reorderTicket: jest.fn(),
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

function fakeView(opts: {
  items: Ticket[];
  groups: TicketGroup[];
  parentById?: Map<string, Ticket>;
  subItemCountByParent?: Map<string, { total: number; done: number }>;
  nestedChildIds?: Set<string>;
}): TicketsView {
  return {
    projectId: 'proj-1',
    items: opts.items,
    allItems: opts.items,
    subItemCountByParent: opts.subItemCountByParent ?? new Map(),
    parentById: opts.parentById ?? new Map(),
    nestedChildIds: opts.nestedChildIds ?? new Set(),
    loading: false,
    isRefetching: false,
    reload: jest.fn(),
    patchItemLocally: jest.fn(),
    reorderItemLocally: jest.fn(),
    states: [state()],
    labels: [],
    workstreams: [],
    sprints: [],
    projects: [],
    filters: {
      priority: [],
      stateId: [],
      labelId: [],
      assigneeId: [],
      workstreamId: [],
      sprintId: [],
      creatorId: [],
      text: '',
    },
    setFilters: jest.fn(),
    defaultFilters: {
      priority: [],
      stateId: [],
      labelId: [],
      assigneeId: [],
      workstreamId: [],
      sprintId: [],
      creatorId: [],
      text: '',
    },
    resetFilters: jest.fn(),
    appliedFiltersKey: '',
    groupBy: 'state',
    setGroupBy: jest.fn(),
    groupedItems: opts.groups,
    showEmptyGroups: true,
    setShowEmptyGroups: jest.fn(),
    stateFor: (item) => (item.stateId === 'st-1' ? state() : undefined),
    projectFor: () => undefined,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(listAgentAssignments).mockResolvedValue([]);
  jest.mocked(listAgents).mockResolvedValue([]);
  jest.mocked(listLabels).mockResolvedValue([]);
  jest.mocked(listMembers).mockResolvedValue([]);
  jest.mocked(listStates).mockResolvedValue([state()]);
  jest.mocked(listTickets).mockResolvedValue([]);
});

describe('BoardView epic badge (finding 2b)', () => {
  it('shows an accent-toned "Epic · done/total" badge on a card with sub-items', async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [parent] }];
    const subItemCountByParent = new Map([['parent', { total: 2, done: 1 }]]);

    render(<BoardView view={fakeView({ items: [parent], groups, subItemCountByParent })} projectId="proj-1" onOpenItem={jest.fn()} />);

    const badge = await screen.findByText('Epic · 1/2');
    expect(badge.closest('span')?.className).toContain('bg-accent-soft-bg');
  });
});

describe('BoardView parent chip (finding 2c)', () => {
  it("shows the parent's identifier on a child card", async () => {
    const parent = ticket({ id: 'parent', identifier: 'ROAD-2' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [child] }];
    const parentById = new Map([['child', parent]]);

    render(<BoardView view={fakeView({ items: [child], groups, parentById })} projectId="proj-1" onOpenItem={jest.fn()} />);

    const glyph = await screen.findByText('↳');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    const chip = glyph.closest('span.inline-flex');
    expect(chip).toHaveTextContent('Parent');
    expect(chip).toHaveTextContent('ROAD-2');
  });

  it('renders no parent chip for a card with no parent', async () => {
    const item = ticket({ id: 'a', identifier: 'CW-1', parentId: null });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [item] }];

    render(<BoardView view={fakeView({ items: [item], groups })} projectId="proj-1" onOpenItem={jest.fn()} />);

    await screen.findByText('CW-1');
    expect(screen.queryByText('↳')).not.toBeInTheDocument();
  });
});

describe('BoardView same-group nesting (finding 2e)', () => {
  it('indents a nested child card and marks its connector glyph decorative', async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [parent, child] }];
    const nestedChildIds = new Set(['child']);

    render(
      <BoardView
        view={fakeView({ items: [parent, child], groups, nestedChildIds })}
        projectId="proj-1"
        onOpenItem={jest.fn()}
      />,
    );

    const childCard = (await screen.findByText('CW-2')).closest('button') as HTMLElement;
    expect(childCard.className).toContain('ml-3');
    const glyph = screen.getByText('↳');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');

    // No separate "Parent" chip when nested — the indent is the pointer.
    expect(screen.queryByText('Parent CW-1', { exact: false })).not.toBeInTheDocument();
  });

  it('does not indent a card whose parent is in a different group (no entry in nestedChildIds)', async () => {
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [child] }];
    const parentById = new Map([['child', ticket({ id: 'parent', identifier: 'CW-1' })]]);

    render(
      <BoardView
        view={fakeView({ items: [child], groups, parentById })}
        projectId="proj-1"
        onOpenItem={jest.fn()}
      />,
    );

    const childCard = (await screen.findByText('CW-2')).closest('button') as HTMLElement;
    expect(childCard.className).not.toContain('ml-3');
  });
});

describe('BoardView description preview (finding 4)', () => {
  it('shows a two-line-clamped description preview on the card when present', async () => {
    const item = ticket({ id: 'a', identifier: 'CW-1', description: 'Cards need more context' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [item] }];

    render(<BoardView view={fakeView({ items: [item], groups })} projectId="proj-1" onOpenItem={jest.fn()} />);

    expect(await screen.findByText('Cards need more context')).toBeInTheDocument();
  });

  it('renders no preview when the card has no description', async () => {
    const item = ticket({ id: 'a', identifier: 'CW-1', description: '' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [item] }];

    render(<BoardView view={fakeView({ items: [item], groups })} projectId="proj-1" onOpenItem={jest.fn()} />);

    await screen.findByText('CW-1');
    expect(document.querySelectorAll('.line-clamp-2.text-text-muted').length).toBe(0);
  });
});

describe('BoardView priority border (finding 5)', () => {
  it('gives a non-none priority card a colored left border', async () => {
    const item = ticket({ id: 'a', identifier: 'CW-1', priority: 'urgent' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [item] }];

    render(<BoardView view={fakeView({ items: [item], groups })} projectId="proj-1" onOpenItem={jest.fn()} />);

    // jsdom's CSSOM silently drops a `var(--x)` inline color value, so the
    // border's actual color can't be asserted here — only the border-l-2
    // class that turns the accent on (see TicketList.test.tsx's identical
    // note).
    const card = (await screen.findByText('CW-1')).closest('button') as HTMLElement;
    expect(card.className).toContain('border-l-2');
  });

  it('renders no accent border for "none" priority', async () => {
    const item = ticket({ id: 'a', identifier: 'CW-1', priority: 'none' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [item] }];

    render(<BoardView view={fakeView({ items: [item], groups })} projectId="proj-1" onOpenItem={jest.fn()} />);

    const card = (await screen.findByText('CW-1')).closest('button') as HTMLElement;
    expect(card.className).not.toContain('border-l-2');
  });
});
