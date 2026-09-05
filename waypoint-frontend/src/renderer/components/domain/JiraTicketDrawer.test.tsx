import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  listJiraComments,
  searchJiraAssignableUsers,
  setJiraTicketAssignee,
} from '@/data/jiraApi';
import { useJiraConnection } from '@/lib/jiraStore';
import { showErrorToast } from '@/lib/toast';
import type { JiraConnectionStatus, JiraTicket } from '@/types/jira';
import { JiraTicketDrawer } from './JiraTicketDrawer';

// The drawer owns the assignee write and the picker owns its own debounced
// search, so this is the level the reassign flow is actually testable at —
// mocking the data module is what lets the real drawer, the real chip and the
// real portaled panel render together, exactly as JiraTicketRow.test.tsx does
// for the priority flow.
jest.mock('@/data/jiraApi', () => ({
  listJiraComments: jest.fn(),
  postJiraComment: jest.fn(),
  searchJiraAssignableUsers: jest.fn(),
  setJiraTicketAssignee: jest.fn(),
}));
jest.mock('@/lib/jiraStore', () => ({ useJiraConnection: jest.fn() }));
jest.mock('@/lib/toast', () => ({ showErrorToast: jest.fn() }));

const ME = 'acct-max';

function ticket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return {
    id: '10421',
    key: 'ENG-421',
    projectKey: 'ENG',
    title: 'Webhook receiver drops events past 500/min',
    role: 'assignee',
    stateName: 'In Progress',
    stateColor: 'var(--warning)',
    priority: 'urgent',
    priorityId: '1',
    priorityName: 'Highest',
    assigneeName: 'Max Chen',
    assigneeAccountId: ME,
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

const CONNECTION: JiraConnectionStatus = {
  connected: true,
  accountName: 'Max Chen',
  accountEmail: 'max@northwind.dev',
  accountId: ME,
  site: 'waypoint123.atlassian.net',
  lastSyncAt: '2026-01-01T00:00:00.000Z',
  issueCount: 6,
  projectCount: 3,
};

const ASSIGNABLE = [
  { accountId: 'acct-sam', displayName: 'Sam Lee', avatarUrl: null },
  { accountId: 'acct-priya', displayName: 'Priya Raman', avatarUrl: null },
];

const onTicketUpdated = jest.fn();

function renderDrawer(overrides: Partial<JiraTicket> = {}) {
  return render(
    <JiraTicketDrawer
      ticket={ticket(overrides)}
      onTicketUpdated={onTicketUpdated}
      onClose={jest.fn()}
    />,
  );
}

/** By accessible name, deliberately — the chip's visible text is also its
 * name, but `title` is where the disabled reason goes, so the aria-label is
 * what keeps the control named in the one state a screen-reader user most
 * needs it (the same trap JiraPriorityChip documents). */
function assigneeChip(name = 'Assignee: Max Chen'): HTMLElement {
  return screen.getByRole('button', { name });
}

/** The picker debounces its search by ~250ms; nothing arrives until the timers
 * this advances have run. */
async function runDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.mocked(listJiraComments).mockResolvedValue([]);
  jest.mocked(useJiraConnection).mockReturnValue(CONNECTION);
  jest.mocked(searchJiraAssignableUsers).mockResolvedValue(ASSIGNABLE);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the assignee chip', () => {
  it('is a real button, not the plain label it used to be', () => {
    renderDrawer();

    const chip = assigneeChip();
    expect(chip.tagName).toBe('BUTTON');
    expect(chip).toBeEnabled();
  });

  // Everything else in that chip row — reporter, epic, points, sprint — is
  // read-only here, and must not have quietly become a control alongside it.
  it('leaves the reporter chip a plain label', () => {
    renderDrawer();

    expect(screen.getByText('Reporter · Sam Lee').tagName).not.toBe('BUTTON');
  });

  it('reads nothing from Jira until it is opened', () => {
    renderDrawer();

    expect(searchJiraAssignableUsers).not.toHaveBeenCalled();
  });

  // Keeps its name while disabled: the reason goes in `title`, not over the
  // top of the label.
  it('is disabled, and says why, while the ticket is in conflict', () => {
    renderDrawer({ hasConflict: true });

    const chip = assigneeChip();
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('title', 'Write paused until reloaded');
  });
});

