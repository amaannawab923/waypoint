import '@testing-library/jest-dom';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import {
  listAgentAssignments,
  listAgents,
  listLabels,
  listMembers,
  listStates,
  listTickets,
  reorderTicket,
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
  jest.mocked(reorderTicket).mockResolvedValue({} as Ticket);
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

  // M1: mirrors TicketList.test.tsx's coverage of the same gap — the
  // aria-hidden glyph alone gave a screen-reader user no signal that this
  // card has a parent.
  it("exposes an sr-only \"Subtask of <parent identifier>\" label on a nested card", async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [parent, child] }];
    const nestedChildIds = new Set(['child']);
    const parentById = new Map([['child', parent]]);

    render(
      <BoardView
        view={fakeView({ items: [parent, child], groups, nestedChildIds, parentById })}
        projectId="proj-1"
        onOpenItem={jest.fn()}
      />,
    );

    await screen.findByText('CW-2');
    expect(screen.getByText('Subtask of CW-1')).toBeInTheDocument();
    expect(screen.getByText('Subtask of CW-1')).toHaveClass('sr-only');
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

// H2: dropping between an already-adjacent nested parent/child pair used to
// be a silent no-op — the same-group nesting resort always re-splices a
// nested child directly after its parent regardless of where the drop
// tried to insert something, so the rendered order snapped right back even
// though reorderTicket had already told the server the move happened. Since
// a full "insert between nested parent/child" reorder is out of scope for
// this pass, the fix suppresses the drop-indicator (and refuses the drop)
// at exactly that boundary, so the UI never implies a drop there will do
// anything.
//
// jsdom's getBoundingClientRect returns an all-zero rect for every element,
// so `clientY < 0` reliably yields 'before' and `clientY > 0` reliably
// yields 'after' here, regardless of which card is targeted — but jsdom's
// DragEvent does NOT pick up `clientY` from fireEvent's init dict (it comes
// back `undefined`, silently always yielding 'after'), so these tests build
// the event via `createEvent.dragOver` and set `clientY` directly on it
// before dispatching.
function dragOverWithClientY(el: HTMLElement, clientY: number) {
  const event = createEvent.dragOver(el);
  Object.defineProperty(event, 'clientY', { value: clientY, configurable: true });
  fireEvent(el, event);
}

describe('BoardView drag-over boundary suppression (H2)', () => {
  const parent = ticket({ id: 'parent', identifier: 'CW-1' });
  const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent' });
  const other = ticket({ id: 'other', identifier: 'CW-3' });

  function renderBoard() {
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [parent, child, other] }];
    const nestedChildIds = new Set(['child']);
    return render(
      <BoardView
        view={fakeView({ items: [parent, child, other], groups, nestedChildIds })}
        projectId="proj-1"
        onOpenItem={jest.fn()}
      />,
    );
  }

  it('shows no drop indicator dropping "other" AFTER "parent" (parent/child boundary, from the parent side)', async () => {
    renderBoard();
    const parentCard = (await screen.findByText('CW-1')).closest('button') as HTMLElement;
    const otherCard = (await screen.findByText('CW-3')).closest('button') as HTMLElement;

    fireEvent.dragStart(otherCard);
    dragOverWithClientY(parentCard, 10); // 'after'

    expect(parentCard.className).not.toContain('border-b-2');
    expect(parentCard.className).not.toContain('border-t-2');
  });

  it('shows no drop indicator dropping "other" BEFORE "child" (same boundary, from the child side)', async () => {
    renderBoard();
    const childCard = (await screen.findByText('CW-2')).closest('button') as HTMLElement;
    const otherCard = (await screen.findByText('CW-3')).closest('button') as HTMLElement;

    fireEvent.dragStart(otherCard);
    dragOverWithClientY(childCard, -10); // 'before'

    expect(childCard.className).not.toContain('border-t-2');
    expect(childCard.className).not.toContain('border-b-2');
  });

  it('still shows the indicator for a non-boundary drop (after "child", which has no nested child of its own)', async () => {
    renderBoard();
    const childCard = (await screen.findByText('CW-2')).closest('button') as HTMLElement;
    const otherCard = (await screen.findByText('CW-3')).closest('button') as HTMLElement;

    fireEvent.dragStart(otherCard);
    dragOverWithClientY(childCard, 10); // 'after' — not a boundary

    expect(childCard.className).toContain('border-b-2');
  });

  it('still shows the indicator for a non-boundary drop (before "parent", the first card in the column)', async () => {
    renderBoard();
    const parentCard = (await screen.findByText('CW-1')).closest('button') as HTMLElement;
    const otherCard = (await screen.findByText('CW-3')).closest('button') as HTMLElement;

    fireEvent.dragStart(otherCard);
    dragOverWithClientY(parentCard, -10); // 'before' — not a boundary

    expect(parentCard.className).toContain('border-t-2');
  });
});

