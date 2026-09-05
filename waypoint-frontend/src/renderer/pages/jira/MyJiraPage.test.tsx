import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  dismissJiraDuplicateNudge,
  getJiraDuplicateNudge,
  getJiraTransitions,
  getMyJiraProposal,
  listJiraComments,
  listJiraMentionCandidates,
  listMyJiraTickets,
} from '@/data/jiraApi';
import { useLoadedJiraConnection } from '@/lib/jiraStore';
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
  listJiraMentionCandidates: jest.fn(),
  postJiraComment: jest.fn(),
  approveJiraProposal: jest.fn(),
  rejectJiraProposal: jest.fn(),
}));
jest.mock('@/lib/jiraStore', () => ({ useLoadedJiraConnection: jest.fn() }));

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
    assigneeInitials: 'MC',
    reporterName: 'Sam Lee',
    watcherNames: [],
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
  jest.mocked(listJiraMentionCandidates).mockResolvedValue([]);
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
    jest.mocked(listJiraMentionCandidates).mockResolvedValue([]);
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