describe('opening the assignee picker', () => {
  it('searches this issue by its KEY, not its id', async () => {
    renderDrawer();

    fireEvent.click(assigneeChip());
    await runDebounce();

    // ENG-421, never 10421: Jira's assignable-user search takes the issue key.
    expect(searchJiraAssignableUsers).toHaveBeenCalledWith('ENG-421', '');
  });

  it('lists the people the site says can take it', async () => {
    renderDrawer();

    fireEvent.click(assigneeChip());
    await runDebounce();

    expect(screen.getByRole('button', { name: 'Sam Lee' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Priya Raman' }),
    ).toBeInTheDocument();
  });

  // The founder's decision: the picker offers Unassign, not only
  // assign-to-a-person. Both it and "Assign to me" are present with no query
  // typed, because neither needs a search to work.
  it('offers Unassign and Assign to me without a query', async () => {
    renderDrawer();

    fireEvent.click(assigneeChip());

    expect(
      screen.getByRole('button', { name: /Unassign/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Assign to me/ }),
    ).toBeInTheDocument();
  });

  it('marks where the issue already is', async () => {
    renderDrawer();

    fireEvent.click(assigneeChip());

    expect(
      screen.getByRole('button', { name: /Assign to me\s+current/i }),
    ).toBeInTheDocument();
  });

  // An unassigned issue is a real state, not an unknown one, so Unassign is
  // what carries the marker there.
  it('marks Unassign as current on an unassigned issue', async () => {
    renderDrawer({ assigneeName: 'Unassigned', assigneeAccountId: null });

    fireEvent.click(assigneeChip('Assignee: Unassigned'));

    expect(
      screen.getByRole('button', { name: /Unassign\s+current/i }),
    ).toBeInTheDocument();
  });

  it('debounces typing into one search per pause, not one per keystroke', async () => {
    renderDrawer();

    fireEvent.click(assigneeChip());
    await runDebounce();
    expect(searchJiraAssignableUsers).toHaveBeenCalledTimes(1);

    const box = screen.getByRole('textbox', { name: /Search people/i });
    fireEvent.change(box, { target: { value: 's' } });
    fireEvent.change(box, { target: { value: 'sa' } });
    fireEvent.change(box, { target: { value: 'sam' } });
    await runDebounce();

    expect(searchJiraAssignableUsers).toHaveBeenCalledTimes(2);
    expect(searchJiraAssignableUsers).toHaveBeenLastCalledWith(
      'ENG-421',
      'sam',
    );
  });

  // A site can restrict "Browse users and groups", which answers this search
  // with a 403. Rendering that as "nobody matches" would tell the user their
  // colleagues do not exist — the same defect JiraLoadError exists for.
  it('renders a forbidden search as an error, never as an empty result', async () => {
    jest
      .mocked(searchJiraAssignableUsers)
      .mockRejectedValue(
        new Error("Your Jira account isn't allowed to do that."),
      );
    renderDrawer();

    fireEvent.click(assigneeChip());
    await runDebounce();

    expect(screen.getByRole('alert')).toHaveTextContent(
      "Your Jira account isn't allowed to do that.",
    );
    expect(screen.queryByText(/Nobody assignable matches/i)).toBeNull();
    expect(screen.queryByText(/Nobody else can be assigned/i)).toBeNull();
  });

  // Unassign must survive a failed search: it needs no search to work, and it
  // is the one thing still writable on a site that hides its user directory.
  it('still offers Unassign and Assign to me after a failed search', async () => {
    jest
      .mocked(searchJiraAssignableUsers)
      .mockRejectedValue(new Error('Could not reach Jira.'));
    renderDrawer();

    fireEvent.click(assigneeChip());
    await runDebounce();

    expect(screen.getByRole('button', { name: /Unassign/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Assign to me/ })).toBeEnabled();
  });

  it('renders a genuinely empty result as an absence, not a failure', async () => {
    jest.mocked(searchJiraAssignableUsers).mockResolvedValue([]);
    renderDrawer();

    fireEvent.click(assigneeChip());
    await runDebounce();

    expect(
      screen.getByText(/Nobody else can be assigned this issue/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // "Assign to me" is built from the connected identity, not from a search —
  // so with no account id there is nothing it could write, and offering it
  // would be a button that can only fail.
  it('hides Assign to me when the connection has no account id', async () => {
    jest
      .mocked(useJiraConnection)
      .mockReturnValue({ ...CONNECTION, accountId: '' });
    renderDrawer();

    fireEvent.click(assigneeChip());

    expect(screen.queryByRole('button', { name: /Assign to me/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Unassign/ })).toBeEnabled();
  });
});

describe('reassigning', () => {
  it('writes the chosen account id and hands the re-read ticket up', async () => {
    const updated = ticket({
      role: 'none',
      assigneeName: 'Sam Lee',
      assigneeAccountId: 'acct-sam',
    });
    jest.mocked(setJiraTicketAssignee).mockResolvedValue(updated);
    renderDrawer();

    fireEvent.click(assigneeChip());
    await runDebounce();
    fireEvent.click(screen.getByRole('button', { name: 'Sam Lee' }));

    await waitFor(() =>
      expect(setJiraTicketAssignee).toHaveBeenCalledWith('10421', 'acct-sam'),
    );
    // Up to whoever owns the list behind this drawer, so the row is patched
    // too rather than left naming the previous assignee.
    expect(onTicketUpdated).toHaveBeenCalledWith(updated);
  });

  // The founder's Unassign decision, at the surface it is chosen from: a
  // literal null, not an empty string and not a missing argument.
  it('sends a literal null when Unassign is chosen', async () => {
    jest
      .mocked(setJiraTicketAssignee)
      .mockResolvedValue(
        ticket({ assigneeName: 'Unassigned', assigneeAccountId: null }),
      );
    renderDrawer();

    fireEvent.click(assigneeChip());
    fireEvent.click(screen.getByRole('button', { name: /Unassign/ }));

    await waitFor(() =>
      expect(setJiraTicketAssignee).toHaveBeenCalledWith('10421', null),
    );
    expect(jest.mocked(setJiraTicketAssignee).mock.calls[0][1]).toBeNull();
  });

  it('assigns to the connected account from the pinned row', async () => {
    jest.mocked(setJiraTicketAssignee).mockResolvedValue(ticket());
    renderDrawer({ assigneeName: 'Sam Lee', assigneeAccountId: 'acct-sam' });

    fireEvent.click(assigneeChip('Assignee: Sam Lee'));
    fireEvent.click(screen.getByRole('button', { name: /Assign to me/ }));

    await waitFor(() =>
      expect(setJiraTicketAssignee).toHaveBeenCalledWith('10421', ME),
    );
  });

  it('surfaces a rejected write and updates nothing', async () => {
    jest
      .mocked(setJiraTicketAssignee)
      .mockRejectedValue(new Error('User cannot be assigned issues.'));
    renderDrawer();

    fireEvent.click(assigneeChip());
    await runDebounce();
    fireEvent.click(screen.getByRole('button', { name: 'Sam Lee' }));

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        'User cannot be assigned issues.',
      ),
    );
    expect(onTicketUpdated).not.toHaveBeenCalled();
  });
});
