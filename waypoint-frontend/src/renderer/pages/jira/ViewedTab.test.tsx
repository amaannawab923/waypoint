import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { listViewedJiraTickets } from '@/data/jiraApi';
import { JiraApiError } from '@/types/jira';
import type { JiraTicket, JiraTruncation } from '@/types/jira';
import ViewedTab from './ViewedTab';

// ViewedTab pulls in JiraTicketRow and JiraTicketDrawer, both of which
// import their own slice of data/jiraApi — mocking the whole module here
// (rather than per-component) is what makes it possible to render the real
// component tree, same reasoning as RoleTicketsTab.test.tsx's own mock.
jest.mock('@/data/jiraApi', () => ({
  listViewedJiraTickets: jest.fn(),
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

describe('ViewedTab', () => {
  it('renders the tickets the read returns', async () => {
    jest
      .mocked(listViewedJiraTickets)
      .mockResolvedValue(
        queueRead([ticket({ title: 'Billing pipeline logs credentials' })]),
      );

    render(<ViewedTab />);

    expect(
      await screen.findByText('Billing pipeline logs credentials'),
    ).toBeInTheDocument();
  });

  it('shows the empty state over a genuinely empty view history', async () => {
    jest.mocked(listViewedJiraTickets).mockResolvedValue(queueRead([]));

    render(<ViewedTab />);

    expect(
      await screen.findByText('Nothing in your Jira view history yet.'),
    ).toBeInTheDocument();
  });

  it('reports the ticket count via onCountChange', async () => {
    jest
      .mocked(listViewedJiraTickets)
      .mockResolvedValue(
        queueRead([ticket(), ticket({ id: 'jira-t2', key: 'ENG-2' })]),
      );
    const onCountChange = jest.fn();

    render(<ViewedTab onCountChange={onCountChange} />);

    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(2));
  });

  // Found in review: this tab's own read can come back truncated at Jira's
  // page cap (runTicketSearch's own MAX_PAGES × PAGE_SIZE crawl limit) the
  // same as RoleTicketsTab's role queries do — but unlike that tab, this one
  // silently dropped the flag on the floor, presenting a 500-issue prefix as
  // someone's WHOLE view history with no indication anything was cut off.
  it('shows the page-cap truncation banner when the read reports it', async () => {
    jest
      .mocked(listViewedJiraTickets)
      .mockResolvedValue(queueRead([ticket()], 'page-cap'));

    render(<ViewedTab />);

    expect(
      await screen.findByText(/first 500, most recently viewed/),
    ).toBeInTheDocument();
  });

  it('shows a load error, not the empty-state copy, for a genuine failure', async () => {
    jest
      .mocked(listViewedJiraTickets)
      .mockRejectedValue(
        new JiraApiError('Jira is rate-limiting this account.', 'jira_error'),
      );

    render(<ViewedTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Jira is rate-limiting this account.',
    );
    expect(
      screen.queryByText('Nothing in your Jira view history yet.'),
    ).not.toBeInTheDocument();
  });
});
