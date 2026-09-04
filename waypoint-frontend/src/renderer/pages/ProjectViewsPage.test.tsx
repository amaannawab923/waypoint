import '@testing-library/jest-dom';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  createView,
  deleteView,
  listAgentAssignments,
  listAgents,
  listAllSprints,
  listAllWorkstreams,
  listLabels,
  listMembers,
  listProjects,
  listSprints,
  listStates,
  listTickets,
  listViews,
  listWorkstreams,
  updateTicket,
  updateView,
} from '@/data/api';
import { useProject } from '@/layouts/ProjectLayout';
import type { Member, Project, SavedView, TicketState } from '@/types/entities';
import ProjectViewsPage from './ProjectViewsPage';

// W5.3's own accept-criterion coverage for the EDITING half of the
// saved-view filter editor: opening an existing view, changing its filter
// through the same toolbar controls the live ticket list uses, and saving
// must PATCH the view with a real, typed, non-empty filter — never `{}` —
// and the "Save changes" action must stay disabled until there's an actual
// edit to persist.
jest.mock('@/data/api', () => ({
  createView: jest.fn(),
  deleteView: jest.fn(),
  listAgentAssignments: jest.fn(),
  listAgents: jest.fn(),
  listAllSprints: jest.fn(),
  listAllWorkstreams: jest.fn(),
  listLabels: jest.fn(),
  listMembers: jest.fn(),
  listProjects: jest.fn(),
  listSprints: jest.fn(),
  listStates: jest.fn(),
  listTickets: jest.fn(),
  listViews: jest.fn(),
  listWorkstreams: jest.fn(),
  updateTicket: jest.fn(),
  updateView: jest.fn(),
}));
jest.mock('@/layouts/ProjectLayout', () => ({ useProject: jest.fn() }));
jest.mock('@/lib/projectsStore', () => ({ refreshProjectInStore: jest.fn() }));

const PROJECT: Project = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Launch',
  identifier: 'LAUNCH',
  description: '',
  icon: '📦',
  coverGradient: ['#c2542a', '#3a2314'],
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
  memberIds: ['mem-1'],
  guestAccessEnabled: false,
  repoPath: null,
  primitiveCounts: {
    sprints: 0,
    workstreams: 0,
    views: 1,
    docs: 0,
    requests: 0,
    requestsPending: 0,
  },
  acceptsRequests: true,
};

const MEMBER: Member = {
  id: 'mem-1',
  workspaceId: 'ws-1',
  fullName: 'Priya Sharma',
  displayName: 'Priya',
  email: 'priya@example.com',
  avatarColor: '#123456',
  role: 'member',
  authMethod: 'email',
  joinedAt: new Date().toISOString(),
};

