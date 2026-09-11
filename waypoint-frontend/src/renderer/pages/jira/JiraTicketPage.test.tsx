import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  getJiraTransitions,
  listJiraComments,
  listMyJiraTickets,
} from '@/data/jiraApi';
import { useJiraConnection, useLoadedJiraConnection } from '@/lib/jiraStore';
import type { JiraTicket, JiraTruncation } from '@/types/jira';
import JiraTicketPage from './JiraTicketPage';

jest.mock('@/data/jiraApi', () => ({
  listMyJiraTickets: jest.fn(),
  getJiraTransitions: jest.fn(),
  transitionJiraTicket: jest.fn(),
  getJiraPriorityOptions: jest.fn(),
  setJiraTicketPriority: jest.fn(),
  searchJiraAssignableUsers: jest.fn(),
  setJiraTicketAssignee: jest.fn(),
  listJiraComments: jest.fn(),
  postJiraComment: jest.fn(),
  // Never actually called: getJiraCommentPermissions below resolves closed,
  // so canEditComment (JiraTicketDetail.tsx) never reaches this. Present
  // anyway so JiraCommentComposer's own import of it is never undefined —
  // same reasoning as every other export named here.
  prepareJiraCommentEdit: jest.fn(),
  updateJiraComment: jest.fn(),
  deleteJiraComment: jest.fn(async () => undefined),
  // Same reason as prepareJiraCommentEdit above: never reached with
  // permissions closed, but named here so the freshness guards' import of
  // it is never undefined. Note for anyone who later writes an Edit or
  // Delete test in this file: null is this function's "Jira answered 404"
  // answer, so a guard reaching this default would refuse rather than
  // proceed — override it with a comment before exercising either path.
  getJiraComment: jest.fn(async () => null),
  // Permissions resolve closed here: these suites are not about Delete or
  // Edit, and a closed default keeps both buttons out of their queries
  // entirely.
  getJiraCommentPermissions: jest.fn(async () => ({
    deleteAll: false,
    deleteOwn: false,
    editAll: false,
    editOwn: false,
  })),
  buildJiraCommentPermalink: jest.fn(() => 'https://example.invalid/browse/ENG-1?focusedCommentId=1'),
}));
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

function mountAt(
  key: string,
  tickets: JiraTicket[],
  truncated: JiraTruncation = false,
) {
  jest.mocked(listMyJiraTickets).mockResolvedValue({ tickets, truncated });
  jest.mocked(getJiraTransitions).mockResolvedValue([]);
  jest.mocked(listJiraComments).mockResolvedValue({ comments: [], total: 0 });
  jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
  jest.mocked(useJiraConnection).mockReturnValue(undefined);
  return render(
    <MemoryRouter initialEntries={[`/my-jira/${key}`]}>
      <Routes>
        <Route path="/my-jira/:ticketKey" element={<JiraTicketPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('JiraTicketPage', () => {
  it('renders the issue it finds in the queue read', async () => {
    mountAt('ENG-1', [ticket({ title: 'Webhook receiver drops events' })]);

    expect(
      await screen.findByText('Webhook receiver drops events'),
    ).toBeInTheDocument();
  });

  it('says the issue is outside your queue when the read was complete', async () => {
    mountAt('ENG-999', [ticket()]);

    expect(await screen.findByText(/isn't in your queue/)).toBeInTheDocument();
    expect(
      screen.getByText(/assigned, reported or watching/),
    ).toBeInTheDocument();
  });

  // The distinction the truncation flag exists to make sayable. "This issue
  // isn't one of those" is a claim about a set the app never finished
  // reading, and stating it over a capped read is simply false — the issue
  // may be squarely in the user's queue and have fallen off the last page.
  it('admits the page cap instead, when the read was capped', async () => {
    mountAt('ENG-999', [ticket()], 'page-cap');

    expect(
      await screen.findByText(/more issues than this app reads in one go/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/assigned, reported or watching/),
    ).not.toBeInTheDocument();
  });

  // The other way a read can be a prefix, and the reason `truncated` carries
  // a reason instead of a boolean. This case says nothing about how much was
  // read — it can happen on page one — so naming the cap here would invent a
  // cause the data does not support.
  it('does not blame the page cap when Jira simply stopped paging', async () => {
    mountAt('ENG-999', [ticket()], 'no-cursor');

    expect(
      await screen.findByText(/more issues than it would hand over/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/first few hundred/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/assigned, reported or watching/),
    ).not.toBeInTheDocument();
  });
});
