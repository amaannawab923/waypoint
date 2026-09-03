import '@testing-library/jest-dom';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createView } from '@/data/api';
import { refreshProjectInStore } from '@/lib/projectsStore';
import type { TicketState } from '@/types/entities';
import TicketListToolbar, {
  captureSavedViewFilter,
  PROJECT_GROUP_BY_OPTIONS,
} from './TicketListToolbar';
import { EMPTY_FILTERS, type TicketsView } from './useTicketsView';

// W5.3's own accept-criterion coverage: "Save as view" must never call
// createView with `{}` or an equivalent empty/meaningless filter, even when
// the user has set no extra filters at all. Also covers the scoping
// decision (TicketListToolbar.tsx's own doc comment): the action only
// renders in project scope (`view.projectId` set), not workspace scope or
// YourWork's tabs.
jest.mock('@/data/api', () => ({
  createView: jest.fn(),
}));
jest.mock('@/lib/projectsStore', () => ({
  refreshProjectInStore: jest.fn(),
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

// A minimal stand-in for useTicketsView's return shape — only the fields
// TicketListToolbar actually reads. Filters are fixed per test (not driven
// through the checkboxes) since these tests are about what "Save as view"
// captures and calls, not about the group/filter popovers themselves
// (already covered by exercising the real hook elsewhere).
function makeView(overrides: Partial<TicketsView> = {}): TicketsView {
  return {
    projectId: 'proj-1',
    items: [],
    allItems: [],
    loading: false,
    reload: jest.fn(),
    patchItemLocally: jest.fn(),
    reorderItemLocally: jest.fn(),
    states: [state()],
    labels: [],
    workstreams: [],
    sprints: [],
    projects: [],
    filters: EMPTY_FILTERS,
    setFilters: jest.fn(),
    groupBy: 'state',
    setGroupBy: jest.fn(),
    groupedItems: [],
    showEmptyGroups: true,
    setShowEmptyGroups: jest.fn(),
    stateFor: jest.fn(),
    projectFor: jest.fn(),
    ...overrides,
  } as unknown as TicketsView;
}

describe('captureSavedViewFilter', () => {
  it('never produces an empty filter, even from all-empty TicketFilters', () => {
    expect(captureSavedViewFilter(EMPTY_FILTERS, 'proj-1')).toEqual({
      v: 1,
      projectIds: ['proj-1'],
    });
  });

  it('folds the live filters in on top of the project scope', () => {
    expect(
      captureSavedViewFilter(
        {
          ...EMPTY_FILTERS,
          priority: ['urgent', 'high'],
          text: 'race condition',
        },
        'proj-1',
      ),
    ).toEqual({
      v: 1,
      projectIds: ['proj-1'],
      priorities: ['urgent', 'high'],
      text: 'race condition',
    });
  });
});

describe('TicketListToolbar "Save as view"', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(createView).mockResolvedValue({} as never);
  });

  it('does not render when the view has no projectId (workspace/YourWork scope)', () => {
    render(
      <TicketListToolbar
        view={makeView({ projectId: undefined })}
        groupByOptions={PROJECT_GROUP_BY_OPTIONS}
      />,
    );
    expect(screen.queryByText('Save as view')).not.toBeInTheDocument();
  });

  it('renders in project scope and captures a real, non-empty filter on save', async () => {
    render(
      <TicketListToolbar
        view={makeView({ projectId: 'proj-1', filters: EMPTY_FILTERS })}
        groupByOptions={PROJECT_GROUP_BY_OPTIONS}
      />,
    );

    fireEvent.click(screen.getByText('Save as view'));
    const dialog = await screen.findByRole('dialog', { name: 'Save as view' });
    const nameInput = within(dialog).getByRole('textbox');
    fireEvent.change(nameInput, { target: { value: 'My saved view' } });
    fireEvent.click(within(dialog).getByText('Save'));

    await waitFor(() => expect(createView).toHaveBeenCalledTimes(1));
    const [projectId, name, filters] = jest.mocked(createView).mock.calls[0];
    expect(projectId).toBe('proj-1');
    expect(name).toBe('My saved view');
    // The accept criterion, exercised end to end: never `{}`.
    expect(filters).not.toEqual({});
    expect(filters).toEqual({ v: 1, projectIds: ['proj-1'] });
    expect(refreshProjectInStore).toHaveBeenCalledWith('proj-1');
  });

  it('captures the live priority/text filters into the typed shape when saving', async () => {
    const filters = {
      ...EMPTY_FILTERS,
      priority: ['urgent' as const],
      text: 'flaky test',
    };
    render(
      <TicketListToolbar
        view={makeView({ projectId: 'proj-1', filters })}
        groupByOptions={PROJECT_GROUP_BY_OPTIONS}
      />,
    );

    fireEvent.click(screen.getByText('Save as view'));
    const dialog = await screen.findByRole('dialog', { name: 'Save as view' });
    const nameInput = within(dialog).getByRole('textbox');
    fireEvent.change(nameInput, { target: { value: 'Urgent flaky tests' } });
    fireEvent.click(within(dialog).getByText('Save'));

    await waitFor(() => expect(createView).toHaveBeenCalledTimes(1));
    expect(createView).toHaveBeenCalledWith('proj-1', 'Urgent flaky tests', {
      v: 1,
      projectIds: ['proj-1'],
      priorities: ['urgent'],
      text: 'flaky test',
    });
  });
});