function savedView(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: 'view-1',
    projectId: 'proj-1',
    name: 'Urgent tickets',
    ownerId: 'mem-1',
    filters: { v: 1, projectIds: ['proj-1'], priorities: ['urgent'] },
    visibility: 'public',
    isFavorite: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
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

function mount(views: SavedView[]) {
  jest
    .mocked(useProject)
    .mockReturnValue({ project: PROJECT, reloadProject: jest.fn() });
  jest.mocked(listViews).mockResolvedValue(views);
  jest.mocked(listMembers).mockResolvedValue([MEMBER]);
  jest.mocked(listTickets).mockResolvedValue([]);
  jest.mocked(listStates).mockResolvedValue([state()]);
  jest.mocked(listLabels).mockResolvedValue([]);
  jest.mocked(listWorkstreams).mockResolvedValue([]);
  jest.mocked(listAllWorkstreams).mockResolvedValue([]);
  jest.mocked(listSprints).mockResolvedValue([]);
  jest.mocked(listAllSprints).mockResolvedValue([]);
  jest.mocked(listProjects).mockResolvedValue([PROJECT]);
  jest.mocked(listAgents).mockResolvedValue([]);
  jest.mocked(listAgentAssignments).mockResolvedValue([]);
  jest.mocked(updateTicket).mockResolvedValue({} as never);
  jest.mocked(createView).mockResolvedValue(savedView());
  jest.mocked(deleteView).mockResolvedValue(undefined);
  jest.mocked(updateView).mockImplementation(async (id, patch) => ({
    ...savedView({ id }),
    ...patch,
  }));

  return render(
    <MemoryRouter>
      <ProjectViewsPage />
    </MemoryRouter>,
  );
}

describe('ProjectViewsPage saved-view filter editor', () => {
  beforeEach(() => jest.clearAllMocks());

  it('opens an existing view with "Save changes" disabled until the filter actually changes', async () => {
    mount([savedView()]);

    fireEvent.click(await screen.findByText('Urgent tickets'));
    const saveChanges = await screen.findByRole('button', {
      name: /save changes/i,
    });
    expect(saveChanges).toBeDisabled();
  });

  it('editing the filter through the reused toolbar and saving PATCHes the view with a real, non-empty filter', async () => {
    mount([savedView()]);

    fireEvent.click(await screen.findByText('Urgent tickets'));
    const saveChanges = await screen.findByRole('button', {
      name: /save changes/i,
    });
    expect(saveChanges).toBeDisabled();

    // Open the Filters popover (reused straight from TicketListToolbar) and
    // check "Todo" state on top of the view's existing 'urgent' priority
    // filter — a real edit, not a no-op.
    fireEvent.click(screen.getByText('Filters'));
    const stateCheckbox = await screen.findByRole('checkbox', {
      name: /todo/i,
    });
    fireEvent.click(stateCheckbox);

    await waitFor(() => expect(saveChanges).not.toBeDisabled());
    fireEvent.click(saveChanges);

    await waitFor(() => expect(updateView).toHaveBeenCalledTimes(1));
    const [id, patch] = jest.mocked(updateView).mock.calls[0];
    expect(id).toBe('view-1');
    // The accept criterion, exercised on the update path: never `{}`, and
    // it must be the real typed filter — priority preserved, state added,
    // project scope preserved.
    expect(patch.filters).not.toEqual({});
    expect(patch.filters).toEqual({
      v: 1,
      projectIds: ['proj-1'],
      priorities: ['urgent'],
      stateIds: ['st-1'],
    });
  });

  it('editing a view whose only predicate is its project scope still keeps that scope on save', async () => {
    // A view with no extra filters at all beyond `projectIds` — editing it
    // (adding one real filter) and saving must still carry `projectIds`
    // forward rather than collapsing to `{}` or `{ v: 1 }` alone.
    mount([savedView({ filters: { v: 1, projectIds: ['proj-1'] } })]);

    fireEvent.click(await screen.findByText('Urgent tickets'));
    fireEvent.click(screen.getByText('Filters'));
    const stateCheckbox = await screen.findByRole('checkbox', {
      name: /todo/i,
    });
    fireEvent.click(stateCheckbox);

    const saveChanges = await screen.findByRole('button', {
      name: /save changes/i,
    });
    await waitFor(() => expect(saveChanges).not.toBeDisabled());
    fireEvent.click(saveChanges);

    await waitFor(() => expect(updateView).toHaveBeenCalledTimes(1));
    const [, patch] = jest.mocked(updateView).mock.calls[0];
    expect(patch.filters).not.toEqual({});
    expect(patch.filters).toEqual({
      v: 1,
      projectIds: ['proj-1'],
      stateIds: ['st-1'],
    });
  });
});

describe('ProjectViewsPage "Add view" and duplicate never save an empty filter', () => {
  beforeEach(() => jest.clearAllMocks());

  it('"Add view" creates a real, project-scoped baseline filter, not {}', async () => {
    mount([]);

    fireEvent.click(await screen.findByText('Add view'));
    const dialog = await screen.findByRole('dialog', {
      name: /name this view/i,
    });
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'New view' },
    });
    fireEvent.click(within(dialog).getByText('Create'));

    await waitFor(() => expect(createView).toHaveBeenCalledTimes(1));
    const [, , filters] = jest.mocked(createView).mock.calls[0];
    expect(filters).not.toEqual({});
    expect(filters).toEqual({ v: 1, projectIds: ['proj-1'] });
  });

  it('"Duplicate" copies the source view\'s already-real filter, not {}', async () => {
    mount([savedView()]);
    await screen.findByText('Urgent tickets');

    fireEvent.click(screen.getByLabelText('View actions'));
    fireEvent.click(screen.getByText('Duplicate'));

    await waitFor(() => expect(createView).toHaveBeenCalledTimes(1));
    const [, name, filters] = jest.mocked(createView).mock.calls[0];
    expect(name).toBe('Urgent tickets copy');
    expect(filters).not.toEqual({});
    expect(filters).toEqual({
      v: 1,
      projectIds: ['proj-1'],
      priorities: ['urgent'],
    });
  });
});
