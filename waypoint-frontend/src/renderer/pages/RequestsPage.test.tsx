import '@testing-library/jest-dom';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  approveCopilotProposal,
  convertRequestToTicket,
  createRequest,
  getCurrentUser,
  getProject,
  listRequestProposals,
  listRequests,
  listStates,
  listTickets,
  rejectCopilotProposal,
  updateProject,
  updateRequestStatus,
} from '@/data/api';
import { useProject } from '@/layouts/ProjectLayout';
import { resetProposalStoreForTests } from '@/lib/proposalStore';
import type { Member, Project, ProposalView, Request } from '@/types/entities';
import RequestsPage from './RequestsPage';

jest.mock('@/data/api', () => ({
  // approveCopilotProposal/rejectCopilotProposal aren't called directly by
  // this page — they're what lib/proposalStore.ts's approveProposal/
  // rejectProposal call underneath — but that module also imports them from
  // '@/data/api', so this mock factory needs to cover them too.
  approveCopilotProposal: jest.fn(),
  rejectCopilotProposal: jest.fn(),
  convertRequestToTicket: jest.fn(),
  createRequest: jest.fn(),
  getCurrentUser: jest.fn(),
  getProject: jest.fn(),
  listRequestProposals: jest.fn(),
  listRequests: jest.fn(),
  listStates: jest.fn(),
  listTickets: jest.fn(),
  updateProject: jest.fn(),
  updateRequestStatus: jest.fn(),
}));
jest.mock('@/layouts/ProjectLayout', () => ({ useProject: jest.fn() }));

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
  primitiveCounts: { sprints: 0, workstreams: 0, views: 0, docs: 0, requests: 0, requestsPending: 0 },
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
  firstDayOfWeek: 'Sunday',
  notificationPrefs: null,
};

function requestWith(overrides: Partial<Request> = {}): Request {
  return {
    id: 'req-1',
    projectId: 'proj-1',
    title: 'Add dark mode',
    description: 'Please add a dark theme option.',
    status: 'pending',
    priority: 'none',
    sourceName: 'Someone',
    sourceEmail: 'someone@example.com',
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    linkedTicketId: null,
    ...overrides,
  };
}

function proposal(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 'prop-1',
    conversationId: null,
    kind: 'create_ticket',
    ticketId: null,
    payload: { projectId: 'proj-1', title: 'Add dark mode', stateId: 'st-1' },
    snapshot: { projectIdentifier: 'LAUNCH', projectName: 'Launch', stateName: 'Backlog' },
    anchorSeq: null,
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    disclosureText: 'disclosure ',
    expiresAt: '2026-01-02T00:00:00.000Z',
    modelNotifiedAt: null,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    origin: 'agent_run',
    projectId: 'proj-1',
    agentId: 'agent-1',
    agentRunId: 'run-1',
    sourceRequestId: 'req-1',
    decidedBy: null,
    trustGrantId: null,
    decisionLatencyMs: null,
    ...overrides,
  };
}

function mount(requests: Request[], proposalsByRequestId: Record<string, ProposalView[]> = {}) {
  jest.mocked(useProject).mockReturnValue({ project: PROJECT, reloadProject: jest.fn() });
  jest.mocked(listRequests).mockResolvedValue(requests);
  jest.mocked(listStates).mockResolvedValue([]);
  jest.mocked(listTickets).mockResolvedValue([]);
  jest.mocked(getCurrentUser).mockResolvedValue(MEMBER);
  jest
    .mocked(listRequestProposals)
    .mockImplementation(async (requestId: string) => proposalsByRequestId[requestId] ?? []);
  jest.mocked(createRequest).mockResolvedValue(requestWith());
  jest.mocked(updateRequestStatus).mockResolvedValue(requestWith({ status: 'declined' }));
  jest.mocked(convertRequestToTicket).mockResolvedValue({} as never);
  jest.mocked(updateProject).mockResolvedValue(PROJECT);
  jest.mocked(getProject).mockResolvedValue(PROJECT);

  return render(
    <MemoryRouter>
      <RequestsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  resetProposalStoreForTests();
});

afterEach(() => {
  cleanup();
});

