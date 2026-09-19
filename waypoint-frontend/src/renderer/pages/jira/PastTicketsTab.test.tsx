import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { listPastJiraTickets } from '@/data/jiraApi';
import { JiraApiError } from '@/types/jira';
import type { JiraTicket, JiraTruncation } from '@/types/jira';
import PastTicketsTab from './PastTicketsTab';

// PastTicketsTab pulls in JiraTicketRow and JiraTicketDrawer, both of which
// import their own slice of data/jiraApi — mocking the whole module here
// (rather than per-component) is what makes it possible to render the real
// component tree, same reasoning as RoleTicketsTab.test.tsx's own mock.
jest.mock('@/data/jiraApi', () => ({
  listPastJiraTickets: jest.fn(),
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

const queueRead = (
  tickets: JiraTicket[],
  truncated: JiraTruncation = false,
) => ({
  tickets,
  truncated,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PastTicketsTab', () => {
  it('renders the tickets the WAS-based read returns', async () => {
    jest
      .mocked(listPastJiraTickets)
      .mockResolvedValue(
        queueRead([ticket({ title: 'Rate limiter double-counts retries' })]),
      );

    render(<PastTicketsTab />);

    expect(
      await screen.findByText('Rate limiter double-counts retries'),
    ).toBeInTheDocument();
  });

  it('shows the empty state when nothing was ever reassigned away', async () => {
    jest.mocked(listPastJiraTickets).mockResolvedValue(queueRead([]));

    render(<PastTicketsTab />);

    expect(
      await screen.findByText('Nothing was ever reassigned away from you.'),
    ).toBeInTheDocument();
  });

  it('reports the ticket count via onCountChange', async () => {
    jest.mocked(listPastJiraTickets).mockResolvedValue(queueRead([ticket()]));
    const onCountChange = jest.fn();

    render(<PastTicketsTab onCountChange={onCountChange} />);

    await screen.findByText('A ticket');
    expect(onCountChange).toHaveBeenLastCalledWith(1);
  });

  it('shows a load error, not the empty-state copy, for a genuine failure', async () => {
    jest
      .mocked(listPastJiraTickets)
      .mockRejectedValue(
        new JiraApiError('Jira is rate-limiting this account.', 'jira_error'),
      );

    render(<PastTicketsTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Jira is rate-limiting this account.',
    );
    expect(
      screen.queryByText('Nothing was ever reassigned away from you.'),
    ).not.toBeInTheDocument();
  });
});
