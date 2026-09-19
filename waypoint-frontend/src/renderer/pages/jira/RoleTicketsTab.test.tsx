import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listRoleJiraTickets } from '@/data/jiraApi';
import { JiraApiError } from '@/types/jira';
import type { JiraTicket, JiraTruncation } from '@/types/jira';
import RoleTicketsTab from './RoleTicketsTab';

// RoleTicketsTab pulls in JiraTicketRow and JiraTicketDrawer, both of which
// import their own slice of data/jiraApi — mocking the whole module here
// (rather than per-component) is what makes it possible to render the real
// component tree, same reasoning as MyJiraPage.test.tsx's own mock.
jest.mock('@/data/jiraApi', () => ({
  listRoleJiraTickets: jest.fn(),
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

describe('RoleTicketsTab', () => {
  it("reads the given role's own queue on mount, with no search", async () => {
    jest.mocked(listRoleJiraTickets).mockResolvedValue(queueRead([]));

    render(<RoleTicketsTab queryRole="reporter" />);

    await waitFor(() =>
      expect(listRoleJiraTickets).toHaveBeenCalledWith('reporter', ''),
    );
  });

  it('renders the tickets the read returns', async () => {
    jest
      .mocked(listRoleJiraTickets)
      .mockResolvedValue(
        queueRead([ticket({ title: 'Webhook receiver drops events' })]),
      );

    render(<RoleTicketsTab queryRole="assignee" />);

    expect(
      await screen.findByText('Webhook receiver drops events'),
    ).toBeInTheDocument();
  });

  // Each tab's own empty state names what "nothing here" means for that
  // specific role, rather than one generic sentence for all three.
  it("shows the assignee tab's own empty copy over a genuinely empty queue", async () => {
    jest.mocked(listRoleJiraTickets).mockResolvedValue(queueRead([]));

    render(<RoleTicketsTab queryRole="assignee" />);

    expect(
      await screen.findByText(
        "Nothing assigned to you that's still unresolved.",
      ),
    ).toBeInTheDocument();
  });

  // Real timers rather than fake ones: fake timers plus a promise-resolving
  // mock fight React's act() tracking across the microtask/macrotask split,
  // producing spurious "not wrapped in act" warnings that have nothing to do
  // with what this test is actually checking. Three keystrokes fired back to
  // back are still separated by microseconds, comfortably inside the 250ms
  // debounce window, so the "not yet" assertion is exact without faking time.
  it('debounces typed search into one delayed listRoleJiraTickets call, not one per keystroke', async () => {
    jest.mocked(listRoleJiraTickets).mockResolvedValue(queueRead([]));

    render(<RoleTicketsTab queryRole="watcher" />);
    await waitFor(() => expect(listRoleJiraTickets).toHaveBeenCalledTimes(1));

    const input = screen.getByPlaceholderText(/search what you.re watching/i);
    fireEvent.change(input, { target: { value: 'w' } });
    fireEvent.change(input, { target: { value: 'we' } });
    fireEvent.change(input, { target: { value: 'web' } });

    // Not yet — still inside the debounce window, and only the mount read
    // (with a blank search) has happened so far.
    expect(listRoleJiraTickets).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(listRoleJiraTickets).toHaveBeenCalledTimes(2));
    expect(listRoleJiraTickets).toHaveBeenLastCalledWith('watcher', 'web');
  });

  it('shows the page-cap truncation banner when the read reports it', async () => {
    jest
      .mocked(listRoleJiraTickets)
      .mockResolvedValue(queueRead([ticket()], 'page-cap'));

    render(<RoleTicketsTab queryRole="assignee" />);

    expect(
      await screen.findByText(/first 500, most recently updated/),
    ).toBeInTheDocument();
  });

  it('shows a load error with a working retry, not the empty-queue copy', async () => {
    jest
      .mocked(listRoleJiraTickets)
      .mockRejectedValueOnce(
        new JiraApiError('Jira is rate-limiting this account.', 'jira_error'),
      )
      .mockResolvedValueOnce(
        queueRead([ticket({ title: 'Recovered ticket' })]),
      );

    render(<RoleTicketsTab queryRole="assignee" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Jira is rate-limiting this account.',
    );
    expect(
      screen.queryByText("Nothing assigned to you that's still unresolved."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Recovered ticket')).toBeInTheDocument();
  });

  // Found in manual testing: MyJiraPage mounts one RoleTicketsTab at a
  // single position in its tree for Assigned/Reported/Watching alike, so
  // switching between them re-renders this SAME instance with a new
  // queryRole prop rather than unmounting and remounting. Reproduced here
  // with `rerender`, the same mechanism React actually uses, rather than
  // three separate `render()` calls that would each get their own fresh
  // instance and never exercise the bug at all.
  it("clears the previous role's tickets immediately on a role switch, before the new read resolves", async () => {
    jest
      .mocked(listRoleJiraTickets)
      .mockResolvedValueOnce(
        queueRead([ticket({ id: 'a', title: 'Assigned ticket' })]),
      );

    const { rerender } = render(<RoleTicketsTab queryRole="assignee" />);
    await screen.findByText('Assigned ticket');

    // A second call that never resolves during this test — standing in for
    // "the new fetch is still in flight" so the assertion below is
    // specifically about what happens BEFORE the watcher data arrives, not
    // after.
    jest.mocked(listRoleJiraTickets).mockReturnValueOnce(new Promise(() => {}));
    rerender(<RoleTicketsTab queryRole="watcher" />);

    await waitFor(() =>
      expect(screen.queryByText('Assigned ticket')).not.toBeInTheDocument(),
    );
  });

  it('paginates a queue larger than one page, 25 tickets at a time', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      ticket({ id: `t${i}`, key: `ENG-${i}`, title: `Ticket ${i}` }),
    );
    jest.mocked(listRoleJiraTickets).mockResolvedValue(queueRead(many));

    render(<RoleTicketsTab queryRole="assignee" />);

    await screen.findByText('Ticket 0');
    expect(screen.getByText('Showing 1–25 of 30')).toBeInTheDocument();
    expect(screen.queryByText('Ticket 25')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));

    expect(await screen.findByText('Ticket 25')).toBeInTheDocument();
    expect(screen.queryByText('Ticket 0')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 26–30 of 30')).toBeInTheDocument();
  });

  it('renders no pager at all when the queue fits on one page', async () => {
    jest.mocked(listRoleJiraTickets).mockResolvedValue(queueRead([ticket()]));

    render(<RoleTicketsTab queryRole="assignee" />);

    await screen.findByText('A ticket');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});