// Bugs 1-3 (code review follow-up on 54e9e6b): the H2 boundary tests above
// only ever asserted that the drop *indicator* was suppressed — they never
// checked whether the drop itself was actually blocked. That gap is exactly
// why three real bugs shipped: (1) the card-level onDragOver refusal branch
// didn't call e.stopPropagation(), so the bubbled column-level onDragOver
// still called e.preventDefault() unconditionally and the browser still
// allowed the drop; (2) with dragOverCard nulled at a refused boundary,
// handleCardDrop's `dragOverCard?.position ?? 'after'` fallback silently
// reinterpreted a 'before' drop as 'after' and persisted THAT instead; (3)
// the boundary predicate only ever compared an item against its immediate
// prevItem/nextItem's parentId, so a gap between two siblings under the same
// parent (or any other non-adjacent pair inside one subtree) wasn't refused
// at all. Every test below asserts the actual persisted side effect
// (reorderTicket), not just a CSS class.
function dropWithClientY(el: HTMLElement, clientY: number) {
  const event = createEvent.drop(el);
  Object.defineProperty(event, 'clientY', { value: clientY, configurable: true });
  fireEvent(el, event);
}

describe('BoardView drag-drop boundary refusal actually blocks the drop (bugs 1-3)', () => {
  it('bug 1: does not call reorderTicket when dropped at the direct parent/child boundary', async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent' });
    const other = ticket({ id: 'other', identifier: 'CW-3' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [parent, child, other] }];
    const nestedChildIds = new Set(['child']);
    render(
      <BoardView
        view={fakeView({ items: [parent, child, other], groups, nestedChildIds })}
        projectId="proj-1"
        onOpenItem={jest.fn()}
      />,
    );
    const parentCard = (await screen.findByText('CW-1')).closest('button') as HTMLElement;
    const otherCard = (await screen.findByText('CW-3')).closest('button') as HTMLElement;

    fireEvent.dragStart(otherCard);
    dropWithClientY(parentCard, 10); // 'after' parent — the parent/child boundary

    expect(reorderTicket).not.toHaveBeenCalled();
  });

  it('bug 1: a refused boundary drag-over calls stopPropagation, so the bubbled column handler never preventDefaults', async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent' });
    const other = ticket({ id: 'other', identifier: 'CW-3' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [parent, child, other] }];
    const nestedChildIds = new Set(['child']);
    render(
      <BoardView
        view={fakeView({ items: [parent, child, other], groups, nestedChildIds })}
        projectId="proj-1"
        onOpenItem={jest.fn()}
      />,
    );
    const parentCard = (await screen.findByText('CW-1')).closest('button') as HTMLElement;
    const otherCard = (await screen.findByText('CW-3')).closest('button') as HTMLElement;

    fireEvent.dragStart(otherCard);
    const event = createEvent.dragOver(parentCard);
    Object.defineProperty(event, 'clientY', { value: 10, configurable: true });
    fireEvent(parentCard, event);

    // The column-level onDragOver (which bubbled events would reach) calls
    // e.preventDefault() unconditionally — so this only stays false if the
    // card-level handler's refusal branch stopped the event from bubbling.
    expect(event.defaultPrevented).toBe(false);
  });

  it('bug 3: does not call reorderTicket when dropped between two siblings inside the same subtree (a,b,c nested)', async () => {
    const a = ticket({ id: 'a', identifier: 'CW-1' });
    const b = ticket({ id: 'b', identifier: 'CW-2', parentId: 'a' });
    const c = ticket({ id: 'c', identifier: 'CW-3', parentId: 'a' });
    const other = ticket({ id: 'other', identifier: 'CW-4' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [a, b, c, other] }];
    const nestedChildIds = new Set(['b', 'c']);
    render(
      <BoardView
        view={fakeView({ items: [a, b, c, other], groups, nestedChildIds })}
        projectId="proj-1"
        onOpenItem={jest.fn()}
      />,
    );
    const bCard = (await screen.findByText('CW-2')).closest('button') as HTMLElement;
    const otherCard = (await screen.findByText('CW-4')).closest('button') as HTMLElement;

    fireEvent.dragStart(otherCard);
    dropWithClientY(bCard, 10); // 'after' b — between b and c, inside a's subtree

    expect(reorderTicket).not.toHaveBeenCalled();
  });

  it('false-positive check: still calls reorderTicket with the right args for a legitimate non-boundary drop', async () => {
    const parent = ticket({ id: 'parent', identifier: 'CW-1' });
    const child = ticket({ id: 'child', identifier: 'CW-2', parentId: 'parent' });
    const other = ticket({ id: 'other', identifier: 'CW-3' });
    const groups: TicketGroup[] = [{ key: 'st-1', label: 'Todo', items: [parent, child, other] }];
    const nestedChildIds = new Set(['child']);
    render(
      <BoardView
        view={fakeView({ items: [parent, child, other], groups, nestedChildIds })}
        projectId="proj-1"
        onOpenItem={jest.fn()}
      />,
    );
    const childCard = (await screen.findByText('CW-2')).closest('button') as HTMLElement;
    const otherCard = (await screen.findByText('CW-3')).closest('button') as HTMLElement;

    fireEvent.dragStart(otherCard);
    dropWithClientY(childCard, 10); // 'after' child — not a boundary (child has no child of its own)

    expect(reorderTicket).toHaveBeenCalledWith('other', 'child', 'after');
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