// W4.4 (architecture §4.4) — the Requests page's inline "pending proposals"
// section, fetched per visible row via listRequestProposals and rendered
// through the same CopilotProposalCard as the Copilot panel and the
// ticket-detail integration, wired through the shared proposalStore.
describe('RequestsPage → pending proposals section', () => {
  it('renders no proposal card when a request has zero pending proposals', async () => {
    mount([requestWith({ id: 'req-1' })]);

    await waitFor(() => expect(listRequestProposals).toHaveBeenCalledWith('req-1', 'proposed'));
    expect(screen.getByText('Add dark mode')).toBeInTheDocument();
    expect(screen.queryByText(/Proposed change/)).not.toBeInTheDocument();
  });

  it('renders a card for each pending proposal returned for a request', async () => {
    mount(
      [requestWith({ id: 'req-1' })],
      { 'req-1': [proposal({ id: 'prop-1', sourceRequestId: 'req-1' })] },
    );

    expect(await screen.findByText('Proposed change · New ticket')).toBeInTheDocument();
  });

  it('only shows a proposal card on the request it belongs to', async () => {
    mount(
      [requestWith({ id: 'req-1', title: 'Has a proposal' }), requestWith({ id: 'req-2', title: 'Has none' })],
      { 'req-1': [proposal({ id: 'prop-1', sourceRequestId: 'req-1' })] },
    );

    await screen.findByText('Proposed change · New ticket');
    expect(listRequestProposals).toHaveBeenCalledWith('req-1', 'proposed');
    expect(listRequestProposals).toHaveBeenCalledWith('req-2', 'proposed');
    // Exactly one card exists, even though two requests are rendered.
    expect(screen.getAllByText('Proposed change · New ticket')).toHaveLength(1);
  });

  it('approving from this card resolves through the shared proposalStore', async () => {
    mount(
      [requestWith({ id: 'req-1' })],
      { 'req-1': [proposal({ id: 'prop-1', sourceRequestId: 'req-1', status: 'proposed' })] },
    );
    jest
      .mocked(approveCopilotProposal)
      .mockResolvedValue(proposal({ id: 'prop-1', sourceRequestId: 'req-1', status: 'executed' }));

    await screen.findByText('Proposed change · New ticket');
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });

    expect(approveCopilotProposal).toHaveBeenCalledWith('prop-1');
    expect(await screen.findByText('Applied — ticket created')).toBeInTheDocument();
  });

  it('rejecting from this card resolves through the shared proposalStore', async () => {
    mount(
      [requestWith({ id: 'req-1' })],
      { 'req-1': [proposal({ id: 'prop-1', sourceRequestId: 'req-1', status: 'proposed' })] },
    );
    jest
      .mocked(rejectCopilotProposal)
      .mockResolvedValue(proposal({ id: 'prop-1', sourceRequestId: 'req-1', status: 'rejected' }));

    await screen.findByText('Proposed change · New ticket');
    await act(async () => {
      screen.getByRole('button', { name: 'Reject' }).click();
    });

    expect(rejectCopilotProposal).toHaveBeenCalledWith('prop-1');
    expect(await screen.findByText('Dismissed, nothing changed')).toBeInTheDocument();
  });
});

// The toggle used to be pure local state (`useState(false)`) with no
// initialization from the project and no save call, so it looked
// functional but silently never persisted — see PATCH /projects/:id's
// existing acceptsRequests field in projects.schema.ts.
describe('RequestsPage → public request form toggle', () => {
  it('initializes from the project’s acceptsRequests value', async () => {
    mount([]);

    await screen.findByText('No requests yet');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('persists the change via updateProject when toggled', async () => {
    mount([]);

    await screen.findByText('No requests yet');
    await act(async () => {
      screen.getByRole('switch').click();
    });

    expect(updateProject).toHaveBeenCalledWith('proj-1', { acceptsRequests: false });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  // handleTogglePublicForm used to flip local state optimistically with no
  // error handling — a failed save left the switch showing the new position
  // while the project's persisted acceptsRequests stayed unchanged.
  it('reverts to the previous value when the save fails', async () => {
    mount([]);
    jest.mocked(updateProject).mockRejectedValue(new Error('network error'));

    await screen.findByText('No requests yet');
    await act(async () => {
      screen.getByRole('switch').click();
    });

    expect(updateProject).toHaveBeenCalledWith('proj-1', { acceptsRequests: false });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});
