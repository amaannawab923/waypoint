import '@testing-library/jest-dom';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  addComment,
  addTicketLink,
  approveCopilotProposal,
  deleteTicket,
  getCurrentUser,
  getTicket,
  getTicketByIdentifier,
  listActivity,
  listAgentAssignments,
  listAgents,
  listComments,
  listSprints,
  listLabels,
  listMembers,
  listWorkstreams,
  listStates,
  listSubItems,
  listTicketProposals,
  rejectCopilotProposal,
  removeTicketLink,
  takeBackOverFromAgent,
  toggleTicketAgent,
  toggleTicketAssignee,
  toggleTicketLabel,
  updateTicket,
} from '@/data/api';
import { useProject } from '@/layouts/ProjectLayout';
import { resetProposalStoreForTests } from '@/lib/proposalStore';
import type { Agent, Comment, Member, Project, ProposalView, Ticket } from '@/types/entities';
import { TicketDetailContent } from './TicketDetailPage';

jest.mock('@/data/api', () => ({
  addComment: jest.fn(),
  addTicketLink: jest.fn(),
  // approveCopilotProposal/rejectCopilotProposal aren't called directly by
  // this page — they're what lib/proposalStore.ts's approveProposal/
  // rejectProposal call underneath — but that module also imports them from
  // '@/data/api', so this mock factory needs to cover them too.
  approveCopilotProposal: jest.fn(),
  rejectCopilotProposal: jest.fn(),
  deleteTicket: jest.fn(),
  getCurrentUser: jest.fn(),
  getTicket: jest.fn(),
  getTicketByIdentifier: jest.fn(),
  listActivity: jest.fn(),
  listAgentAssignments: jest.fn(),
  listAgents: jest.fn(),
  listComments: jest.fn(),
  listSprints: jest.fn(),
  listLabels: jest.fn(),
  listMembers: jest.fn(),
  listWorkstreams: jest.fn(),
  listStates: jest.fn(),
  listSubItems: jest.fn(),
  listTicketProposals: jest.fn(),
  removeTicketLink: jest.fn(),
  takeBackOverFromAgent: jest.fn(),
  toggleTicketAgent: jest.fn(),
  toggleTicketAssignee: jest.fn(),
  toggleTicketLabel: jest.fn(),
  updateTicket: jest.fn(),
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
  features: {
    sprints: true,
    workstreams: true,
    views: true,
    docs: true,
    requests: true,
  },
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

const ITEM: Ticket = {
  id: 'wi-1',
  projectId: 'proj-1',
  identifier: 'LAUNCH-3',
  sequenceId: 3,
  title: 'Responsive nav breaks on iPad landscape',
  description: '',
  stateId: 'st-1',
  priority: 'none',
  source: 'manual',
  assigneeIds: [],
  labelIds: [],
  workstreamId: null,
  sprintId: null,
  parentId: null,
  estimatePoints: null,
  estimateValue: null,
  startDate: null,
  dueDate: null,
  createdById: 'mem-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  attachmentCount: 0,
  linkCount: 0,
  links: [],
  isDraft: false,
};

const XSS_PAYLOAD = '<img src=x onerror=alert(1)>';

const AGENT: Agent = {
  id: 'agent-1',
  workspaceId: 'ws-1',
  name: 'Triage Agent',
  avatarColor: '#654321',
  instructionsFile: { filename: 'agent.md', contentMarkdown: '' },
  scopeAllProjects: true,
  scopeProjectIds: [],
  executionMethod: 'local-claude-subscription',
  model: 'Claude Opus',
  autonomy: 'ask-before-write',
  triggers: ['manual'],
  isActive: true,
  createdById: 'mem-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function commentWith(bodyHtml: string, authorId = 'mem-1'): Comment {
  return {
    id: 'cm-1',
    ticketId: 'wi-1',
    authorId,
    bodyHtml,
    createdAt: new Date().toISOString(),
  };
}

function proposal(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 'prop-1',
    conversationId: 'conv-1',
    kind: 'state_change',
    ticketId: 'wi-1',
    payload: { stateId: 'st-done' },
    snapshot: { identifier: 'LAUNCH-3', title: 'T', toStateName: 'Done' },
    anchorSeq: 1,
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    disclosureText: 'disclosure ',
    expiresAt: '2026-01-02T00:00:00.000Z',
    modelNotifiedAt: null,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    origin: 'copilot',
    projectId: 'proj-1',
    agentId: null,
    agentRunId: null,
    sourceRequestId: null,
    decidedBy: null,
    trustGrantId: null,
    decisionLatencyMs: null,
    ...overrides,
  };
}

function mount(comments: Comment[], agents: Agent[] = [], proposals: ProposalView[] = []) {
  jest
    .mocked(useProject)
    .mockReturnValue({ project: PROJECT, reloadProject: jest.fn() });
  jest.mocked(getTicketByIdentifier).mockResolvedValue(ITEM);
  jest.mocked(listStates).mockResolvedValue([]);
  jest.mocked(listLabels).mockResolvedValue([]);
  jest.mocked(listWorkstreams).mockResolvedValue([]);
  jest.mocked(listSprints).mockResolvedValue([]);
  jest.mocked(listMembers).mockResolvedValue([MEMBER]);
  jest.mocked(getCurrentUser).mockResolvedValue(MEMBER);
  jest.mocked(listAgents).mockResolvedValue(agents);
  jest.mocked(listAgentAssignments).mockResolvedValue([]);
  jest.mocked(listSubItems).mockResolvedValue([]);
  jest.mocked(listActivity).mockResolvedValue([]);
  jest.mocked(listComments).mockResolvedValue(comments);
  jest.mocked(getTicket).mockResolvedValue(ITEM);
  jest.mocked(listTicketProposals).mockResolvedValue(proposals);
  jest.mocked(addComment).mockResolvedValue(commentWith(''));
  jest.mocked(addTicketLink).mockResolvedValue(ITEM);
  jest.mocked(removeTicketLink).mockResolvedValue(ITEM);
  jest.mocked(deleteTicket).mockResolvedValue(undefined);
  jest.mocked(takeBackOverFromAgent).mockResolvedValue(undefined as never);
  jest.mocked(toggleTicketAgent).mockResolvedValue(undefined as never);
  jest.mocked(toggleTicketAssignee).mockResolvedValue(undefined as never);
  jest.mocked(toggleTicketLabel).mockResolvedValue(undefined as never);
  jest.mocked(updateTicket).mockResolvedValue(ITEM);

  return render(
    <MemoryRouter>
      <TicketDetailContent projectId="proj-1" identifier="LAUNCH-3" />
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

describe('TicketDetailPage → comment rendering (stored XSS fix)', () => {
  it('renders a comment containing an <img onerror> payload as visible text, not a live element', async () => {
    mount([commentWith(XSS_PAYLOAD)]);

    // The payload must appear as literal, visible text …
    expect(await screen.findByText(XSS_PAYLOAD)).toBeInTheDocument();
    // … and must never have been parsed into a real <img> element (which
    // would fire the onerror handler and execute the injected script).
    expect(document.querySelector('img[src="x"]')).not.toBeInTheDocument();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });

  it('preserves newlines in a plain-text comment', async () => {
    mount([commentWith('first line\nsecond line')]);

    const node = await screen.findByText(
      (_, element) => element?.textContent === 'first line\nsecond line',
    );
    expect(node).toHaveClass('whitespace-pre-wrap');
  });

  it('does not use dangerouslySetInnerHTML for comment bodies', async () => {
    mount([commentWith('<b>not bold</b>, just text')]);

    // If this were still injected as HTML, "<b>not bold</b>" would render an
    // actual <b> element wrapping "not bold" instead of showing the tags.
    expect(
      await screen.findByText('<b>not bold</b>, just text'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('not bold', { selector: 'b' }),
    ).not.toBeInTheDocument();
  });

  // Agent-authored comments are the one case where bodyHtml genuinely is
  // HTML — built server-side by buildCopilotCommentHtml, which escapes the
  // display name and body before wrapping them in a fixed <p>/<em> template.
  // That path never touches human input, so it should still render as real
  // markup instead of falling back to the plain-text guard above.
  it('still renders trusted, backend-escaped HTML for an agent-authored comment', async () => {
    const html =
      '<p><em>Hi, this is Copilot — Priya’s agent — commenting on their behalf: </em>Repro’d on Safari 17.</p>';
    mount([commentWith(html, 'agent-1')], [AGENT]);

    const disclosure = await screen.findByText(
      (_, el) => el?.tagName === 'EM' && el.textContent === 'Hi, this is Copilot — Priya’s agent — commenting on their behalf: ',
    );
    expect(disclosure.tagName).toBe('EM');
    expect(screen.getByText('Repro’d on Safari 17.')).toBeInTheDocument();
  });

  it('still renders a human comment as plain text even when an agent exists elsewhere', async () => {
    mount([commentWith(XSS_PAYLOAD, 'mem-1')], [AGENT]);

    expect(await screen.findByText(XSS_PAYLOAD)).toBeInTheDocument();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });
});

// W4.4 (architecture §4.4) — the ticket-detail inline "Pending proposals"
// section, fetched via listTicketProposals and rendered through the same
// CopilotProposalCard as the Copilot panel, wired through the shared
// proposalStore so approve/reject stay in sync with any other mounted
// surface reading the same store.
describe('TicketDetailPage → pending proposals section', () => {
  it('shows no section at all when the ticket has zero pending proposals', async () => {
    mount([], [], []);

    await waitFor(() => expect(listTicketProposals).toHaveBeenCalledWith('wi-1', 'proposed'));
    expect(screen.queryByText(/Pending proposals/)).not.toBeInTheDocument();
  });

  it('renders a card for each pending proposal returned for this ticket', async () => {
    mount([], [], [proposal({ id: 'prop-1' })]);

    expect(await screen.findByText('Pending proposals (1)')).toBeInTheDocument();
    // The card's own kind label — from CopilotProposalCard.tsx — confirms
    // the shared card component rendered, not a bespoke one.
    expect(screen.getByText('Proposed change · State')).toBeInTheDocument();
  });

  it('approving from this card resolves through the shared proposalStore and updates the card in place', async () => {
    mount([], [], [proposal({ id: 'prop-1', status: 'proposed' })]);
    jest
      .mocked(approveCopilotProposal)
      .mockResolvedValue(proposal({ id: 'prop-1', status: 'executed' }));

    expect(await screen.findByText('Pending proposals (1)')).toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });

    expect(approveCopilotProposal).toHaveBeenCalledWith('prop-1');
    expect(await screen.findByText('Applied — moved to Done')).toBeInTheDocument();
  });

  it('rejecting from this card resolves through the shared proposalStore', async () => {
    mount([], [], [proposal({ id: 'prop-1', status: 'proposed' })]);
    jest
      .mocked(rejectCopilotProposal)
      .mockResolvedValue(proposal({ id: 'prop-1', status: 'rejected' }));

    expect(await screen.findByText('Pending proposals (1)')).toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: 'Reject' }).click();
    });

    expect(rejectCopilotProposal).toHaveBeenCalledWith('prop-1');
    expect(await screen.findByText('Dismissed, nothing changed')).toBeInTheDocument();
  });
});
