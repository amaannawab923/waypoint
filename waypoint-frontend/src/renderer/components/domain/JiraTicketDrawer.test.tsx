import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  downloadJiraAttachment,
  listJiraComments,
  searchJiraAssignableUsers,
  setJiraTicketAssignee,
  uploadJiraAttachment,
} from '@/data/jiraApi';
import { useJiraConnection } from '@/lib/jiraStore';
import { showErrorToast } from '@/lib/toast';
import type {
  JiraAttachment,
  JiraConnectionStatus,
  JiraTicket,
} from '@/types/jira';
import { JiraTicketDrawer } from './JiraTicketDrawer';

// The drawer owns the assignee write and the picker owns its own debounced
// search, so this is the level the reassign flow is actually testable at —
// mocking the data module is what lets the real drawer, the real chip and the
// real portaled panel render together, exactly as JiraTicketRow.test.tsx does
// for the priority flow.
jest.mock('@/data/jiraApi', () => ({
  downloadJiraAttachment: jest.fn(),
  listJiraComments: jest.fn(),
  postJiraComment: jest.fn(),
  searchJiraAssignableUsers: jest.fn(),
  setJiraTicketAssignee: jest.fn(),
  uploadJiraAttachment: jest.fn(),
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

function attachment(overrides: Partial<JiraAttachment> = {}): JiraAttachment {
  return {
    id: '10050',
    fileName: 'replay-log.txt',
    sizeLabel: '214 KB',
    sizeBytes: 219136,
    mimeType: 'text/plain',
    uploaderName: 'Sam Lee',
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
  jest.mocked(downloadJiraAttachment).mockResolvedValue({ canceled: false });
  jest
    .mocked(uploadJiraAttachment)
    .mockResolvedValue({ canceled: true, ticket: null });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('attachments', () => {
  it('offers a real Download button per attachment, not a static label', () => {
    renderDrawer({ attachments: [attachment()] });

    expect(screen.queryByText('download in Jira')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Download' }),
    ).toBeInTheDocument();
  });

  // Jira lets two files on one issue share a name. Keying the rows on the
  // filename collapsed them into one React key; the id is what makes them two
  // distinct rows.
  it('renders two attachments sharing a filename as two distinct rows', () => {
    // React reports a duplicate key as a console error rather than a throw, so
    // the only way to assert its absence is to watch the console.
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    renderDrawer({
      attachments: [
        attachment({ id: '10050' }),
        attachment({ id: '10051', uploaderName: 'Priya Raman' }),
      ],
    });

    expect(screen.getAllByText('replay-log.txt')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(2);
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    consoleError.mockRestore();
  });

  it('downloads by the attachment id, carrying the name only as a suggestion', async () => {
    renderDrawer({ attachments: [attachment()] });

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() =>
      expect(downloadJiraAttachment).toHaveBeenCalledWith(
        '10421',
        '10050',
        'replay-log.txt',
      ),
    );
  });

  // The download URL is built in main from the attachment id (see
  // jiraClient.ts), so a row without one cannot be fetched — and a button
  // whose only possible outcome is failing is worse than no button.
  it('offers no Download on an attachment Jira returned without an id', () => {
    renderDrawer({ attachments: [attachment({ id: null })] });

    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(screen.getByText('download in Jira')).toBeInTheDocument();
  });

  // A cancel is not an error — main answers `{ canceled: true }` rather than
  // a failure, precisely so this fires no toast.
  it('says nothing when the user cancels the save dialog', async () => {
    jest.mocked(downloadJiraAttachment).mockResolvedValue({ canceled: true });
    renderDrawer({ attachments: [attachment()] });

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(downloadJiraAttachment).toHaveBeenCalled());
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it('surfaces a refused download', async () => {
    jest
      .mocked(downloadJiraAttachment)
      .mockRejectedValue(new Error('Attachment does not exist.'));
    renderDrawer({ attachments: [attachment()] });

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith('Attachment does not exist.'),
    );
  });
});

describe('attaching a file', () => {
  // The header is where "Attach a file" lives, so hiding it on an empty list
  // would hide the upload entry point on the single most common case there is
  // — a ticket with nothing attached yet.
  it('shows the Attachments header and the button on a ticket with none', () => {
    renderDrawer({ attachments: [] });

    expect(screen.getByText('Attachments')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeEnabled();
    expect(screen.getByText(/Nothing attached yet/i)).toBeInTheDocument();
  });

  // No filename, no path, no File — main opens the picker. This assertion is
  // the renderer-side half of "no path crosses IPC".
  it('sends only the issue id, and nothing that names a file', async () => {
    renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'Attach a file' }));

    await waitFor(() => expect(uploadJiraAttachment).toHaveBeenCalled());
    expect(uploadJiraAttachment).toHaveBeenCalledWith('10421');
    expect(jest.mocked(uploadJiraAttachment).mock.calls[0]).toHaveLength(1);
  });

  it('hands the re-read ticket up so the row behind the drawer updates too', async () => {
    const updated = ticket({ attachments: [attachment()] });
    jest
      .mocked(uploadJiraAttachment)
      .mockResolvedValue({ canceled: false, ticket: updated });
    renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'Attach a file' }));

    await waitFor(() => expect(onTicketUpdated).toHaveBeenCalledWith(updated));
  });

  // A closed file picker is not an error and is not an update.
  it('updates nothing and says nothing when the picker is cancelled', async () => {
    renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'Attach a file' }));

    await waitFor(() => expect(uploadJiraAttachment).toHaveBeenCalled());
    expect(onTicketUpdated).not.toHaveBeenCalled();
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it('surfaces a refused upload and updates nothing', async () => {
    jest
      .mocked(uploadJiraAttachment)
      .mockRejectedValue(
        new Error('The file exceeds its maximum permitted size.'),
      );
    renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'Attach a file' }));

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        'The file exceeds its maximum permitted size.',
      ),
    );
    expect(onTicketUpdated).not.toHaveBeenCalled();
  });

  // Same posture as the assignee chip: a ticket whose writes are paused says
  // why rather than silently doing nothing.
  it('is disabled, and says why, while the ticket is in conflict', () => {
    renderDrawer({ hasConflict: true });

    const button = screen.getByRole('button', { name: 'Attach a file' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Write paused until reloaded');
  });
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
