import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
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
  updateTicket,
} from '@/data/api';
import { useProject } from '@/layouts/ProjectLayout';
import { resetProposalStoreForTests } from '@/lib/proposalStore';
import type { Member, Project, Ticket } from '@/types/entities';
import { TicketDrawer } from './TicketDrawer';

// Same mock surface as pages/tickets/TicketDetailPage.test.tsx — TicketDrawer
// is a thin portal/positioning/Escape shell around that page's own
// TicketDetailContent, so mounting it for real needs the same data. What
// this file adds coverage for is what the shell itself owns: no backdrop,
// data-ticket-drawer presence, focus-gated Escape, and focus restoration on
// close — not the ticket content itself, which
// TicketDetailPage.test.tsx already covers exhaustively.
jest.mock('@/data/api', () => ({
  addComment: jest.fn(),
  addTicketLink: jest.fn(),
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
  acceptsRequests: false,
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

function mountDrawer(onClose: () => void = jest.fn()) {
  jest.mocked(useProject).mockReturnValue({ project: PROJECT, reloadProject: jest.fn() });
  jest.mocked(getTicketByIdentifier).mockResolvedValue(ITEM);
  jest.mocked(listStates).mockResolvedValue([]);
  jest.mocked(listLabels).mockResolvedValue([]);
  jest.mocked(listWorkstreams).mockResolvedValue([]);
  jest.mocked(listSprints).mockResolvedValue([]);
  jest.mocked(listMembers).mockResolvedValue([MEMBER]);
  jest.mocked(getCurrentUser).mockResolvedValue(MEMBER);
  jest.mocked(listAgents).mockResolvedValue([]);
  jest.mocked(listAgentAssignments).mockResolvedValue([]);
  jest.mocked(listSubItems).mockResolvedValue([]);
  jest.mocked(listActivity).mockResolvedValue([]);
  jest.mocked(listComments).mockResolvedValue([]);
  jest.mocked(getTicket).mockResolvedValue(ITEM);
  jest.mocked(listTicketProposals).mockResolvedValue([]);
  jest.mocked(updateTicket).mockResolvedValue(ITEM);

  return render(
    <MemoryRouter>
      <TicketDrawer projectId="proj-1" identifier="LAUNCH-3" onClose={onClose} />
    </MemoryRouter>,
  );
}

function drawerRoot(): HTMLElement {
  return document.querySelector('[data-ticket-drawer]') as HTMLElement;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetProposalStoreForTests();
});

afterEach(() => {
  cleanup();
});

// MY_JIRA_IMPROVEMENTS.md §5: this used to be a `fixed inset-0 bg-black/40`
// modal — a backdrop covering the whole window, which made the topbar's
// Copilot toggle physically unreachable while any ticket was open. De-
// modalized to CopilotPanel.tsx's own docked-panel shape.
describe('de-modalized: no full-viewport backdrop', () => {
  it('renders no backdrop element', async () => {
    mountDrawer();

    await screen.findByDisplayValue('Responsive nav breaks on iPad landscape');
    expect(document.querySelector('.bg-black\\/40')).toBeNull();
  });

  it('marks its own root with data-ticket-drawer', async () => {
    mountDrawer();

    await screen.findByDisplayValue('Responsive nav breaks on iPad landscape');
    expect(drawerRoot()).toBeInTheDocument();
  });
});

describe('Escape only closes when focus is inside the drawer', () => {
  it('does nothing when focus is outside the drawer', async () => {
    const onClose = jest.fn();
    mountDrawer(onClose);
    await screen.findByDisplayValue('Responsive nav breaks on iPad landscape');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    document.body.removeChild(outside);
  });

  it('closes when focus is inside the drawer', async () => {
    const onClose = jest.fn();
    mountDrawer(onClose);
    const title = await screen.findByDisplayValue(
      'Responsive nav breaks on iPad landscape',
    );
    title.focus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('focus restoration on close', () => {
  it('restores focus to whatever was focused before the drawer opened', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = mountDrawer();
    await screen.findByDisplayValue('Responsive nav breaks on iPad landscape');

    // The caller unmounts this component on close (see e.g.
    // AllTicketsPage.tsx's `{peekIdentifier && <TicketDrawer .../>}`) — this
    // asserts the cleanup effect that runs on that unmount.
    unmount();

    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });
});
