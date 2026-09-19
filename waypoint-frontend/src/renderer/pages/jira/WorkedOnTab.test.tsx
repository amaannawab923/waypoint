import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { listWorkedOnJiraKeys } from '@/data/api';
import { listTicketsByJiraKeys } from '@/data/jiraApi';
import { useLoadedJiraConnection } from '@/lib/jiraStore';
import type { JiraConnectionStatus, JiraTicket } from '@/types/jira';
import WorkedOnTab from './WorkedOnTab';

jest.mock('@/data/api', () => ({
  listWorkedOnJiraKeys: jest.fn(),
}));
// WorkedOnTab pulls in JiraTicketRow and JiraTicketDrawer, both of which
// import their own slice of data/jiraApi — mocking the whole module here
// (rather than per-component) is what makes it possible to render the real
// component tree, same reasoning as RoleTicketsTab.test.tsx's own mock.
jest.mock('@/data/jiraApi', () => ({
  LIST_BY_KEYS_MAX: 50,
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
  useLoadedJiraConnection: jest.fn(),
  useJiraConnection: jest.fn(() => undefined),
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

const CONNECTED: JiraConnectionStatus = {
  connected: true,
  accountName: 'Max Chen',
  accountEmail: 'max@northwind.dev',
  accountId: '5f8a',
  site: 'waypoint123.atlassian.net',
  lastSyncAt: '2026-09-01T10:00:00.000Z',
  issueCount: 3,
  projectCount: 1,
  countsTruncated: false,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('WorkedOnTab', () => {
  it('resolves keys from the backend into real ticket rows from Jira', async () => {
    jest.mocked(useLoadedJiraConnection).mockReturnValue(CONNECTED);
    jest.mocked(listWorkedOnJiraKeys).mockResolvedValue(['ENG-1', 'PLAT-2']);
    jest
      .mocked(listTicketsByJiraKeys)
      .mockResolvedValue([ticket({ title: 'Webhook receiver drops events' })]);

    render(<WorkedOnTab />);

    expect(
      await screen.findByText('Webhook receiver drops events'),
    ).toBeInTheDocument();
    expect(listWorkedOnJiraKeys).toHaveBeenCalledWith(
      'waypoint123.atlassian.net',
    );
    expect(listTicketsByJiraKeys).toHaveBeenCalledWith(['ENG-1', 'PLAT-2']);
  });

  it('shows the empty state over a genuine "nothing worked on yet"', async () => {
    jest.mocked(useLoadedJiraConnection).mockReturnValue(CONNECTED);
    jest.mocked(listWorkedOnJiraKeys).mockResolvedValue([]);
    jest.mocked(listTicketsByJiraKeys).mockResolvedValue([]);

    render(<WorkedOnTab />);

    expect(
      await screen.findByText('No agent runs against a Jira issue yet.'),
    ).toBeInTheDocument();
    // Confirms this is the real "queried and got nothing" path, not a
    // read that never happened at all.
    expect(listTicketsByJiraKeys).toHaveBeenCalledWith([]);
  });

  it('does not query anything before the connection status is known', async () => {
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);

    render(<WorkedOnTab />);
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );

    expect(listWorkedOnJiraKeys).not.toHaveBeenCalled();
  });

  it('shows a load error naming a missing connection, not the empty-queue copy', async () => {
    jest
      .mocked(useLoadedJiraConnection)
      .mockReturnValue({ ...CONNECTED, connected: false, site: '' });

    render(<WorkedOnTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No Jira account is connected.',
    );
    expect(listWorkedOnJiraKeys).not.toHaveBeenCalled();
    expect(
      screen.queryByText('No agent runs against a Jira issue yet.'),
    ).not.toBeInTheDocument();
  });

  it('shows a load error, not the empty-queue copy, for a genuine failure', async () => {
    jest.mocked(useLoadedJiraConnection).mockReturnValue(CONNECTED);
    jest
      .mocked(listWorkedOnJiraKeys)
      .mockRejectedValue(
        new Error('Request failed: 500 /agent-runs/worked-on-jira-keys'),
      );

    render(<WorkedOnTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Request failed: 500',
    );
    expect(
      screen.queryByText('No agent runs against a Jira issue yet.'),
    ).not.toBeInTheDocument();
  });

  // Found in review: listTicketsByJiraKeys silently caps a bulk read at
  // LIST_BY_KEYS_MAX keys — past that many worked-on issues, the pager's
  // own "of 50" was the only number on screen, with nothing distinguishing
  // "you worked on 50 tickets" from "you worked on 80 and 30 aren't shown".
  it('warns when more issues were worked on than the bulk read will ever show', async () => {
    const keys = Array.from({ length: 80 }, (_, i) => `ENG-${i}`);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(CONNECTED);
    jest.mocked(listWorkedOnJiraKeys).mockResolvedValue(keys);
    jest
      .mocked(listTicketsByJiraKeys)
      .mockResolvedValue(
        Array.from({ length: 50 }, (_, i) =>
          ticket({ id: `t${i}`, key: `ENG-${i}` }),
        ),
      );

    render(<WorkedOnTab />);

    expect(
      await screen.findByText(/You've worked on 80 tickets/),
    ).toBeInTheDocument();
  });

  it('shows no warning when the worked-on count fits within the bulk-read cap', async () => {
    jest.mocked(useLoadedJiraConnection).mockReturnValue(CONNECTED);
    jest.mocked(listWorkedOnJiraKeys).mockResolvedValue(['ENG-1']);
    jest.mocked(listTicketsByJiraKeys).mockResolvedValue([ticket()]);

    render(<WorkedOnTab />);

    await screen.findByText('A ticket');
    expect(screen.queryByText(/You've worked on/)).not.toBeInTheDocument();
  });
});
