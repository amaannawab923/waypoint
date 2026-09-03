import '@testing-library/jest-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  addComment,
  addWorkItemLink,
  deleteWorkItem,
  getCurrentUser,
  getWorkItem,
  getWorkItemByIdentifier,
  listActivity,
  listAgentAssignments,
  listAgents,
  listComments,
  listCycles,
  listLabels,
  listMembers,
  listModules,
  listStates,
  listSubItems,
  removeWorkItemLink,
  takeBackOverFromAgent,
  toggleWorkItemAgent,
  toggleWorkItemAssignee,
  toggleWorkItemLabel,
  updateWorkItem,
} from '@/mock/api';
import { useProject } from '@/layouts/ProjectLayout';
import type { Comment, Member, Project, WorkItem } from '@/types/entities';
import { WorkItemDetailContent } from './WorkItemDetailPage';

jest.mock('@/mock/api', () => ({
  addComment: jest.fn(),
  addWorkItemLink: jest.fn(),
  deleteWorkItem: jest.fn(),
  getCurrentUser: jest.fn(),
  getWorkItem: jest.fn(),
  getWorkItemByIdentifier: jest.fn(),
  listActivity: jest.fn(),
  listAgentAssignments: jest.fn(),
  listAgents: jest.fn(),
  listComments: jest.fn(),
  listCycles: jest.fn(),
  listLabels: jest.fn(),
  listMembers: jest.fn(),
  listModules: jest.fn(),
  listStates: jest.fn(),
  listSubItems: jest.fn(),
  removeWorkItemLink: jest.fn(),
  takeBackOverFromAgent: jest.fn(),
  toggleWorkItemAgent: jest.fn(),
  toggleWorkItemAssignee: jest.fn(),
  toggleWorkItemLabel: jest.fn(),
  updateWorkItem: jest.fn(),
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
  network: 'public',
  leadId: null,
  defaultAssigneeId: null,
  timezone: 'UTC',
  features: {
    cycles: true,
    modules: true,
    views: true,
    pages: true,
    intake: true,
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

const ITEM: WorkItem = {
  id: 'wi-1',
  projectId: 'proj-1',
  identifier: 'LAUNCH-3',
  sequenceId: 3,
  title: 'Responsive nav breaks on iPad landscape',
  description: '',
  stateId: 'st-1',
  priority: 'none',
  assigneeIds: [],
  labelIds: [],
  moduleId: null,
  cycleId: null,
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

function commentWith(bodyHtml: string): Comment {
  return {
    id: 'cm-1',
    workItemId: 'wi-1',
    authorId: 'mem-1',
    bodyHtml,
    createdAt: new Date().toISOString(),
  };
}

function mount(comments: Comment[]) {
  jest
    .mocked(useProject)
    .mockReturnValue({ project: PROJECT, reloadProject: jest.fn() });
  jest.mocked(getWorkItemByIdentifier).mockResolvedValue(ITEM);
  jest.mocked(listStates).mockResolvedValue([]);
  jest.mocked(listLabels).mockResolvedValue([]);
  jest.mocked(listModules).mockResolvedValue([]);
  jest.mocked(listCycles).mockResolvedValue([]);
  jest.mocked(listMembers).mockResolvedValue([MEMBER]);
  jest.mocked(getCurrentUser).mockResolvedValue(MEMBER);
  jest.mocked(listAgents).mockResolvedValue([]);
  jest.mocked(listAgentAssignments).mockResolvedValue([]);
  jest.mocked(listSubItems).mockResolvedValue([]);
  jest.mocked(listActivity).mockResolvedValue([]);
  jest.mocked(listComments).mockResolvedValue(comments);
  jest.mocked(getWorkItem).mockResolvedValue(ITEM);
  jest.mocked(addComment).mockResolvedValue(commentWith(''));
  jest.mocked(addWorkItemLink).mockResolvedValue(ITEM);
  jest.mocked(removeWorkItemLink).mockResolvedValue(ITEM);
  jest.mocked(deleteWorkItem).mockResolvedValue(undefined);
  jest.mocked(takeBackOverFromAgent).mockResolvedValue(undefined as never);
  jest.mocked(toggleWorkItemAgent).mockResolvedValue(undefined as never);
  jest.mocked(toggleWorkItemAssignee).mockResolvedValue(undefined as never);
  jest.mocked(toggleWorkItemLabel).mockResolvedValue(undefined as never);
  jest.mocked(updateWorkItem).mockResolvedValue(ITEM);

  return render(
    <MemoryRouter>
      <WorkItemDetailContent projectId="proj-1" identifier="LAUNCH-3" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('WorkItemDetailPage → comment rendering (stored XSS fix)', () => {
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
});
