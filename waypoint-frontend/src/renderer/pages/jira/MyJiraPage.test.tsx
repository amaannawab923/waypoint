import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  getJiraConnectionStatus,
  getJiraTransitions,
  listJiraComments,
  listMyJiraTickets,
} from '@/data/jiraApi';
import {
  setJiraConnection,
  useJiraConnection,
  useLoadedJiraConnection,
} from '@/lib/jiraStore';
import { JiraApiError } from '@/types/jira';
import type { JiraComment, JiraTicket, JiraTruncation } from '@/types/jira';
import MyJiraPage from './MyJiraPage';
import { resetMyJiraQueueForTests } from './useMyJiraQueue';

// The "My work" tab pulls in JiraTicketRow, JiraTicketDrawer and
// JiraCommentComposer, all of which import their own slice of data/jiraApi —
// mocking the whole module here (rather than per-component) is what makes it
// possible to render the real page tree.
jest.mock('@/data/jiraApi', () => ({
  listMyJiraTickets: jest.fn(),
  dismissJiraTombstone: jest.fn(),
  resolveJiraConflict: jest.fn(),
  getJiraTransitions: jest.fn(),
  transitionJiraTicket: jest.fn(),
  getJiraPriorityOptions: jest.fn(),
  setJiraTicketPriority: jest.fn(),
  searchJiraAssignableUsers: jest.fn(),
  setJiraTicketAssignee: jest.fn(),
  listJiraComments: jest.fn(),
  postJiraComment: jest.fn(),
  deleteJiraComment: jest.fn(async () => undefined),
  // Permissions resolve closed here: these suites are not about Delete, and a
  // closed default keeps its button out of their queries entirely.
  getJiraCommentPermissions: jest.fn(async () => ({
    deleteAll: false,
    deleteOwn: false,
    editAll: false,
    editOwn: false,
  })),
  buildJiraCommentPermalink: jest.fn(() => 'https://example.invalid/browse/ENG-1?focusedCommentId=1'),
  getJiraConnectionStatus: jest.fn(),
}));
// useJiraConnection is here because the drawer and the comment composer both
// read the connected account from the same store — the drawer to build the
// real "Open in Jira" link, the composer to name who a comment posts as.
// setJiraConnection is here because the page's own ticket-list effect calls
// it directly (see MyJiraPage.tsx's fetchedRead effect) to re-push a fresh
// connection snapshot into the shared store once real counts are known —
// fixing the race where useLoadedJiraConnection's fast, local-only status
// read otherwise caches a zero-count snapshot that nothing ever refreshes.
jest.mock('@/lib/jiraStore', () => ({
  useLoadedJiraConnection: jest.fn(),
  useJiraConnection: jest.fn(),
  setJiraConnection: jest.fn(),
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

// Distinct `updatedAt`s, descending in array order. Two reasons they are not
// all equal: a shared timestamp would make every ordering assertion pass by
// accident under any comparator, and the four are deliberately already in the
// default sort's own order so that every test below this one is asserting
// what it was written to assert rather than a re-ordering.
const TICKETS: JiraTicket[] = [
  ticket({
    id: 't-eng-1',
    key: 'ENG-1',
    projectKey: 'ENG',
    role: 'assignee',
    title: 'Eng assignee ticket',
    updatedAt: '2026-09-04T10:00:00.000Z',
  }),
  ticket({
    id: 't-eng-2',
    key: 'ENG-2',
    projectKey: 'ENG',
    role: 'watcher',
    title: 'Eng watcher ticket',
    updatedAt: '2026-09-03T10:00:00.000Z',
  }),
  ticket({
    id: 't-plat-1',
    key: 'PLAT-1',
    projectKey: 'PLAT',
    role: 'reporter',
    title: 'Plat reporter ticket',
    updatedAt: '2026-09-02T10:00:00.000Z',
  }),
  ticket({
    id: 't-grw-1',
    key: 'GRW-1',
    projectKey: 'GRW',
    role: 'assignee',
    title: 'Grw assignee ticket',
    updatedAt: '2026-09-01T10:00:00.000Z',
  }),
];

/** The page reads a `{ tickets, truncated }` pair, not a bare array — the
 * flag is how it knows whether the list below is the queue or only the first
 * page-capped slice of it. Almost every test here is about the tickets, so
 * `truncated` defaults to the honest "this is all of it". */
const queueRead = (
  tickets: JiraTicket[],
  truncated: JiraTruncation = false,
) => ({
  tickets,
  truncated,
});

function mount() {
  jest.mocked(listMyJiraTickets).mockResolvedValue(queueRead(TICKETS));
  jest.mocked(getJiraTransitions).mockResolvedValue([]);
  jest.mocked(listJiraComments).mockResolvedValue({ comments: [], total: 0 });
  jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
  return render(
    <MemoryRouter>
      <MyJiraPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  // The fetchedRead effect calls getJiraConnectionStatus().then(...)
  // unconditionally after every successful ticket-list read — an
  // unconfigured jest.fn() would resolve `undefined` and `.then` on that is
  // fine, but leaving it entirely unmocked (returning undefined itself,
  // not a promise) would throw. A generic default here means individual
  // tests only need their own mockResolvedValue when the exact returned
  // shape matters to that test.
  jest.mocked(getJiraConnectionStatus).mockResolvedValue({
    connected: true,
    accountName: 'Max Chen',
    accountEmail: 'max@northwind.dev',
    accountId: '5f8a',
    site: 'waypoint123.atlassian.net',
    lastSyncAt: new Date().toISOString(),
    issueCount: 0,
    projectCount: 0,
    countsTruncated: false,
  });
  // The query outlives the component on purpose — it is what survives the
  // drawer's Expand navigating away and back — which means it also outlives
  // an `it()` block unless something resets it. Without this line a test that
  // clicks a filter chip silently changes the starting state of every test
  // after it, and the failures read as flake rather than as leakage.
  resetMyJiraQueueForTests();
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

/** The issue keys currently rendered, in DOM order — each row prints its own
 *  key in a `<span>` as "ENG-9". Order is the entire point of the sort tests,
 *  and presence alone would let a broken comparator pass every one of them. */
function renderedKeys(): string[] {
  // A matcher function rather than a regex, because the row splits its key
  // across elements to color the project half — `<b>ENG</b>-9` — so the
  // string "ENG-9" exists only as the span's combined textContent and a plain
  // text matcher never sees it.
  return screen
    .getAllByText((_content, element) =>
      /^[A-Z]+-\d+$/.test(element?.textContent ?? ''),
    )
    .map((el) => el.textContent ?? '');
}

function mountWith(tickets: JiraTicket[]) {
  jest.mocked(listMyJiraTickets).mockResolvedValue(queueRead(tickets));
  jest.mocked(getJiraTransitions).mockResolvedValue([]);
  jest.mocked(listJiraComments).mockResolvedValue({ comments: [], total: 0 });
  jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
  return render(
    <MemoryRouter>
      <MyJiraPage />
    </MemoryRouter>,
  );
}

describe('MyJiraPage — sorting', () => {
  // Deliberately in none of the three sort orders as written, so no assertion
  // below can pass just because the page rendered the array it was handed.
  const UNSORTED: JiraTicket[] = [
    ticket({
      id: 's-1',
      key: 'ENG-81',
      title: 'Oldest, low',
      priority: 'low',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }),
    ticket({
      id: 's-2',
      key: 'ENG-9',
      title: 'Newest, none',
      priority: 'none',
      updatedAt: '2026-09-03T00:00:00.000Z',
    }),
    ticket({
      id: 's-3',
      key: 'ENG-10',
      title: 'Middle, urgent',
      priority: 'urgent',
      updatedAt: '2026-09-02T00:00:00.000Z',
    }),
  ];

  function chooseSort(label: string) {
    fireEvent.click(screen.getByRole('button', { name: /^Sort:/ }));
    fireEvent.click(screen.getByRole('button', { name: label }));
  }

  it('defaults to most recently updated', async () => {
    mountWith(UNSORTED);
    await screen.findByText('Newest, none');

    expect(renderedKeys()).toEqual(['ENG-9', 'ENG-10', 'ENG-81']);
  });

  it('reorders by priority when asked', async () => {
    mountWith(UNSORTED);
    await screen.findByText('Newest, none');

    chooseSort('Priority');

    expect(renderedKeys()).toEqual(['ENG-10', 'ENG-81', 'ENG-9']);
  });

  // The reason compareIssueKeys exists rather than a bare string compare —
  // and the one ordering a user would notice being wrong immediately.
  it('reads the issue number as a number, not as text', async () => {
    mountWith(UNSORTED);
    await screen.findByText('Newest, none');

    chooseSort('Issue key');

    expect(renderedKeys()).toEqual(['ENG-9', 'ENG-10', 'ENG-81']);
  });
});

describe('MyJiraPage — search and status', () => {
  function typeSearch(text: string) {
    fireEvent.change(screen.getByLabelText('Search your Jira queue'), {
      target: { value: text },
    });
  }

  it('narrows the list to matching titles', async () => {
    mount();
    await screen.findByText('Eng assignee ticket');

    typeSearch('watcher');

    expect(screen.getByText('Eng watcher ticket')).toBeInTheDocument();
    expect(screen.queryByText('Eng assignee ticket')).not.toBeInTheDocument();
    expect(screen.getByText('1 issue · 1 Jira project')).toBeInTheDocument();
  });

  // "PLAT-1" is how people refer to their own work out loud; a search box on
  // a list that prints the key on every row has to find it by that key.
  it('matches the issue key as well as the title', async () => {
    mount();
    await screen.findByText('Eng assignee ticket');

    typeSearch('plat-1');

    expect(screen.getByText('Plat reporter ticket')).toBeInTheDocument();
    expect(screen.queryByText('Eng assignee ticket')).not.toBeInTheDocument();
  });

  it('narrows to the selected statuses', async () => {
    mountWith([
      ticket({
        id: 'st-1',
        key: 'ENG-1',
        title: 'Todo one',
        stateName: 'To Do',
      }),
      ticket({
        id: 'st-2',
        key: 'ENG-2',
        title: 'Doing one',
        stateName: 'In Progress',
      }),
    ]);
    await screen.findByText('Todo one');

    fireEvent.click(screen.getByRole('button', { name: /^Status/ }));
    fireEvent.click(screen.getByLabelText('In Progress'));

    expect(screen.getByText('Doing one')).toBeInTheDocument();
    expect(screen.queryByText('Todo one')).not.toBeInTheDocument();
  });
});

// "No tickets match these filters." over an unfiltered, genuinely empty queue
// reads as a malfunction. These are two different pieces of news and they now
// get two different sentences.
describe('MyJiraPage — empty queue is not the same as no match', () => {
  it('says the queue itself is empty when nothing was read and nothing is filtered', async () => {
    mountWith([]);

    expect(
      await screen.findByText('Nothing in your Jira queue.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('No tickets match these filters.'),
    ).not.toBeInTheDocument();
  });

  it('offers a Clear filters that actually brings the rows back', async () => {
    mount();
    await screen.findByText('Eng assignee ticket');

    fireEvent.change(screen.getByLabelText('Search your Jira queue'), {
      target: { value: 'nothing matches this' },
    });
    expect(
      screen.getByText('No tickets match these filters.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Nothing in your Jira queue.'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(screen.getByText('Eng assignee ticket')).toBeInTheDocument();
    expect(screen.getByText('Grw assignee ticket')).toBeInTheDocument();
  });

  // A read that never reached Jira must not produce EITHER sentence — both
  // are claims about what the user's Jira contains.
  it('lets a failed read win over both empty states', async () => {
    jest
      .mocked(listMyJiraTickets)
      .mockRejectedValue(new Error("Couldn't reach Jira."));
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
    render(
      <MemoryRouter>
        <MyJiraPage />
      </MemoryRouter>,
    );

    await screen.findByRole('alert');
    expect(
      screen.queryByText('Nothing in your Jira queue.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('No tickets match these filters.'),
    ).not.toBeInTheDocument();
  });
});

describe('MyJiraPage — pagination', () => {
  // 30 > PAGE_SIZE (25), so exactly two pages with a short second one — the
  // shape that catches an off-by-one in either the slice or the range label.
  const MANY: JiraTicket[] = Array.from({ length: 30 }, (_, i) =>
    ticket({
      id: `p-${i}`,
      key: `ENG-${i + 1}`,
      projectKey: i < 20 ? 'ENG' : 'PLAT',
      title: `Paged ticket ${i + 1}`,
      updatedAt: `2026-09-01T00:00:${String(59 - i).padStart(2, '0')}.000Z`,
    }),
  );

  it('shows one page of rows and states the range exactly', async () => {
    mountWith(MANY);
    await screen.findByText('Paged ticket 1');

    expect(renderedKeys()).toHaveLength(25);
    expect(screen.getByText('Showing 1–25 of 30')).toBeInTheDocument();
    expect(screen.queryByText('Paged ticket 26')).not.toBeInTheDocument();
  });

  it('advances to the rest on Next', async () => {
    mountWith(MANY);
    await screen.findByText('Paged ticket 1');

    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));

    expect(screen.getByText('Showing 26–30 of 30')).toBeInTheDocument();
    expect(screen.getByText('Paged ticket 26')).toBeInTheDocument();
    expect(screen.queryByText('Paged ticket 1')).not.toBeInTheDocument();
  });

  // jiraClient's own note says a personal queue is 10-40 issues, so most
  // users never page at all. "Page 1 of 1" beside two dead arrows is chrome
  // that implies there is somewhere else to be.
  it('renders no pager at all when everything fits on one page', async () => {
    mount();
    await screen.findByText('Eng assignee ticket');

    expect(
      screen.queryByRole('navigation', { name: 'Ticket list pages' }),
    ).not.toBeInTheDocument();
  });

  // Page 3 of one filter is not page 3 of another, so changing what is in the
  // list has to go back to the start. Being on a page past the end would
  // otherwise render "No tickets match these filters." over a list with
  // plenty in it.
  it('returns to the first page when the filters change', async () => {
    mountWith(MANY);
    await screen.findByText('Paged ticket 1');
    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(screen.getByText('Showing 26–30 of 30')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^ENG \d/ }));

    expect(screen.getByText('Paged ticket 1')).toBeInTheDocument();
    expect(screen.queryByText(/^Showing 26/)).not.toBeInTheDocument();
  });
});

// "4 issues · 3 Jira projects" over a page-capped read is a count presented
// as a total. The strip is what stops the page making that claim silently.
describe('MyJiraPage — a page-capped read says so', () => {
  function mountCapped(truncated: JiraTruncation) {
    jest
      .mocked(listMyJiraTickets)
      .mockResolvedValue(queueRead(TICKETS, truncated));
    jest.mocked(getJiraTransitions).mockResolvedValue([]);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
    return render(
      <MemoryRouter>
        <MyJiraPage />
      </MemoryRouter>,
    );
  }

  it('warns that the list is only the first slice of the queue', async () => {
    mountCapped('page-cap');
    await screen.findByText('Eng assignee ticket');

    expect(
      screen.getByText(/more issues than this app reads in one go/),
    ).toBeInTheDocument();
  });

  // A twelve-issue queue can land here — Jira reports more work and returns
  // no cursor on the very first page. Reusing the cap's sentence would put
  // "this is the first 500" over twelve rows, which is a louder version of
  // the wrong claim the banner exists to prevent.
  it('does not claim a 500 cap when Jira simply stopped paging', async () => {
    mountCapped('no-cursor');
    await screen.findByText('Eng assignee ticket');

    expect(
      screen.getByText(/more issues than it would hand over/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/first 500/)).not.toBeInTheDocument();
  });

  it('says nothing at all when the read was complete', async () => {
    mountCapped(false);
    await screen.findByText('Eng assignee ticket');

    expect(
      screen.queryByText(/more issues than this app reads in one go/),
    ).not.toBeInTheDocument();
  });

  // A standing fact, not an event. role="alert" is JiraLoadError's register
  // here — interrupting a screen reader mid-sentence to report that a
  // successful read was long is the wrong urgency, and it would also make
  // the several `findByRole('alert')` waits below ambiguous.
  it('is not announced as an alert', async () => {
    mountCapped('page-cap');
    await screen.findByText('Eng assignee ticket');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// "No tickets match these filters." is a claim about the user's Jira. A read
// that never reached Jira must not make it — the three cases below are the
// difference between "your queue is empty" and "we could not ask".
describe('MyJiraPage — a failed ticket read is not an empty queue', () => {
  function mountFailing(error: Error) {
    jest.mocked(listMyJiraTickets).mockRejectedValue(error);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
    return render(
      <MemoryRouter>
        <MyJiraPage />
      </MemoryRouter>,
    );
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
      accountId: '5f8a',
      site: 'waypoint123.atlassian.net',
      lastSyncAt,
      issueCount: 4,
      projectCount: 3,
      countsTruncated: false,
    };
  }

  it('says so plainly when nothing has synced yet', async () => {
    jest.mocked(listMyJiraTickets).mockResolvedValue(queueRead(TICKETS));
    jest.mocked(useLoadedJiraConnection).mockReturnValue(connection(null));
    render(
      <MemoryRouter>
        <MyJiraPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('not synced yet')).toBeInTheDocument();
    expect(screen.queryByText(/^synced /)).not.toBeInTheDocument();
  });

  it('reports a real age once a read has landed', async () => {
    jest.mocked(listMyJiraTickets).mockResolvedValue(queueRead(TICKETS));
    jest
      .mocked(useLoadedJiraConnection)
      .mockReturnValue(connection(new Date().toISOString()));
    render(
      <MemoryRouter>
        <MyJiraPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/^synced \d+s ago$/)).toBeInTheDocument();
    expect(screen.queryByText('not synced yet')).not.toBeInTheDocument();
  });
});

// Found in review: useLoadedJiraConnection's own status read is a fast,
// purely-local file check, while the ticket-list read below is a real
// network round trip — so the status read routinely lands first and caches
// a connection snapshot with issueCount/projectCount/lastSyncAt still at
// their zero/null defaults into the shared jiraStore, which nothing
// afterward ever refreshed. Symptom: "Connected" next to "0 issues" / "not
// synced yet" that never correct themselves, on every reconnect or app
// restart, until something happens to visit "My work" or hit Refresh.
describe('MyJiraPage — refreshes the shared connection snapshot once real counts are known', () => {
  it('re-pushes the connection store with fresh counts as soon as the ticket list read lands', async () => {
    jest.mocked(listMyJiraTickets).mockResolvedValue(queueRead(TICKETS));
    // The stale snapshot useLoadedJiraConnection's own (mocked, in this
    // test) fast path would have cached — zero counts, no sync time —
    // exactly what the race produces in the real store.
    jest.mocked(useLoadedJiraConnection).mockReturnValue({
      connected: true,
      accountName: 'Max Chen',
      accountEmail: 'max@northwind.dev',
      accountId: '5f8a',
      site: 'waypoint123.atlassian.net',
      lastSyncAt: null,
      issueCount: 0,
      projectCount: 0,
      countsTruncated: false,
    });
    const freshStatus = {
      connected: true,
      accountName: 'Max Chen',
      accountEmail: 'max@northwind.dev',
      accountId: '5f8a',
      site: 'waypoint123.atlassian.net',
      lastSyncAt: new Date().toISOString(),
      issueCount: TICKETS.length,
      projectCount: 1,
      countsTruncated: false,
    };
    jest.mocked(getJiraConnectionStatus).mockResolvedValue(freshStatus);

    render(
      <MemoryRouter>
        <MyJiraPage />
      </MemoryRouter>,
    );

    // The ticket list itself renders as proof the read actually landed —
    // waiting on this is what makes the assertion below meaningful rather
    // than a race against the effect that fires it.
    await screen.findByText(TICKETS[0].title);

    expect(getJiraConnectionStatus).toHaveBeenCalled();
    expect(setJiraConnection).toHaveBeenCalledWith(freshStatus);
  });

  it('does not re-push the store on a render that carries no new read', () => {
    jest.mocked(listMyJiraTickets).mockResolvedValue(queueRead(TICKETS));
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);

    render(
      <MemoryRouter>
        <MyJiraPage />
      </MemoryRouter>,
    );

    // Before the list read resolves, fetchedRead is still undefined — the
    // effect's own early return must not call through regardless.
    expect(setJiraConnection).not.toHaveBeenCalled();
  });
});

// `JiraConnectionCard` on the All-Projects page links straight here with
// `?tab=connection` so the click lands on the tab it promised, not on "My
// work" with the user left to find Connection themselves. These three cases
// are the whole contract: a valid tab loads directly on it, and anything
// else — no param at all, or a value nobody put there on purpose — falls
// back to 'work' rather than rendering neither tab's body.
describe('MyJiraPage — initial tab from the ?tab= query param', () => {
  function connectionStatus() {
    return {
      connected: true,
      accountName: 'Max Chen',
      accountEmail: 'max@northwind.dev',
      accountId: '5f8a',
      site: 'waypoint123.atlassian.net',
      lastSyncAt: '2026-09-01T00:00:00.000Z',
      issueCount: 4,
      projectCount: 3,
      countsTruncated: false,
    };
  }

  function mountAt(path: string) {
    jest.mocked(listMyJiraTickets).mockResolvedValue(queueRead(TICKETS));
    jest.mocked(getJiraTransitions).mockResolvedValue([]);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(connectionStatus());
    return render(
      <MemoryRouter initialEntries={[path]}>
        <MyJiraPage />
      </MemoryRouter>,
    );
  }

  it('loads on the Connection tab when the param says so', async () => {
    mountAt('/my-jira?tab=connection');

    // "Refresh now" only exists inside JiraConnectionPanel, which the
    // Connection tab is the only place that mounts.
    expect(
      await screen.findByRole('button', { name: 'Refresh now' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Search your Jira queue'),
    ).not.toBeInTheDocument();
  });

  it('falls back to My work when the param is absent', async () => {
    mountAt('/my-jira');

    expect(
      await screen.findByLabelText('Search your Jira queue'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Refresh now' }),
    ).not.toBeInTheDocument();
  });

  it('falls back to My work for a value that is not a real tab', async () => {
    mountAt('/my-jira?tab=nonsense');

    expect(
      await screen.findByLabelText('Search your Jira queue'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Refresh now' }),
    ).not.toBeInTheDocument();
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
    jest.mocked(listMyJiraTickets).mockResolvedValue(queueRead([described]));
    jest.mocked(listJiraComments).mockResolvedValue({ comments: [], total: 0 });
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
    jest.mocked(useJiraConnection).mockReturnValue(undefined);
    render(
      <MemoryRouter>
        <MyJiraPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByText('Described ticket'));

    const body = await screen.findByText(/First paragraph\./);
    expect(body).toHaveClass('whitespace-pre-wrap');
  });
});

// jiraMap.ts (main) maps a comment's missing `created` to null rather than
// fabricating "now" — see its own comment for why. This is the other half of
// that fix: the drawer has to render the null honestly rather than computing
// a bogus duration against it or crashing.
describe('JiraTicketDrawer — comment timestamps', () => {
  it('shows "Unknown" for a comment whose created date Jira omitted', async () => {
    const undated = ticket({
      id: 't-undated-comment',
      key: 'ENG-11',
      projectKey: 'ENG',
      title: 'Ticket with an undated comment',
    });
    const comment: JiraComment = {
      id: 'c-1',
      ticketId: 't-undated-comment',
      authorName: 'Sam Lee',
      authorAccountId: 'acct-1',
      body: 'Replay log attached.',
      createdAt: null,
      parentId: null,
      postedByWaypoint: false,
      disclosureText: null,
    };
    jest.mocked(listMyJiraTickets).mockResolvedValue(queueRead([undated]));
    jest
      .mocked(listJiraComments)
      .mockResolvedValue({ comments: [comment], total: 1 });
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
    jest.mocked(useJiraConnection).mockReturnValue(undefined);
    render(
      <MemoryRouter>
        <MyJiraPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByText('Ticket with an undated comment'));

    expect(await screen.findByText('Replay log attached.')).toBeInTheDocument();
    expect(screen.getByText('Unknown', { exact: false })).toBeInTheDocument();
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
    jest.mocked(listMyJiraTickets).mockResolvedValue(queueRead(TICKETS));
    jest.mocked(getJiraTransitions).mockResolvedValue([
      {
        id: '31',
        targetStateName: 'In Progress',
        targetStateColor: 'var(--warning)',
        requiresFields: [],
      },
    ]);
    jest.mocked(useLoadedJiraConnection).mockReturnValue(undefined);
    const { container } = render(
      <MemoryRouter>
        <MyJiraPage />
      </MemoryRouter>,
    );

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
