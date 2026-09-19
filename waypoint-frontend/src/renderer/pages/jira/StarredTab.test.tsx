import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { listTicketsByJiraKeys } from '@/data/jiraApi';
import { useJiraStarredKeys } from '@/lib/jiraStarred';
import type { JiraTicket } from '@/types/jira';
import StarredTab from './StarredTab';

// StarredTab pulls in JiraTicketRow and JiraTicketDrawer, both of which
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

  // Found in review: unstarring happens from inside this exact drawer (the
  // star toggle lives in JiraTicketDetail), which changes the tab's own
  // starredKeys and re-runs the bulk read without that ticket — this
  // asserts the drawer survives that refetch instead of getting unmounted
  // out from under the person who just clicked its own star button.
  it('keeps the drawer open when the ticket it is showing gets unstarred, instead of unmounting it', async () => {
    jest.mocked(useJiraStarredKeys).mockReturnValue(['ENG-1']);
    jest
      .mocked(listTicketsByJiraKeys)
      .mockResolvedValue([ticket({ title: 'Webhook receiver drops events' })]);

    const { rerender } = render(
      <MemoryRouter>
        <StarredTab />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText('Webhook receiver drops events'));
    // The star toggle button is drawer-only content (this test's mocked
    // connection has no site, so the "Open in Jira" link never renders —
    // not a useful marker here), which is exactly what confirms the drawer
    // itself is mounted, independent of the row list behind it.
    expect(
      await screen.findByRole('button', { name: 'Star ENG-1' }),
    ).toBeInTheDocument();

    // Simulate the unstar this same drawer's own star button would trigger:
    // the key list no longer includes ENG-1, so the bulk read re-runs and
    // comes back without it.
    jest.mocked(useJiraStarredKeys).mockReturnValue([]);
    jest.mocked(listTicketsByJiraKeys).mockResolvedValue([]);
    rerender(
      <MemoryRouter>
        <StarredTab />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Nothing starred yet.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Star ENG-1' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Webhook receiver drops events'),
    ).toBeInTheDocument();
  });

  it('reports the ticket count via onCountChange', async () => {
    jest.mocked(useJiraStarredKeys).mockReturnValue(['ENG-1']);
    jest.mocked(listTicketsByJiraKeys).mockResolvedValue([ticket()]);
    const onCountChange = jest.fn();

    render(<StarredTab onCountChange={onCountChange} />);

    await screen.findByText('A ticket');
    expect(onCountChange).toHaveBeenLastCalledWith(1);
  });

  // Found in review: listTicketsByJiraKeys silently caps a bulk read at
  // LIST_BY_KEYS_MAX keys — past that many stars, the pager's own "of 50"
  // was the only number on screen, with nothing distinguishing "you starred
  // 50 tickets" from "you starred 80 and 30 of them aren't shown".
  it('warns when more tickets are starred than the bulk read will ever show', async () => {
    const keys = Array.from({ length: 80 }, (_, i) => `ENG-${i}`);
    jest.mocked(useJiraStarredKeys).mockReturnValue(keys);
    jest
      .mocked(listTicketsByJiraKeys)
      .mockResolvedValue(
        Array.from({ length: 50 }, (_, i) =>
          ticket({ id: `t${i}`, key: `ENG-${i}` }),
        ),
      );

    render(<StarredTab />);

    expect(
      await screen.findByText(/You've starred 80 tickets/),
    ).toBeInTheDocument();
  });

  it('shows no warning when the starred count fits within the bulk-read cap', async () => {
    jest.mocked(useJiraStarredKeys).mockReturnValue(['ENG-1']);
    jest.mocked(listTicketsByJiraKeys).mockResolvedValue([ticket()]);

    render(<StarredTab />);

    await screen.findByText('A ticket');
    expect(screen.queryByText(/You've starred/)).not.toBeInTheDocument();
  });
});
