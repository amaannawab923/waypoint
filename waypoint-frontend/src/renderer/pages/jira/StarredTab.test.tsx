import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { listTicketsByJiraKeys } from '@/data/jiraApi';
import { useJiraStarredKeys } from '@/lib/jiraStarred';
import type { JiraTicket } from '@/types/jira';
import StarredTab from './StarredTab';

// StarredTab pulls in JiraTicketRow and JiraTicketDrawer, both of which
// import their own slice of data/jiraApi — mocking the whole module here
// (rather than per-component) is what makes it possible to render the real
// component tree, same reasoning as RoleTicketsTab.test.tsx's own mock.
jest.mock('@/data/jiraApi', () => ({
  listTicketsByJiraKeys: jest.fn(),
  getJiraTransitions: jest.fn(async () => []),
  transitionJiraTicket: jest.fn(),
  getJiraPriorityOptions: jest.fn(),
  setJiraTicketPriority: jest.fn(),
  searchJiraAssignableUsers: jest.fn(),
  setJiraTicketAssignee: jest.fn(),
  listJiraComments: jest.fn(async () => ({ comments: [], total: 0 })),
  postJiraComment: jest.fn(),
  prepareJiraCommentEdit: jest.fn(),
  updateJiraComment: jest.fn(),
  deleteJiraComment: jest.fn(async () => undefined),
  getJiraComment: jest.fn(async () => null),
  getJiraCommentPermissions: jest.fn(async () => ({
    deleteAll: false,
    deleteOwn: false,
    editAll: false,
    editOwn: false,
  })),
  buildJiraCommentPermalink: jest.fn(
    () => 'https://example.invalid/browse/ENG-1?focusedCommentId=1',
  ),
}));
jest.mock('@/lib/jiraStore', () => ({
  useLoadedJiraConnection: jest.fn(() => undefined),
  useJiraConnection: jest.fn(() => undefined),
}));
jest.mock('@/lib/jiraStarred', () => ({
  useJiraStarredKeys: jest.fn(),
  useJiraStarred: jest.fn(() => false),
  toggleJiraStarred: jest.fn(),
}));

function ticket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return {
    id: 'jira-t1',
    key: 'ENG-1',
    projectKey: 'ENG',
    title: 'A ticket',
    role: 'assignee',
    stateName: 'To Do',
    stateColor: 'var(--text-muted)',
    priority: 'none',
    priorityId: null,
    priorityName: 'None',
    assigneeName: 'Max Chen',
    assigneeAccountId: '5f8a',
    reporterName: 'Sam Lee',
    description: '',
    epicName: null,
    storyPoints: null,
    sprintName: null,
    updatedAt: '2026-09-01T10:00:00.000Z',
    labels: [],
    dueDate: null,
    subtasks: [],
    links: [],
    descriptionAdf: null,
    attachments: [],
    isTombstoned: false,
    tombstone: null,
    hasConflict: false,
    conflict: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('StarredTab', () => {
  it('resolves the starred keys into real ticket rows', async () => {
    jest.mocked(useJiraStarredKeys).mockReturnValue(['ENG-1', 'PLAT-2']);
    jest
      .mocked(listTicketsByJiraKeys)
      .mockResolvedValue([
        ticket({ title: 'Write integration tests for webhook receiver' }),
      ]);

    render(<StarredTab />);

    expect(
      await screen.findByText('Write integration tests for webhook receiver'),
    ).toBeInTheDocument();
    expect(listTicketsByJiraKeys).toHaveBeenCalledWith(['ENG-1', 'PLAT-2']);
  });

  it('shows the empty state with nothing starred, without calling the bridge', async () => {
    jest.mocked(useJiraStarredKeys).mockReturnValue([]);

    render(<StarredTab />);

    expect(await screen.findByText('Nothing starred yet.')).toBeInTheDocument();
    expect(listTicketsByJiraKeys).not.toHaveBeenCalled();
  });

  it('reports the ticket count via onCountChange', async () => {
    jest.mocked(useJiraStarredKeys).mockReturnValue(['ENG-1']);
    jest.mocked(listTicketsByJiraKeys).mockResolvedValue([ticket()]);
    const onCountChange = jest.fn();

    render(<StarredTab onCountChange={onCountChange} />);

    await screen.findByText('A ticket');
    expect(onCountChange).toHaveBeenLastCalledWith(1);
  });
});
