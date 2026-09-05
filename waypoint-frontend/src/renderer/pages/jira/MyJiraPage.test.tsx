import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  dismissJiraDuplicateNudge,
  getJiraDuplicateNudge,
  getJiraTransitions,
  getMyJiraProposal,
  listJiraComments,
  listMyJiraTickets,
} from '@/data/jiraApi';
import { useJiraConnection, useLoadedJiraConnection } from '@/lib/jiraStore';
import { JiraApiError } from '@/types/jira';
import type {
  JiraDuplicateNudge,
  JiraProposal,
  JiraTicket,
} from '@/types/jira';
import MyJiraPage from './MyJiraPage';

// The "My work" tab pulls in JiraTicketRow, JiraTicketDrawer,
// JiraCommentComposer, and JiraProposalCard, all of which import their own
// slice of data/jiraApi — mocking the whole module here (rather than
// per-component) is what makes it possible to render the real page tree.
jest.mock('@/data/jiraApi', () => ({
  listMyJiraTickets: jest.fn(),
  dismissJiraTombstone: jest.fn(),
  resolveJiraConflict: jest.fn(),
  getMyJiraProposal: jest.fn(),
  getJiraDuplicateNudge: jest.fn(),
  dismissJiraDuplicateNudge: jest.fn(),
  getJiraTransitions: jest.fn(),
  transitionJiraTicket: jest.fn(),
  listJiraComments: jest.fn(),
  postJiraComment: jest.fn(),
  approveJiraProposal: jest.fn(),
  rejectJiraProposal: jest.fn(),
}));
// useJiraConnection is here because the drawer and the comment composer both
// read the connected account from the same store — the drawer to build the
// real "Open in Jira" link, the composer to name who a comment posts as.
jest.mock('@/lib/jiraStore', () => ({
  useLoadedJiraConnection: jest.fn(),
  useJiraConnection: jest.fn(),
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
    assigneeName: 'Max Chen',
    reporterName: 'Sam Lee',
    description: '',
    epicName: null,
    storyPoints: null,
    sprintName: null,
    attachments: [],
    isTombstoned: false,
    tombstone: null,
    hasConflict: false,
    conflict: null,
    ...overrides,
  };
}

const TICKETS: JiraTicket[] = [
  ticket({
    id: 't-eng-1',
    key: 'ENG-1',
    projectKey: 'ENG',
    role: 'assignee',
    title: 'Eng assignee ticket',
  }),
  ticket({
    id: 't-eng-2',
    key: 'ENG-2',
    projectKey: 'ENG',
    role: 'watcher',
    title: 'Eng watcher ticket',
  }),
  ticket({
    id: 't-plat-1',
    key: 'PLAT-1',
    projectKey: 'PLAT',
    role: 'reporter',
    title: 'Plat reporter ticket',
  }),
  ticket({
    id: 't-grw-1',
    key: 'GRW-1',
    projectKey: 'GRW',
    role: 'assignee',
    title: 'Grw assignee ticket',
  }),
];

function mount() {
  jest.mocked(listMyJiraTickets).mockResolvedValue(TICKETS);
  jest.mocked(getMyJiraProposal).mockResolvedValue(undefined);
  jest.mocked(getJiraDuplicateNudge).mockResolvedValue(undefined);
  jest.mocked(getJiraTransitions).mockResolvedValue([]);
  jest.mocked(listJiraComments).mockResolvedValue([]);
  jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
  return render(<MyJiraPage />);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('MyJiraPage — project + role filtering (combined)', () => {
  it('shows every ticket by default', async () => {
    mount();
    await screen.findByText('Eng assignee ticket');

    expect(screen.getByText('Eng watcher ticket')).toBeInTheDocument();
    expect(screen.getByText('Plat reporter ticket')).toBeInTheDocument();
    expect(screen.getByText('Grw assignee ticket')).toBeInTheDocument();
    expect(screen.getByText('4 issues · 3 Jira projects')).toBeInTheDocument();
  });

  it('narrows to one project when a project chip is clicked', async () => {
    mount();
    await screen.findByText('Eng assignee ticket');

    fireEvent.click(screen.getByRole('button', { name: /^ENG \d/ }));

    expect(screen.getByText('Eng assignee ticket')).toBeInTheDocument();
    expect(screen.getByText('Eng watcher ticket')).toBeInTheDocument();
    expect(screen.queryByText('Plat reporter ticket')).not.toBeInTheDocument();
    expect(screen.queryByText('Grw assignee ticket')).not.toBeInTheDocument();
    expect(screen.getByText('2 issues · 1 Jira project')).toBeInTheDocument();
  });

  it('narrows to one role when a role chip is clicked', async () => {
    mount();
    await screen.findByText('Eng assignee ticket');

    fireEvent.click(screen.getByRole('button', { name: 'Watching' }));

    expect(screen.getByText('Eng watcher ticket')).toBeInTheDocument();
    expect(screen.queryByText('Eng assignee ticket')).not.toBeInTheDocument();
    expect(screen.queryByText('Plat reporter ticket')).not.toBeInTheDocument();
    expect(screen.queryByText('Grw assignee ticket')).not.toBeInTheDocument();
  });

  it('combines project and role filters (AND, not OR)', async () => {
    mount();
    await screen.findByText('Eng assignee ticket');

    fireEvent.click(screen.getByRole('button', { name: /^ENG \d/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Watching' }));

    expect(screen.getByText('Eng watcher ticket')).toBeInTheDocument();
    expect(screen.queryByText('Eng assignee ticket')).not.toBeInTheDocument();
    expect(screen.getByText('1 issue · 1 Jira project')).toBeInTheDocument();
  });

  it('shows the empty state when the combination matches nothing', async () => {
    mount();
    await screen.findByText('Eng assignee ticket');

    fireEvent.click(screen.getByRole('button', { name: /^GRW \d/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Watching' }));

    expect(
      screen.getByText('No tickets match these filters.'),
    ).toBeInTheDocument();
  });

  it('"All" clears both filters back to the full list', async () => {
    mount();
    await screen.findByText('Eng assignee ticket');

    fireEvent.click(screen.getByRole('button', { name: /^PLAT \d/ }));
    expect(screen.queryByText('Eng assignee ticket')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^All \d/ }));
    expect(screen.getByText('Eng assignee ticket')).toBeInTheDocument();
    expect(screen.getByText('Plat reporter ticket')).toBeInTheDocument();
  });
});

// "No tickets match these filters." is a claim about the user's Jira. A read
// that never reached Jira must not make it — the three cases below are the
// difference between "your queue is empty" and "we could not ask".
describe('MyJiraPage — a failed ticket read is not an empty queue', () => {
  function mountFailing(error: Error) {
    jest.mocked(listMyJiraTickets).mockRejectedValue(error);
    jest.mocked(getMyJiraProposal).mockResolvedValue(undefined);
    jest.mocked(getJiraDuplicateNudge).mockResolvedValue(undefined);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
    return render(<MyJiraPage />);
  }

  it('names the failure instead of claiming the filters matched nothing', async () => {
    mountFailing(
      new Error("Couldn't reach Jira. Check your connection and try again."),
    );

    await screen.findByRole('alert');
    expect(screen.getByText(/Couldn't reach Jira/)).toBeInTheDocument();
    expect(
      screen.queryByText('No tickets match these filters.'),
    ).not.toBeInTheDocument();
  });

  it('offers a retry that actually re-runs the read', async () => {
    mountFailing(new Error('Jira took too long to respond — try again.'));
    await screen.findByRole('alert');
    expect(listMyJiraTickets).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(listMyJiraTickets).toHaveBeenCalledTimes(2));
  });

  it('points a dead credential at the Connection tab rather than at retrying', async () => {
    mountFailing(
      new JiraApiError(
        'Jira rejected that email and API token.',
        'invalid_credentials',
      ),
    );

    await screen.findByRole('alert');
    expect(
      screen.getByText(/Reconnect on the Connection tab/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Try again' }),
    ).not.toBeInTheDocument();
  });
});

// The sync indicator sat beside all of the above claiming "synced 0s ago",
// because its timestamp came from module load rather than from a read.
describe('MyJiraPage — sync indicator', () => {
  function connection(lastSyncAt: string | null) {
    return {
      connected: true,
      accountName: 'Max Chen',
      accountEmail: 'max@northwind.dev',
      site: 'waypoint123.atlassian.net',
      lastSyncAt,
      issueCount: 4,
      projectCount: 3,
    };
  }

  it('says so plainly when nothing has synced yet', async () => {
    jest.mocked(listMyJiraTickets).mockResolvedValue(TICKETS);
    jest.mocked(getMyJiraProposal).mockResolvedValue(undefined);
    jest.mocked(getJiraDuplicateNudge).mockResolvedValue(undefined);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(connection(null));
    render(<MyJiraPage />);

    expect(await screen.findByText('not synced yet')).toBeInTheDocument();
    expect(screen.queryByText(/^synced /)).not.toBeInTheDocument();
  });

  it('reports a real age once a read has landed', async () => {
    jest.mocked(listMyJiraTickets).mockResolvedValue(TICKETS);
    jest.mocked(getMyJiraProposal).mockResolvedValue(undefined);
    jest.mocked(getJiraDuplicateNudge).mockResolvedValue(undefined);
    jest
      .mocked(useLoadedJiraConnection)
      .mockReturnValue(connection(new Date().toISOString()));
    render(<MyJiraPage />);

    expect(await screen.findByText(/^synced \d+s ago$/)).toBeInTheDocument();
    expect(screen.queryByText('not synced yet')).not.toBeInTheDocument();
  });
});

// adfToPlainText emits a \n per ADF block — that newline is the only
// structure that survives flattening a Jira description, so the drawer has to
// honor it. jsdom does no layout, so the class is the observable.
describe('JiraTicketDrawer — description wrapping', () => {
  it('preserves the paragraph breaks the ADF flattener produced', async () => {
    const described = ticket({
      id: 't-desc',
      key: 'ENG-9',
      projectKey: 'ENG',
      title: 'Described ticket',
      description: 'First paragraph.\n\nSecond paragraph.\n- a bullet',
    });
    jest.mocked(listMyJiraTickets).mockResolvedValue([described]);
    jest.mocked(getMyJiraProposal).mockResolvedValue(undefined);
    jest.mocked(getJiraDuplicateNudge).mockResolvedValue(undefined);
    jest.mocked(listJiraComments).mockResolvedValue([]);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
    jest.mocked(useJiraConnection).mockReturnValue(undefined);
    render(<MyJiraPage />);

    fireEvent.click(await screen.findByText('Described ticket'));

    const body = await screen.findByText(/First paragraph\./);
    expect(body).toHaveClass('whitespace-pre-wrap');
  });
});

// The ticket list is an `overflow-hidden` container and each row is a
// `relative` box inside it. A popover rendered as a plain `absolute` sibling
// of the state chip is therefore clipped at the list's bottom edge — nearly
// entirely so on the last row. jsdom does no layout, so what's asserted is
// the escape itself: the panel is a child of <body>, positioned in viewport
// coordinates rather than against the row.
describe('JiraTransitionPopover — escapes the list clipping container', () => {
  async function openPopoverOnLastRow() {
    jest.mocked(listMyJiraTickets).mockResolvedValue(TICKETS);
    jest.mocked(getMyJiraProposal).mockResolvedValue(undefined);
    jest.mocked(getJiraDuplicateNudge).mockResolvedValue(undefined);
    jest.mocked(getJiraTransitions).mockResolvedValue([
      {
        id: '31',
        targetStateName: 'In Progress',
        targetStateColor: 'var(--warning)',
        requiresFields: [],
      },
    ]);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
    const { container } = render(<MyJiraPage />);

    await screen.findByText('Grw assignee ticket');
    const chips = screen.getAllByRole('button', { name: 'To Do' });
    fireEvent.click(chips[chips.length - 1]);

    const panel = (await screen.findByText('Move GRW-1 to')).closest(
      '[data-shortcut-guard]',
    );
    return { panel, container };
  }

  it('renders the panel outside the list, as a child of document.body', async () => {
    const { panel, container } = await openPopoverOnLastRow();

    expect(panel).not.toBeNull();
    expect(panel?.parentElement).toBe(document.body);
    expect(container.contains(panel as Node)).toBe(false);
  });

  it('positions the panel in viewport coordinates, not against the row', async () => {
    const { panel } = await openPopoverOnLastRow();

    expect(panel).toHaveClass('fixed');
    expect(panel).not.toHaveClass('absolute');
  });

  it('still closes on Escape', async () => {
    await openPopoverOnLastRow();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByText('Move GRW-1 to')).not.toBeInTheDocument(),
    );
  });
});

describe('MyJiraPage — Copilot rail', () => {
  function proposal(overrides: Partial<JiraProposal> = {}): JiraProposal {
    return {
      id: 'jira-prop-eng-421',
      ticketId: 't-eng-1',
      ticketKey: 'ENG-1',
      ticketProjectColor: 'var(--p-eng)',
      status: 'proposed',
      fromStateName: 'To Do',
      fromStateColor: 'var(--text-muted)',
      toStateName: 'In Review',
      toStateColor: 'var(--accent)',
      commentBody: 'A proposed comment.',
      commentMentions: [],
      repoPath: '~/code/northwind',
      branch: 'fix/x',
      commitCount: 1,
      prNumber: 1,
      prStatus: 'open',
      createdAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: null,
      ...overrides,
    };
  }

  function nudge(): JiraDuplicateNudge {
    return {
      id: 'jira-dup-1',
      ticketId: 't-grw-1',
      ticketKey: 'GRW-1',
      ticketProjectColor: 'var(--p-grw)',
      duplicateOfKey: 'GRW-9',
    };
  }

  it('renders the proposal card and the nudge card when both exist', async () => {
    jest.mocked(listMyJiraTickets).mockResolvedValue(TICKETS);
    jest.mocked(getMyJiraProposal).mockResolvedValue(proposal());
    jest.mocked(getJiraDuplicateNudge).mockResolvedValue(nudge());
    jest.mocked(getJiraTransitions).mockResolvedValue([]);
    jest.mocked(listJiraComments).mockResolvedValue([]);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
    render(<MyJiraPage />);

    await screen.findByText('Needs your approval');
    expect(screen.getByText('Also queued')).toBeInTheDocument();
    expect(screen.getByText('GRW-9')).toBeInTheDocument();
  });

  it('dismissing the nudge calls the mock function and removes the card', async () => {
    jest.mocked(listMyJiraTickets).mockResolvedValue(TICKETS);
    jest.mocked(getMyJiraProposal).mockResolvedValue(undefined);
    jest.mocked(getJiraDuplicateNudge).mockResolvedValue(nudge());
    jest.mocked(dismissJiraDuplicateNudge).mockResolvedValue(undefined);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
    render(<MyJiraPage />);

    await screen.findByText('Also queued');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() =>
      expect(dismissJiraDuplicateNudge).toHaveBeenCalledWith('jira-dup-1'),
    );
    await waitFor(() =>
      expect(screen.queryByText('Also queued')).not.toBeInTheDocument(),
    );
  });

  it('renders no rail at all when there is neither a proposal nor a nudge', async () => {
    mount();
    await screen.findByText('Eng assignee ticket');

    expect(screen.queryByText('Also queued')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs your approval')).not.toBeInTheDocument();
  });
});
