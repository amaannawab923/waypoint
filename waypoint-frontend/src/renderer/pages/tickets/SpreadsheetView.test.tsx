import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { listMembers } from '@/data/api';
import { useProject } from '@/layouts/ProjectLayout';
import type { Project, Ticket } from '@/types/entities';
import type { TicketsView } from './useTicketsView';
import SpreadsheetView from './SpreadsheetView';

// First-ever coverage for this file (waypoint-revamp ticket-UX pass):
// covers the new "Points" column sourced from estimatePoints (finding 7b)
// and the default sort direction flip from newest-first to ascending
// (polish item 2) — not a full sweep of every existing column.
jest.mock('@/data/api', () => ({ listMembers: jest.fn() }));
jest.mock('@/layouts/ProjectLayout', () => ({ useProject: jest.fn() }));

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    workspaceId: 'ws-1',
    name: 'Compass Web',
    identifier: 'CW',
    description: '',
    icon: '🧭',
    coverGradient: ['#111', '#222'],
    visibility: 'public',
    leadId: null,
    defaultAssigneeId: null,
    timezone: 'UTC',
    estimate: null,
    automations: {
      autoArchiveEnabled: false,
      autoArchiveAfterDays: 30,
      autoCloseEnabled: false,
      autoCloseAfterDays: 30,
    },
    createdAt: new Date().toISOString(),
    archivedAt: null,
    memberIds: [],
    guestAccessEnabled: false,
    repoPath: null,
    primitiveCounts: { sprints: 0, workstreams: 0, views: 0, docs: 0, requests: 0, requestsPending: 0 },
    acceptsRequests: false,
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

function fakeView(items: Ticket[]): TicketsView {
  return {
    projectId: 'proj-1',
    items,
    allItems: items,
    subItemCountByParent: new Map(),
    parentById: new Map(),
    nestedChildIds: new Set(),
    nestedDescendantCountByParent: new Map(),
    loading: false,
    isRefetching: false,
    reload: jest.fn(),
    patchItemLocally: jest.fn(),
    reorderItemLocally: jest.fn(),
    states: [],
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
    groupedItems: [],
    showEmptyGroups: true,
    setShowEmptyGroups: jest.fn(),
    collapsedParents: new Set(),
    toggleParentCollapsed: jest.fn(),
    stateFor: () => undefined,
    projectFor: () => undefined,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(listMembers).mockResolvedValue([]);
  jest.mocked(useProject).mockReturnValue({ project: project(), reloadProject: jest.fn() });
});

describe('SpreadsheetView default sort (polish item 2)', () => {
  it('sorts ascending by default, not newest-first', async () => {
    const older = ticket({ id: 'a', identifier: 'CW-1', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = ticket({ id: 'b', identifier: 'CW-2', createdAt: '2026-01-05T00:00:00.000Z' });

    render(<SpreadsheetView view={fakeView([newer, older])} onOpenItem={jest.fn()} />);

    const rows = await screen.findAllByText(/CW-\d/);
    expect(rows.map((r) => r.textContent)).toEqual(['CW-1', 'CW-2']);
  });
});

describe('SpreadsheetView Points column (finding 7b)', () => {
  it('is offered in the Columns menu even when the project has no configured estimate system', async () => {
    render(<SpreadsheetView view={fakeView([ticket()])} onOpenItem={jest.fn()} />);

    await screen.findByText('CW-1');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));

    expect(screen.getByText('Points')).toBeInTheDocument();
    // "Estimate" is the OTHER optional column, gated on project.estimate —
    // this fakeView's project() fixture has estimate: null, so it must be
    // absent while Points (ungated) is present.
    expect(screen.queryByText('Estimate')).not.toBeInTheDocument();
  });

  it('sorts numerically by estimatePoints, not lexicographically', async () => {
    const low = ticket({ id: 'a', identifier: 'CW-1', estimatePoints: 2 });
    const high = ticket({ id: 'b', identifier: 'CW-2', estimatePoints: 13 });
    const none = ticket({ id: 'c', identifier: 'CW-3', estimatePoints: null });

    render(<SpreadsheetView view={fakeView([high, none, low])} onOpenItem={jest.fn()} />);

    await screen.findByText('CW-1');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(screen.getByText('Points'));

    // Ascending (the default, per polish item 2 above): the null-estimate
    // ticket sorts first (?? -Infinity), then 2, then 13 — a
    // localeCompare-based sort would instead read "13" as less than "2".
    fireEvent.click(screen.getByRole('button', { name: /Points/ }));

    const rows = await screen.findAllByText(/CW-\d/);
    expect(rows.map((r) => r.textContent)).toEqual(['CW-3', 'CW-1', 'CW-2']);
  });

  it('renders an em dash for a ticket with no estimatePoints', async () => {
    render(<SpreadsheetView view={fakeView([ticket({ id: 'a', identifier: 'CW-1', estimatePoints: null })])} onOpenItem={jest.fn()} />);

    await screen.findByText('CW-1');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(screen.getByText('Points'));

    const row = (await screen.findByText('CW-1')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('—');
  });
});

