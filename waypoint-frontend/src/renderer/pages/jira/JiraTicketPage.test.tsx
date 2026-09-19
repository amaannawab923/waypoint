import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  getJiraTicketByKey,
  getJiraTransitions,
  listJiraComments,
} from '@/data/jiraApi';
import { useJiraConnection, useLoadedJiraConnection } from '@/lib/jiraStore';
import { JiraApiError } from '@/types/jira';
import type { JiraTicket } from '@/types/jira';
import JiraTicketPage from './JiraTicketPage';

jest.mock('@/data/jiraApi', () => ({
  getJiraTicketByKey: jest.fn(),
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
  buildJiraCommentPermalink: jest.fn(
    () => 'https://example.invalid/browse/ENG-1?focusedCommentId=1',
  ),
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

function mountAt(key: string) {
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

// A real in-app navigation between two keys, unlike mountAt: keeps the SAME
// JiraTicketPage instance mounted across the URL change (matching, from the
// drawer's own "expand" button) so a test can exercise what actually
// happens on navigation rather than two independent mounts, each with its
// own fresh state.
function mountWithNav(initialKey: string, nextKey: string) {
  jest.mocked(getJiraTransitions).mockResolvedValue([]);
  jest.mocked(listJiraComments).mockResolvedValue({ comments: [], total: 0 });
  jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
  jest.mocked(useJiraConnection).mockReturnValue(undefined);
  return render(
    <MemoryRouter initialEntries={[`/my-jira/${initialKey}`]}>
      <Routes>
        <Route
          path="/my-jira/:ticketKey"
          element={
            <>
              <Link to={`/my-jira/${nextKey}`}>go to {nextKey}</Link>
              <JiraTicketPage />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('JiraTicketPage', () => {
  // ROAD-158: fetches the issue directly by key now, not by re-running the
  // old "my work" list query and searching it — so this asserts the fetch
  // itself is by-key, not just that the ticket renders.
  it('renders the issue it fetches by key', async () => {
    jest
      .mocked(getJiraTicketByKey)
      .mockResolvedValue(
        ticket({ key: 'ENG-1', title: 'Webhook receiver drops events' }),
      );

    mountAt('ENG-1');

    expect(
      await screen.findByText('Webhook receiver drops events'),
    ).toBeInTheDocument();
    expect(getJiraTicketByKey).toHaveBeenCalledWith('ENG-1');
  });

  it("says the issue isn't here when Jira answers not found", async () => {
    jest
      .mocked(getJiraTicketByKey)
      .mockRejectedValue(
        new JiraApiError('Jira found no such issue.', 'not_found'),
      );

    mountAt('ENG-999');

    expect(await screen.findByText(/ENG-999 isn't here/)).toBeInTheDocument();
    expect(
      screen.getByText(/may not exist, or.*may not be visible/),
    ).toBeInTheDocument();
  });

  // A not-found and a genuine failure (offline, revoked token, Jira down)
  // are different facts and must not collapse into the same "isn't here"
  // copy — that would tell an offline user their issue doesn't exist.
  it('shows a load error, not a not-found state, for a non-404 failure', async () => {
    jest
      .mocked(getJiraTicketByKey)
      .mockRejectedValue(
        new JiraApiError('Jira is rate-limiting this account.', 'jira_error'),
      );

    mountAt('ENG-1');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Jira is rate-limiting this account.',
    );
    expect(screen.queryByText(/isn't here/)).not.toBeInTheDocument();
  });

  // Found in review: useAsync never clears `data` on a re-run — only a
  // successful fetch calls setData — so navigating straight from one real
  // issue to a key that then 404s left the PREVIOUS issue's detail on
  // screen under the new URL: `notFound` skipped the error branch, and the
  // stale `ticket` skipped the "isn't here" branch too. Reproduced here
  // with a real in-app navigation (mountWithNav), the same mechanism that
  // actually triggers it, rather than two independent mounts that would
  // each get their own fresh state and never exercise the bug at all.
  it('clears the previous issue immediately on navigation, instead of leaving it on screen under a 404 key', async () => {
    jest
      .mocked(getJiraTicketByKey)
      .mockResolvedValueOnce(
        ticket({ key: 'ENG-1', title: 'Webhook receiver drops events' }),
      )
      .mockRejectedValueOnce(
        new JiraApiError('Jira found no such issue.', 'not_found'),
      );

    mountWithNav('ENG-1', 'ENG-2');
    await screen.findByText('Webhook receiver drops events');

    fireEvent.click(screen.getByText('go to ENG-2'));

    await waitFor(() =>
      expect(
        screen.queryByText('Webhook receiver drops events'),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/ENG-2 isn't here/)).toBeInTheDocument();
  });
});
