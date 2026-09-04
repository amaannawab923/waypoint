import '@testing-library/jest-dom';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  deleteSprint,
  listMembers,
  listSprints,
  listStates,
  listTickets,
  updateSprint,
  updateTicket,
} from '@/data/api';
import { useProject } from '@/layouts/ProjectLayout';
import type { Member, Project, Sprint } from '@/types/entities';
import SprintDetailPage from './SprintDetailPage';

jest.mock('@/data/api', () => ({
  deleteSprint: jest.fn(),
  listMembers: jest.fn(),
  listSprints: jest.fn(),
  listStates: jest.fn(),
  listTickets: jest.fn(),
  updateSprint: jest.fn(),
  // Pulled in transitively by SprintTicketList.tsx's "add ticket to sprint"
  // modal — never actually invoked by the lead-clearing flow this file
  // tests, but the mock factory has to cover every export the page tree
  // imports from '@/data/api' or the real (network-backed) implementation
  // would be used instead.
  updateTicket: jest.fn(),
}));

// SprintDetailPage resolves `sprintId` straight from the URL via
// react-router's useParams — overriding just that hook (keeping the rest of
// the real module for MemoryRouter/Link/useNavigate) is simpler than wiring
// up a full <Routes>/<Route> match for one param.
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ sprintId: 'spr-1' }),
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
  primitiveCounts: { sprints: 1, workstreams: 0, views: 0, docs: 0, requests: 0, requestsPending: 0 },
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

function sprintWithLead(leadId: string | undefined): Sprint {
  return {
    id: 'spr-1',
    projectId: 'proj-1',
    name: 'Sprint 12',
    description: '',
    startDate: '2026-01-01',
    endDate: '2026-01-14',
    leadId,
    memberIds: [],
  };
}

function mount() {
  jest.mocked(useProject).mockReturnValue({ project: PROJECT, reloadProject: jest.fn() });
  jest.mocked(listMembers).mockResolvedValue([MEMBER]);
  jest.mocked(listStates).mockResolvedValue([]);
  jest.mocked(listTickets).mockResolvedValue([]);
  jest.mocked(deleteSprint).mockResolvedValue(undefined);
  jest.mocked(updateTicket).mockResolvedValue(undefined as never);

  // First load has a lead set; after "No lead" is clicked and updateSprint
  // is awaited, reloadSprints() re-fetches — the mock reflects the clear on
  // that second call so the assertion below observes the persisted result,
  // not just the optimistic click.
  jest
    .mocked(listSprints)
    .mockResolvedValueOnce([sprintWithLead('mem-1')])
    .mockResolvedValue([sprintWithLead(undefined)]);
  jest.mocked(updateSprint).mockResolvedValue(sprintWithLead(undefined));

  return render(
    <MemoryRouter>
      <SprintDetailPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('SprintDetailPage → clear lead', () => {
  it('sends an explicit null, not undefined, and the cleared state persists after reload', async () => {
    mount();

    // Lead trigger initially shows the assigned member.
    expect(await screen.findByText('Priya')).toBeInTheDocument();

    await act(async () => {
      screen.getByText('Priya').click();
    });

    const noLeadOption = await screen.findByText('No lead');
    await act(async () => {
      noLeadOption.click();
    });

    // The regression this guards: sending `{ leadId: undefined }` gets
    // dropped entirely by JSON.stringify (body becomes `{}`), so the server
    // never receives a clear instruction. An explicit `null` is required.
    await waitFor(() => {
      expect(updateSprint).toHaveBeenCalledWith('spr-1', { leadId: null });
    });

    // After the reload triggered by patchSprint, the page reflects the
    // persisted (not just locally-assumed) cleared lead.
    await waitFor(() => {
      expect(screen.getByText('No lead')).toBeInTheDocument();
    });
    expect(screen.queryByText('Priya')).not.toBeInTheDocument();
  });
});
