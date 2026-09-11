import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  deleteJiraComment,
  downloadJiraAttachment,
  getJiraComment,
  getJiraCommentPermissions,
  listJiraComments,
  postJiraComment,
  prepareJiraCommentEdit,
  searchJiraAssignableUsers,
  setJiraTicketAssignee,
  updateJiraComment,
  uploadJiraAttachment,
} from '@/data/jiraApi';
import { useJiraConnection } from '@/lib/jiraStore';
import { showErrorToast } from '@/lib/toast';
import { useCopilotOpenState } from '@/lib/copilotOpenStore';
import type {
  JiraAttachment,
  JiraComment,
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
  // The real implementation, not a jest.fn() stub: it's a pure string
  // formula with no IPC behind it (unlike every other export here), and the
  // "exact permalink" test below is only meaningful if this is the same
  // formula jiraApi.test.ts pins directly.
  buildJiraCommentPermalink: (
    site: string,
    issueKey: string,
    commentId: string,
  ) => `https://${site}/browse/${issueKey}?focusedCommentId=${commentId}`,
  deleteJiraComment: jest.fn(),
  downloadJiraAttachment: jest.fn(),
  // The single-comment read every freshness guard now decides on, kept
  // deliberately separate from `listJiraComments` — and that separation is
  // the whole point of the guard tests below. The list is capped at the
  // newest 100 comments, so a comment missing from it may only have scrolled
  // off a busy thread; this read names one comment and resolves to null only
  // when Jira actually answered 404 for that comment.
  getJiraComment: jest.fn(),
  getJiraCommentPermissions: jest.fn(),
  listJiraComments: jest.fn(),
  postJiraComment: jest.fn(),
  // Real logic (the round-trip losslessness proof) is not re-run here — this
  // suite is about who gets Edit rendered and what happens when they click
  // it, exactly the same "trust the data layer's own contract, test this
  // component against it" split `getJiraCommentPermissions` already draws.
  // jiraApi.test.ts is where the actual proof is pinned.
  prepareJiraCommentEdit: jest.fn(),
  searchJiraAssignableUsers: jest.fn(),
  setJiraTicketAssignee: jest.fn(),
  updateJiraComment: jest.fn(),
  uploadJiraAttachment: jest.fn(),
}));
jest.mock('@/lib/jiraStore', () => ({ useJiraConnection: jest.fn() }));
jest.mock('@/lib/toast', () => ({ showErrorToast: jest.fn() }));
// Defaults to closed so every existing test in this file (none of which
// cares about Copilot) keeps rendering the drawer flush against the right
// edge — only the "docks beside Copilot" describe block below overrides this.
jest.mock('@/lib/copilotOpenStore', () => ({
  useCopilotOpenState: jest.fn(() => false),
}));

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

function comment(overrides: Partial<JiraComment> = {}): JiraComment {
  return {
    id: 'c1',
    ticketId: '10421',
    authorName: 'Max Chen',
    authorAccountId: 'acct-max',
    updatedAt: null,
    updateAuthorName: null,
    body: 'hi @Sam Lee',
    createdAt: '2026-01-01T00:00:00.000Z',
    parentId: null,
    postedByWaypoint: false,
    disclosureText: null,
    // Null by default: this suite mocks prepareJiraCommentEdit's own
    // decision directly rather than exercising the real ADF round-trip (see
    // that mock's own comment above), so no fixture here needs a real
    // document tree behind it.
    bodyAdf: null,
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
  countsTruncated: false,
};

const ASSIGNABLE = [
  { accountId: 'acct-sam', displayName: 'Sam Lee', avatarUrl: null },
  { accountId: 'acct-priya', displayName: 'Priya Raman', avatarUrl: null },
];

const onTicketUpdated = jest.fn();

/** Wrapped in a router because the drawer's expand button is a real
 * navigation to /my-jira/:key — the same jump TicketDrawer makes to a
 * native ticket's own page — so `useNavigate` needs a Router above it. */
function renderDrawer(overrides: Partial<JiraTicket> = {}) {
  return render(
    <MemoryRouter>
      <JiraTicketDrawer
        ticket={ticket(overrides)}
        onTicketUpdated={onTicketUpdated}
        onClose={jest.fn()}
      />
    </MemoryRouter>,
  );
}

/** By accessible name, deliberately — the chip's visible text is also its
 * name, but `title` is where the disabled reason goes, so the aria-label is
 * what keeps the control named in the one state a screen-reader user most
 * needs it (the same trap JiraPriorityChip documents). */
function assigneeChip(name = 'Assignee: Max Chen'): HTMLElement {
  return screen.getByRole('button', { name });
}

function commentBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Comment…/i) as HTMLTextAreaElement;
}

/**
 * ROAD-41: JiraTicketDetail now mounts a second JiraCommentComposer inline,
 * in place of whichever comment is being edited, alongside the one always
 * mounted above the thread — so while an edit is open, `commentBox()`'s own
 * placeholder match is no longer unique and throws. This picks out the
 * inline one specifically by the one thing only it ever shows: a Save
 * button, scoped up to that composer's own root (`[data-shortcut-guard]`,
 * the same attribute JiraCommentComposer's global-shortcut guard already
 * relies on, not a test-only marker) so the query never has to guess which
 * of the two rendered "Comment…" boxes goes with which Save button.
 */
function inlineEditBox(): HTMLTextAreaElement {
  const saveButton = screen.getByRole('button', { name: 'Save' });
  const composerRoot = saveButton.closest(
    '[data-shortcut-guard]',
  ) as HTMLElement;
  return within(composerRoot).getByPlaceholderText(
    /Comment…/i,
  ) as HTMLTextAreaElement;
}

/** The picker debounces its search by ~250ms; nothing arrives until the timers
 * this advances have run. */
async function runDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
}

/** Flushes a pending `requestAnimationFrame` callback under this file's fake
 * timers — needed after an action (Cancel, or a saved edit) that schedules a
 * focus-restore via rAF, the same "focus after a state-driven re-render"
 * pattern JiraCommentComposer.tsx already uses throughout (selecting a
 * mention, loading a reply/edit prefill, …). Fake timers replace rAF with a
 * timer-backed stand-in, so nothing scheduled through it runs until timers
 * are advanced, same as a real setTimeout under this same mock. */
async function flushFrame() {
  await act(async () => {
    jest.advanceTimersByTime(50);
  });
}

// jsdom doesn't implement scrollIntoView — JiraCommentComposer's mention
// popover calls it on the newly-highlighted option so keyboard/mouse
// highlight movement stays visible, otherwise harmless in a real browser
// but throwing as an unhandled exception under jsdom. Same fix as
// TicketList.test.tsx's own j/k focus movement.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.mocked(useCopilotOpenState).mockReturnValue(false);
  jest.mocked(listJiraComments).mockResolvedValue({ comments: [], total: 0 });
  // Fails closed by default, same as canDeleteComment's own handling of an
  // unresolved read: no test outside the "deleting a comment" block below is
  // about Delete, so none of them should see it render.
  jest.mocked(getJiraCommentPermissions).mockResolvedValue({
    deleteAll: false,
    deleteOwn: false,
    editAll: false,
    editOwn: false,
  });
  // Fails closed the same way: no test outside "editing a comment" below
  // grants edit permission, so none of them should ever call this, but a
  // stray call defaulting to "not editable" is still the safe answer rather
  // than an unmocked-function crash.
  jest.mocked(prepareJiraCommentEdit).mockReturnValue(null);
  // Defaults to "that comment is still there, and hasn't drifted": the id
  // asked for comes back, with `updatedAt: null`, which every freshness guard
  // reads as "unknown, therefore no evidence of drift" (see the guards' own
  // comments on why a refusal on missing data is the false positive that gets
  // a safety feature learned-ignored). Deliberately NOT left unmocked: an
  // unmocked call resolves undefined, which a guard would read as "Jira
  // answered 404" and refuse on — turning every unrelated test in this file
  // into a confusing refusal instead of an obvious crash. Tests that are
  // actually about drift or a 404 override this per case.
  jest
    .mocked(getJiraComment)
    .mockImplementation(async (_ticketId, commentId) =>
      comment({ id: commentId }),
    );
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

  // Everything else in the properties panel — reporter, epic, points,
  // sprint — is read-only here, and must not have quietly become a control
  // alongside the three (state, assignee, priority) that are writable.
  // Asserted on the value, not the "Reporter" label, since the label is now
  // its own element in a PropertyRow rather than one "Reporter · Sam Lee"
  // chip.
  it('leaves the reporter a plain label, not a control', () => {
    renderDrawer();

    expect(screen.getByText('Sam Lee').tagName).not.toBe('BUTTON');
    expect(screen.queryByRole('button', { name: /Sam Lee/ })).toBeNull();
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

// The comment composer's @-mention picker. Same searchJiraAssignableUsers
// endpoint and the same debounce as the assignee picker above — this app has
// one "who's on this issue" question, not a separate one for mentioning
// versus assigning — so ASSIGNABLE and runDebounce are reused rather than
// duplicated.
describe('mentions in the comment composer', () => {
  it('shows a popover of teammates when typing @', async () => {
    renderDrawer();

    fireEvent.change(commentBox(), { target: { value: '@' } });
    await runDebounce();

    expect(screen.getByRole('option', { name: 'Sam Lee' })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Priya Raman' }),
    ).toBeInTheDocument();
  });

  it("searches this issue's real assignable users as the query narrows", async () => {
    renderDrawer();

    fireEvent.change(commentBox(), { target: { value: '@sa' } });
    await runDebounce();

    expect(searchJiraAssignableUsers).toHaveBeenCalledWith('ENG-421', 'sa');
  });

  // "user@example.com" typed into a comment must not pop a picker open on
  // every email address — an "@" only starts a mention run when it opens a
  // word.
  it('does not treat a mid-word @ as a mention trigger', async () => {
    renderDrawer();

    fireEvent.change(commentBox(), {
      target: { value: 'ping sam@example' },
    });
    await runDebounce();

    expect(searchJiraAssignableUsers).not.toHaveBeenCalled();
  });

  it('inserts a picked suggestion as text and posts it as a real mention node', async () => {
    jest.mocked(postJiraComment).mockResolvedValue(comment());
    renderDrawer();
    const box = commentBox();

    fireEvent.change(box, { target: { value: 'hi @sa' } });
    await runDebounce();
    // The suggestion row is picked on mousedown, not click — a click on a
    // button the textarea already lost focus to would arrive after the
    // textarea has blurred, by which point the trigger it needs is gone.
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Sam Lee' }));

    expect(box.value).toBe('hi @Sam Lee ');

    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() => expect(postJiraComment).toHaveBeenCalled());
    expect(postJiraComment).toHaveBeenCalledWith('10421', 'hi @Sam Lee ', [
      { start: 3, end: 11, accountId: 'acct-sam', displayName: 'Sam Lee' },
    ]);
  });

  it('closes the popover on Escape without closing the drawer', async () => {
    renderDrawer();
    const box = commentBox();

    fireEvent.change(box, { target: { value: '@sa' } });
    await runDebounce();
    expect(screen.getByRole('option', { name: 'Sam Lee' })).toBeInTheDocument();

    fireEvent.keyDown(box, { key: 'Escape' });

    expect(
      screen.queryByRole('option', { name: 'Sam Lee' }),
    ).not.toBeInTheDocument();
    // The drawer itself is still open — Escape only closed the popover.
    expect(box).toBeInTheDocument();
  });

  it('posts plain typed text with no mentions, unchanged from before', async () => {
    jest
      .mocked(postJiraComment)
      .mockResolvedValue(comment({ body: 'Taking it.' }));
    renderDrawer();

    fireEvent.change(commentBox(), { target: { value: 'Taking it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() =>
      expect(postJiraComment).toHaveBeenCalledWith('10421', 'Taking it.', []),
    );
  });
});

// Jira's own "Reply" on a comment does two things at once, verified live
// against the founder's own Jira (ENG-84): it prefills an @author mention AND
// sets a real parentId that nests the new comment under the one it answers —
// Jira genuinely threads comments, which an earlier version of this suite
// believed it did not. Waypoint's own Reply does both now too. These tests
// cover the mention half: the prefill reuses the composer's real mention
// machinery (same spans, same buildCommentAdf path selectMention already
// exercises above), not a second, parallel way of inserting text. The
// parentId half — what postJiraComment is called with, and how nesting is
// decided from Jira's response rather than the request — is covered in
// jiraApi.test.ts and JiraTicketDetail.test.tsx (groupCommentsIntoThreads).
describe('replying to a comment', () => {
  it('prefills a real mention of the comment author at the front of the draft', async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c1',
          authorName: 'Sam Lee',
          authorAccountId: 'acct-sam',
          updatedAt: null,
          updateAuthorName: null,
          body: 'Can you take a look?',
        }),
      ],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('Can you take a look?');

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));

    expect(commentBox().value).toBe('@Sam Lee ');
  });

  it('posts the prefilled mention as a real ADF mention node, not literal text', async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c1',
          authorName: 'Sam Lee',
          authorAccountId: 'acct-sam',
          updatedAt: null,
          updateAuthorName: null,
          body: 'Can you take a look?',
        }),
      ],
      total: 1,
    });
    jest.mocked(postJiraComment).mockResolvedValue(comment({ id: 'c2' }));
    renderDrawer();
    await screen.findByText('Can you take a look?');

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(commentBox(), {
      target: { value: '@Sam Lee on it now' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() => expect(postJiraComment).toHaveBeenCalled());
    expect(postJiraComment).toHaveBeenCalledWith(
      '10421',
      '@Sam Lee on it now',
      [{ start: 0, end: 8, accountId: 'acct-sam', displayName: 'Sam Lee' }],
      // The replied-to comment's own id, threaded through as the write's
      // parentId — see JiraCommentComposer.tsx's replyParentId.
      'c1',
    );
  });

  it("sends the replied-to comment's id as parentId, and nothing on an ordinary comment", async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c1',
          authorName: 'Sam Lee',
          authorAccountId: 'acct-sam',
          updatedAt: null,
          updateAuthorName: null,
          body: 'Can you take a look?',
        }),
      ],
      total: 1,
    });
    jest.mocked(postJiraComment).mockResolvedValue(comment({ id: 'c2' }));
    renderDrawer();
    await screen.findByText('Can you take a look?');

    // An ordinary comment, no Reply click first: the 3-arg call every other
    // posting test in this file already exercises must stay exactly that —
    // no fourth `undefined`/`null` argument tagging along regardless.
    fireEvent.change(commentBox(), { target: { value: 'unrelated note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() =>
      expect(postJiraComment).toHaveBeenCalledWith(
        '10421',
        'unrelated note',
        [],
      ),
    );
  });

  // ROAD-41: replyParentId used to survive the prefilled "@Name " being
  // edited or deleted out of the draft entirely, on the strength of an
  // unverified claim about Jira's own composer (see replyParentId's own
  // comment in JiraCommentComposer.tsx). A draft that no longer mentions
  // the person being replied to now un-threads instead, matching what the
  // draft on screen actually says.
  it('un-threads the reply once the prefilled mention is fully removed from the draft', async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c1',
          authorName: 'Sam Lee',
          authorAccountId: 'acct-sam',
          updatedAt: null,
          updateAuthorName: null,
          body: 'Can you take a look?',
        }),
      ],
      total: 1,
    });
    jest.mocked(postJiraComment).mockResolvedValue(comment({ id: 'c2' }));
    renderDrawer();
    await screen.findByText('Can you take a look?');

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(commentBox().value).toBe('@Sam Lee ');

    // Replaces the whole draft, including the prefilled mention — nothing
    // left in the box names Sam Lee any more.
    fireEvent.change(commentBox(), { target: { value: 'unrelated note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    // The 3-arg call, with no parentId — same shape the "no Reply click"
    // test above pins, but reached here via a Reply that was actively
    // un-threaded rather than one that never started.
    await waitFor(() =>
      expect(postJiraComment).toHaveBeenCalledWith(
        '10421',
        'unrelated note',
        [],
      ),
    );
  });

  it('prefills again on a second Reply click, including a second Reply to the same author', async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c1',
          authorName: 'Sam Lee',
          authorAccountId: 'acct-sam',
          updatedAt: null,
          updateAuthorName: null,
          body: 'first',
        }),
      ],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('first');

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(commentBox().value).toBe('@Sam Lee ');

    // Clear the draft, then reply again — a stale "already prefilled" guard
    // keyed on the accountId/displayName values (rather than a fresh object
    // per click) would make this second click a no-op.
    fireEvent.change(commentBox(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));

    expect(commentBox().value).toBe('@Sam Lee ');
  });

  it("does not offer Reply when Jira withheld the author's account id", async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c1',
          authorName: 'Deleted User',
          authorAccountId: null,
          updatedAt: null,
          updateAuthorName: null,
          body: 'ghost comment',
        }),
      ],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('ghost comment');

    expect(
      screen.queryByRole('button', { name: 'Reply' }),
    ).not.toBeInTheDocument();
  });
});

// Integration coverage for groupCommentsIntoThreads (JiraTicketDetail.tsx),
// which has its own thorough unit tests — this just confirms the real
// component renders every comment, nested or not, rather than the grouping
// logic being right in isolation but never actually reaching the DOM.
describe('nested comment rendering', () => {
  it('renders a reply alongside its parent, not just the parent', async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({ id: 'c1', body: 'Hello', authorName: 'Sam Lee' }),
        comment({
          id: 'c2',
          body: 'Reply should be like this',
          authorName: 'Priya Raman',
          parentId: 'c1',
        }),
      ],
      total: 2,
    });
    renderDrawer();

    expect(await screen.findByText('Hello')).toBeInTheDocument();
    expect(
      await screen.findByText('Reply should be like this'),
    ).toBeInTheDocument();
  });

  // The reply's parent fell outside the 100-comment page this read from —
  // it must still render rather than vanish.
  it('still renders an orphaned reply whose parent is not on this page', async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c2',
          body: 'Reply to something not loaded',
          parentId: 'c-not-loaded',
        }),
      ],
      total: 1,
    });
    renderDrawer();

    expect(
      await screen.findByText('Reply to something not loaded'),
    ).toBeInTheDocument();
  });

  // Malformed data the real component must survive, not just the pure
  // function in isolation: a self-referencing parentId must not hang the
  // render or blank the thread.
  it('renders, without hanging, a comment whose parentId points at itself', async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', body: 'Odd data', parentId: 'c1' })],
      total: 1,
    });
    renderDrawer();

    expect(await screen.findByText('Odd data')).toBeInTheDocument();
  });
});

// ROAD-27 / docs/qa/manual-test-cases.md's JIRA-155: a comment body renders
// as plain text (never through JiraRichText), so it needs its own
// overflow-wrap class or a pasted stack trace / base64 blob / long URL with
// no spaces forces the drawer to scroll sideways instead of wrapping. jsdom
// does not lay out text, so this cannot prove the long token actually wraps
// at any real width — only that the class making wrapping possible is on
// the element holding the body. This is a class assertion, not a layout
// measurement.
describe('comment body wrapping (ROAD-27)', () => {
  it('renders the comment body with the overflow-wrap class', async () => {
    const longUrl = `https://example.com/${'a'.repeat(300)}`;
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', body: longUrl })],
      total: 1,
    });
    renderDrawer();

    const body = await screen.findByText(longUrl);
    expect(body).toHaveClass('break-words');
  });
});

describe("copying a comment's permalink", () => {
  beforeEach(() => {
    // jsdom has no Clipboard API by default.
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
  });

  it('copies the exact permalink Jira itself uses for that comment', async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c9', body: 'noted' })],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('noted');

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://waypoint123.atlassian.net/browse/ENG-421?focusedCommentId=c9',
      ),
    );
  });

  it('confirms success by flipping the button label to "Copied" — this app has no success-toast channel', async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c9', body: 'noted' })],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('noted');

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(
      await screen.findByRole('button', { name: 'Copied' }),
    ).toBeInTheDocument();
  });
});

// Delete's own visibility is a client-side decision (canDeleteComment in
// JiraTicketDetail.tsx): the project-level own/all answer Jira reports for
// the connected account, plus whether that account actually wrote the
// comment in question. deleteAll and deleteOwn can both be true on the
// connected/test account at once — the common shape for whoever is testing
// this against their own Jira, and deliberately NOT the shape most
// non-admins see — so the deleteOwn-only case against someone ELSE's
// comment gets its own dedicated coverage below rather than being inferred
// from the deleteAll case, since this machine's own account cannot reveal
// that gap by accident.
describe('deleting a comment', () => {
  beforeEach(() => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('offers no Delete when the connected account holds neither delete permission', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: false,
      editOwn: false,
    });
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', authorAccountId: ME, body: 'mine' })],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('mine');

    expect(
      screen.queryByRole('button', { name: 'Delete' }),
    ).not.toBeInTheDocument();
  });

  it('offers Delete on my own comment when only deleteOwn is granted', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: true,
      editAll: false,
      editOwn: false,
    });
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', authorAccountId: ME, body: 'mine' })],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('mine');

    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it("offers no Delete on someone else's comment when only deleteOwn is granted", async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: true,
      editAll: false,
      editOwn: false,
    });
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c1',
          authorAccountId: 'acct-sam',
          updatedAt: null,
          updateAuthorName: null,
          authorName: 'Sam Lee',
          body: 'not mine',
        }),
      ],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('not mine');

    expect(
      screen.queryByRole('button', { name: 'Delete' }),
    ).not.toBeInTheDocument();
  });

  it('offers Delete on any comment when deleteAll is granted', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: true,
      deleteOwn: false,
      editAll: false,
      editOwn: false,
    });
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c1',
          authorAccountId: 'acct-sam',
          updatedAt: null,
          updateAuthorName: null,
          authorName: 'Sam Lee',
          body: 'not mine either',
        }),
      ],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('not mine either');

    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('asks before deleting, and does nothing at all when the confirmation is cancelled', async () => {
    jest.mocked(window.confirm).mockReturnValue(false);
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: true,
      deleteOwn: false,
      editAll: false,
      editOwn: false,
    });
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', body: 'noted' })],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('noted');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(deleteJiraComment).not.toHaveBeenCalled();
    expect(screen.getByText('noted')).toBeInTheDocument();
  });

  // ROAD-41: deleting a comment used to trust whatever local state already
  // said about it, with no check that it was still current — the most
  // destructive comment write on the branch was also the least protected
  // one. handleDeleteComment now re-reads the thread live, immediately
  // before the actual delete call, and refuses (see the test below this
  // one) rather than remove content nobody looking at this screen has
  // actually seen.
  it('re-reads the thread immediately before deleting, then removes the row from that live read', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: true,
      deleteOwn: false,
      editAll: false,
      editOwn: false,
    });
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', body: 'noted' })],
      total: 1,
    });
    jest.mocked(deleteJiraComment).mockResolvedValue(undefined);
    renderDrawer();
    await screen.findByText('noted');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(deleteJiraComment).toHaveBeenCalledWith('10421', 'c1'),
    );
    await waitFor(() => expect(screen.queryByText('noted')).toBeNull());
    // Once for the initial load, once for the live freshness re-check
    // handleDeleteComment now does right before the delete call (see its
    // own comment) — and no THIRD read after a successful delete: the row
    // is dropped, locally, from the array that re-check already returned.
    expect(listJiraComments).toHaveBeenCalledTimes(2);
  });

  it('refuses to delete a comment that changed in Jira since it was last read, and shows the latest version instead', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: true,
      deleteOwn: false,
      editAll: false,
      editOwn: false,
    });
    jest
      .mocked(listJiraComments)
      .mockResolvedValueOnce({
        comments: [
          comment({
            id: 'c1',
            body: 'noted',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }),
        ],
        total: 1,
      })
      .mockResolvedValueOnce({
        comments: [
          comment({
            id: 'c1',
            body: 'noted, but edited by someone else first',
            updatedAt: '2026-01-02T00:00:00.000Z',
          }),
        ],
        total: 1,
      });
    // The verdict comes from the named read; the thread read above is only
    // what makes "the thread above now shows the latest version" true.
    jest.mocked(getJiraComment).mockResolvedValue(
      comment({
        id: 'c1',
        body: 'noted, but edited by someone else first',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    renderDrawer();
    await screen.findByText('noted');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(
        screen.getByText('noted, but edited by someone else first'),
      ).toBeInTheDocument(),
    );
    expect(deleteJiraComment).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith(
      expect.stringContaining('changed in Jira'),
    );
  });

  // The regression the named read exists to prevent, on the destructive
  // path. `listJiraComments` returns only the newest 100 comments, so a
  // comment can drop off it purely because other people kept commenting.
  // The old guard read that absence as "already gone" and returned in
  // silence — leaving someone who had just confirmed an irreversible delete
  // with no idea whether it happened, and the comment still in Jira.
  it('deletes a comment that has scrolled off the capped thread page', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: true,
      deleteOwn: false,
      editAll: false,
      editOwn: false,
    });
    jest
      .mocked(listJiraComments)
      .mockResolvedValueOnce({
        comments: [comment({ id: 'c1', body: 'noted' })],
        total: 1,
      })
      // The re-read on Delete: a hundred newer comments have arrived and c1
      // is no longer on the page, though it is very much still in Jira.
      .mockResolvedValue({
        comments: [comment({ id: 'c-newer', body: 'a newer comment' })],
        total: 101,
      });
    jest
      .mocked(getJiraComment)
      .mockResolvedValue(comment({ id: 'c1', body: 'noted' }));
    renderDrawer();
    await screen.findByText('noted');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(deleteJiraComment).toHaveBeenCalledWith('10421', 'c1'),
    );
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it('tells the user nothing was deleted when Jira will not show the comment, rather than returning in silence', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: true,
      deleteOwn: false,
      editAll: false,
      editOwn: false,
    });
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', body: 'noted' })],
      total: 1,
    });
    jest.mocked(getJiraComment).mockResolvedValue(null);
    renderDrawer();
    await screen.findByText('noted');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(showErrorToast).toHaveBeenCalled());
    expect(deleteJiraComment).not.toHaveBeenCalled();
    const [message] = jest.mocked(showErrorToast).mock.calls[0] as [string];
    // Says nothing was deleted by this click — the one thing the person who
    // just confirmed an irreversible action actually needs to know.
    expect(message).toContain('Nothing was deleted just now');
    // And does not assert a deletion it never observed: a 404 is equally
    // what a lost browse permission looks like.
    expect(message).not.toMatch(/was deleted in Jira/);
  });

  // A failed request is not evidence a comment is gone. If it were folded
  // into the same 'unavailable' branch, an offline laptop would tell the
  // user their comment no longer exists.
  it('surfaces a failed freshness read as that failure, not as a missing comment', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: true,
      deleteOwn: false,
      editAll: false,
      editOwn: false,
    });
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', body: 'noted' })],
      total: 1,
    });
    jest
      .mocked(getJiraComment)
      .mockRejectedValue(new Error('Could not reach Jira.'));
    renderDrawer();
    await screen.findByText('noted');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith('Could not reach Jira.'),
    );
    expect(deleteJiraComment).not.toHaveBeenCalled();
    // The comment is still on screen: nothing about a failed read justifies
    // removing the row.
    expect(screen.getByText('noted')).toBeInTheDocument();
  });

  it('surfaces a 403 honestly rather than failing silently, and leaves the row in place', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: true,
      deleteOwn: false,
      editAll: false,
      editOwn: false,
    });
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', body: 'noted' })],
      total: 1,
    });
    jest
      .mocked(deleteJiraComment)
      .mockRejectedValue(
        new Error('You do not have permission to delete this comment.'),
      );
    renderDrawer();
    await screen.findByText('noted');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        'You do not have permission to delete this comment.',
      ),
    );
    // The failed delete did not remove the row — the real Jira comment is
    // still there, and the screen must not claim otherwise.
    expect(screen.getByText('noted')).toBeInTheDocument();
  });
});

// Edit's own visibility gate mirrors Delete's exactly (canEditComment in
// JiraTicketDetail.tsx) — same reason the editOwn-only case against someone
// ELSE's comment gets its own dedicated coverage below rather than being
// inferred from editAll: editAll and editOwn can both be true on the
// connected/test account at once, which is the shape this machine's own
// account cannot reveal a bug in by accident. Separate from permission
// entirely is whether prepareJiraCommentEdit says THIS comment's own content
// can be edited without changing it — that function is mocked in this file
// (see its own comment at the top), so these tests are only about what
// JiraTicketDetail does with a true/false/null answer, never about the real
// round-trip proof.
describe('editing a comment', () => {
  const EDIT_PREVIEW = { text: 'original text', mentions: [] };

  it('offers no Edit when the connected account holds neither edit permission', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: false,
      editOwn: false,
    });
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', authorAccountId: ME, body: 'mine' })],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('mine');

    expect(
      screen.queryByRole('button', { name: 'Edit' }),
    ).not.toBeInTheDocument();
    expect(prepareJiraCommentEdit).not.toHaveBeenCalled();
  });

  it('offers Edit on my own comment when only editOwn is granted', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: false,
      editOwn: true,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(EDIT_PREVIEW);
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', authorAccountId: ME, body: 'mine' })],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('mine');

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it("offers no Edit on someone else's comment when only editOwn is granted", async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: false,
      editOwn: true,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(EDIT_PREVIEW);
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c1',
          authorAccountId: 'acct-sam',
          updatedAt: null,
          updateAuthorName: null,
          authorName: 'Sam Lee',
          body: 'not mine',
        }),
      ],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('not mine');

    expect(
      screen.queryByRole('button', { name: 'Edit' }),
    ).not.toBeInTheDocument();
    // The permission gate must short-circuit before the round-trip proof is
    // ever asked to run on a comment this account isn't even allowed to
    // touch.
    expect(prepareJiraCommentEdit).not.toHaveBeenCalled();
  });

  it('offers Edit on any comment when editAll is granted', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(EDIT_PREVIEW);
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c1',
          authorAccountId: 'acct-sam',
          updatedAt: null,
          updateAuthorName: null,
          authorName: 'Sam Lee',
          body: 'not mine either',
        }),
      ],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('not mine either');

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  // The heart of the safety property, at the UI layer: permission alone is
  // not enough. A comment this account may edit but that fails the
  // losslessness round trip gets an honest refusal, not a silently missing
  // Edit button and not a button that opens the composer anyway.
  it('refuses Edit and offers "Edit in Jira" instead when the comment fails the round trip', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(null);
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({ id: 'c1', body: 'has a table Waypoint cannot rebuild' }),
      ],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('has a table Waypoint cannot rebuild');

    expect(
      screen.queryByRole('button', { name: 'Edit' }),
    ).not.toBeInTheDocument();
    const editInJira = screen.getByRole('link', { name: 'Edit in Jira' });
    expect(editInJira).toHaveAttribute(
      'href',
      'https://waypoint123.atlassian.net/browse/ENG-421?focusedCommentId=c1',
    );
    expect(editInJira).toHaveAttribute('target', '_blank');
  });

  // ROAD-41: Edit used to load the comment's text into the one composer
  // shared with new-comment/reply, at the bottom of the page, while the
  // comment itself kept rendering unchanged up in the thread — editing in
  // one place, looking at the stale original somewhere else. It now opens a
  // second JiraCommentComposer instance in that comment's own spot,
  // replacing its body and action row directly (matching Jira's own inline
  // edit, verified live against ENG-84) — these tests cover that placement
  // and the thread staying put around it; `inlineEditBox()` is what picks
  // that second instance out from the one still sitting above the thread.
  it('loads the proven-safe prefill into the composer on click, in the comment’s own spot', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue({
      text: 'Can you take a look? Thanks @Sam Lee',
      mentions: [
        { start: 29, end: 37, accountId: 'acct-sam', displayName: 'Sam Lee' },
      ],
    });
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', body: 'Can you take a look?' })],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('Can you take a look?');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // Edit's own click handler now re-reads the thread live before opening
    // the editor (see JiraTicketDetail.tsx's Edit handler) — no longer the
    // synchronous, purely-local decision it used to be, so this waits for
    // that round trip to settle rather than asserting immediately.
    await waitFor(() =>
      expect(inlineEditBox().value).toBe(
        'Can you take a look? Thanks @Sam Lee',
      ),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    // The original, unedited body is gone from the thread — not still
    // rendered somewhere else while the editor also shows it, the exact
    // defect this replaces.
    expect(screen.queryByText('Can you take a look?')).not.toBeInTheDocument();
  });

  it('refuses to open the editor on a comment that changed since the copy on screen, and shows the latest version instead', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(EDIT_PREVIEW);
    jest
      .mocked(listJiraComments)
      .mockResolvedValueOnce({
        comments: [
          comment({
            id: 'c1',
            body: 'original text',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }),
        ],
        total: 1,
      })
      .mockResolvedValueOnce({
        comments: [
          comment({
            id: 'c1',
            body: 'someone else changed this',
            updatedAt: '2026-01-02T00:00:00.000Z',
          }),
        ],
        total: 1,
      });
    jest.mocked(getJiraComment).mockResolvedValue(
      comment({
        id: 'c1',
        body: 'someone else changed this',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    renderDrawer();
    await screen.findByText('original text');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    await waitFor(() =>
      expect(screen.getByText('someone else changed this')).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument();
    expect(showErrorToast).toHaveBeenCalledWith(
      expect.stringContaining('changed in Jira'),
    );
  });

  // Same regression as the delete path's, on the Edit button: a comment that
  // has scrolled off the newest-100 page is still perfectly editable, and
  // the old guard refused it with "this comment was removed in Jira".
  it('opens the editor on a comment that has scrolled off the capped thread page', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(EDIT_PREVIEW);
    jest
      .mocked(listJiraComments)
      .mockResolvedValueOnce({
        comments: [comment({ id: 'c1', body: 'original text' })],
        total: 1,
      })
      .mockResolvedValue({
        comments: [comment({ id: 'c-newer', body: 'a newer comment' })],
        total: 101,
      });
    jest
      .mocked(getJiraComment)
      .mockResolvedValue(comment({ id: 'c1', body: 'original text' }));
    renderDrawer();
    await screen.findByText('original text');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    await waitFor(() => expect(inlineEditBox().value).toBe('original text'));
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it('refuses to open the editor when Jira will not show the comment, without claiming it was deleted', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(EDIT_PREVIEW);
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', body: 'original text' })],
      total: 1,
    });
    jest.mocked(getJiraComment).mockResolvedValue(null);
    renderDrawer();
    await screen.findByText('original text');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    await waitFor(() => expect(showErrorToast).toHaveBeenCalled());
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument();
    const [message] = jest.mocked(showErrorToast).mock.calls[0] as [string];
    expect(message).toContain('no longer have permission');
    expect(message).not.toMatch(/was removed in Jira/);
  });

  it('keeps every other comment exactly where it was while one is being edited', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(EDIT_PREVIEW);
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({ id: 'c1', body: 'original text' }),
        comment({
          id: 'c2',
          authorAccountId: 'acct-sam',
          updatedAt: null,
          updateAuthorName: null,
          authorName: 'Sam Lee',
          body: 'an unrelated comment',
        }),
      ],
      total: 2,
    });
    renderDrawer();
    await screen.findByText('original text');
    await screen.findByText('an unrelated comment');

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    await waitFor(() => expect(inlineEditBox().value).toBe('original text'));

    // c1's body is swapped for its editor; c2 — not being edited — still
    // renders exactly as a plain comment, unaffected by its neighbor's edit.
    // "original text" now appears exactly once in the whole document — the
    // editor's own textarea, whose live value happens to read the same as
    // the prefill it loaded — and NOT a second time as c1's own static body
    // still sitting there behind it, which is the defect being fixed.
    const matches = screen.getAllByText('original text');
    expect(matches).toHaveLength(1);
    expect(matches[0].tagName).toBe('TEXTAREA');
    expect(screen.getByText('an unrelated comment')).toBeInTheDocument();
  });

  it('saves the edit through updateJiraComment and replaces the row with the response', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(EDIT_PREVIEW);
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', body: 'original text' })],
      total: 1,
    });
    jest
      .mocked(updateJiraComment)
      .mockResolvedValue(comment({ id: 'c1', body: 'edited text' }));
    renderDrawer();
    await screen.findByText('original text');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(inlineEditBox().value).toBe('original text'));
    fireEvent.change(inlineEditBox(), {
      target: { value: 'edited text' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateJiraComment).toHaveBeenCalledWith(
        '10421',
        'c1',
        'edited text',
        [],
      ),
    );
    // Waits for the OLD text to vanish, not for the new text to appear —
    // matching deleteJiraComment's own test above (`queryByText('noted')` to
    // become null), and deliberately not the other way around: the
    // composer's own textarea still literally contains "edited text" the
    // whole time (that's what was typed into it), so asserting on that
    // string appearing would pass immediately without ever proving the
    // async write actually completed and the read-only row updated.
    await waitFor(() => expect(screen.queryByText('original text')).toBeNull());
    // Replaced in place, not appended and not refetched — same "trust the
    // response, not the request" shape deleteJiraComment's own test above
    // pins for the read count.
    expect(screen.getByText('edited text')).toBeInTheDocument();
    // Two thread reads and two named reads, and the split between them is
    // the point. Thread reads: the initial mount, and the one Edit fires so
    // the thread on screen really is current when its message says so.
    // Named reads: Edit's own freshness check before the editor opens
    // (JiraTicketDetail.tsx) and Save's immediately before the overwrite
    // (JiraCommentComposer.tsx's handlePost) — every freshness *verdict*
    // comes from the read that names the comment, never from searching a
    // capped page for it. And no read of either kind after the save
    // succeeded: the row is replaced from Jira's write response rather than
    // fetched again.
    expect(listJiraComments).toHaveBeenCalledTimes(2);
    expect(getJiraComment).toHaveBeenCalledTimes(2);
    // The inline editor is gone — a save is one of the two ways out of edit
    // mode, same as Cancel — and it isn't a save that leaves the reader
    // clicking Edit into a phantom empty editor.
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument();
  });

  it('refuses to save an edit when the comment changed in Jira after the editor opened, and keeps the typed draft', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(EDIT_PREVIEW);
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c1',
          body: 'original text',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      total: 1,
    });
    jest
      .mocked(getJiraComment)
      // Edit's own open-time re-check — still current, so the editor opens.
      .mockResolvedValueOnce(
        comment({
          id: 'c1',
          body: 'original text',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      )
      // Save's own re-check — someone else edited it while the editor sat
      // open.
      .mockResolvedValueOnce(
        comment({
          id: 'c1',
          body: 'original text, edited by someone else',
          updatedAt: '2026-01-02T00:00:00.000Z',
          updateAuthorName: 'Priya Raman',
        }),
      );
    renderDrawer();
    await screen.findByText('original text');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(inlineEditBox().value).toBe('original text'));

    fireEvent.change(inlineEditBox(), {
      target: { value: 'my careful edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.getByText(/changed in Jira/)).toBeInTheDocument(),
    );
    expect(updateJiraComment).not.toHaveBeenCalled();
    // The user's own typed text is still right there in the box, unsaved
    // but not lost — the whole point of refusing rather than either
    // silently overwriting Priya's edit or clearing the draft outright.
    expect(inlineEditBox().value).toBe('my careful edit');
  });

  it('refuses to save an edit when Jira stops showing the comment while the editor is open, and keeps the typed draft', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(EDIT_PREVIEW);
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({
          id: 'c1',
          body: 'original text',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      total: 1,
    });
    jest
      .mocked(getJiraComment)
      // Edit's own open-time check — still there, unchanged, so the editor
      // opens.
      .mockResolvedValueOnce(
        comment({
          id: 'c1',
          body: 'original text',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      )
      // Save's own check — Jira now answers 404 for it.
      .mockResolvedValueOnce(null);
    renderDrawer();
    await screen.findByText('original text');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(inlineEditBox().value).toBe('original text'));

    fireEvent.change(inlineEditBox(), {
      target: { value: 'my careful edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(
        screen.getByText(/won.t show this comment any more/),
      ).toBeInTheDocument(),
    );
    expect(updateJiraComment).not.toHaveBeenCalled();
    expect(inlineEditBox().value).toBe('my careful edit');
    // A 404 is not proof anyone deleted anything — Jira answers it the same
    // way for a comment this account may no longer browse. The banner must
    // not state a deletion it never observed.
    expect(screen.queryByText(/was deleted in Jira/)).not.toBeInTheDocument();
  });

  // The regression this whole seam exists to prevent. `listJiraComments` is
  // capped at the newest 100 comments, so on a busy thread the comment being
  // edited can simply scroll off the page it returns — other people still
  // commenting, nobody deleting anything. The old guard searched that page
  // for the id and treated a miss as a deletion, which meant a perfectly
  // valid Save was refused with "this comment was deleted in Jira" on the
  // screen. Here the thread read comes back WITHOUT c1 while the named read
  // still finds it, and the save must go through.
  it('saves an edit to a comment that has scrolled off the capped thread page', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(EDIT_PREVIEW);
    jest
      .mocked(listJiraComments)
      // Mount: c1 is on the page, so it renders and can be clicked.
      .mockResolvedValueOnce({
        comments: [
          comment({
            id: 'c1',
            body: 'original text',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }),
        ],
        total: 1,
      })
      // Every later thread read: a hundred newer comments arrived, and c1 is
      // no longer among them. `total` stays honest about there being more.
      .mockResolvedValue({
        comments: [comment({ id: 'c-newer', body: 'a newer comment' })],
        total: 101,
      });
    jest.mocked(getJiraComment).mockResolvedValue(
      comment({
        id: 'c1',
        body: 'original text',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    jest
      .mocked(updateJiraComment)
      .mockResolvedValue(comment({ id: 'c1', body: 'my careful edit' }));
    renderDrawer();
    await screen.findByText('original text');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(inlineEditBox().value).toBe('original text'));

    fireEvent.change(inlineEditBox(), {
      target: { value: 'my careful edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateJiraComment).toHaveBeenCalled());
    expect(
      screen.queryByText(/won.t show this comment any more/),
    ).not.toBeInTheDocument();
  });

  it('discards the loaded edit and restores the comment on Cancel, without saving', async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue(EDIT_PREVIEW);
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', body: 'original text' })],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('original text');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(inlineEditBox().value).toBe('original text'));

    fireEvent.change(inlineEditBox(), { target: { value: 'a stray edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flushFrame();

    expect(updateJiraComment).not.toHaveBeenCalled();
    // Restored to the comment's real, unedited body — "a stray edit" was
    // never saved and isn't shown anywhere.
    expect(screen.getByText('original text')).toBeInTheDocument();
    expect(screen.queryByText('a stray edit')).not.toBeInTheDocument();
    // The inline editor itself is gone, not just visually blanked.
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel' }),
    ).not.toBeInTheDocument();
    // Focus lands back on this comment's own Edit button rather than
    // falling to <body> once the editor that held it unmounts.
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
  });
});

// ROAD-41: two real JiraCommentComposer instances can now be mounted on the
// same ticket at once — the one above the thread, and a second wherever a
// comment is being edited (see the "editing a comment" block above). Both
// used to derive their mention popover's DOM ids from ticketId alone, which
// two instances on the same ticket share; this is the integration-level
// proof (JiraCommentComposer.mention-a11y.test.tsx has the isolated one)
// that they no longer collide once both are genuinely open together.
describe('two composers open at once (the top composer and an inline edit)', () => {
  it("gives the top composer's and the inline editor's mention popovers distinct listbox ids", async () => {
    jest.mocked(getJiraCommentPermissions).mockResolvedValue({
      deleteAll: false,
      deleteOwn: false,
      editAll: true,
      editOwn: false,
    });
    jest.mocked(prepareJiraCommentEdit).mockReturnValue({
      text: 'hi @Sam Lee',
      mentions: [
        { start: 3, end: 11, accountId: 'acct-sam', displayName: 'Sam Lee' },
      ],
    });
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [comment({ id: 'c1', body: 'hi @Sam Lee' })],
      total: 1,
    });
    renderDrawer();
    await screen.findByText('hi @Sam Lee');

    // Opens the inline editor on c1 — a second composer, independent of the
    // one already sitting above the thread for a genuinely new comment.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(inlineEditBox().value).toBe('hi @Sam Lee'));
    const editBox = inlineEditBox();
    expect(editBox.value).toBe('hi @Sam Lee');

    // A plain top-level draft, not a Reply — compatible with an inline edit
    // open elsewhere in the thread (only Reply and Edit are mutually
    // exclusive; see JiraTicketDetail.tsx's renderComment). commentBox()
    // itself assumes a single match, which no longer holds now that both
    // composers are genuinely mounted together — the exact scenario this
    // test exists to cover — so the top one is picked out by exclusion.
    const boxes = screen.getAllByPlaceholderText(
      /Comment…/i,
    ) as HTMLTextAreaElement[];
    expect(boxes).toHaveLength(2);
    const topBox = boxes.find((b) => b !== editBox) as HTMLTextAreaElement;
    expect(topBox).not.toBe(editBox);

    fireEvent.change(topBox, { target: { value: 'new @sa' } });
    fireEvent.change(editBox, { target: { value: 'hi @sa' } });
    await runDebounce();

    const topControls = topBox.getAttribute('aria-controls');
    const editControls = editBox.getAttribute('aria-controls');
    expect(topControls).toBeTruthy();
    expect(editControls).toBeTruthy();
    expect(topControls).not.toBe(editControls);

    const topListbox = document.getElementById(topControls as string);
    const editListbox = document.getElementById(editControls as string);
    expect(topListbox).not.toBeNull();
    expect(editListbox).not.toBeNull();
    expect(topListbox).not.toBe(editListbox);

    // Each textarea's own aria-activedescendant resolves to an option
    // inside ITS OWN listbox, not the other instance's — the exact failure
    // a shared, ticketId-only id would silently produce.
    const topOption = topListbox?.querySelector('[role="option"]');
    const editOption = editListbox?.querySelector('[role="option"]');
    expect(topOption?.id).toBeTruthy();
    expect(editOption?.id).toBeTruthy();
    expect(topOption?.id).not.toBe(editOption?.id);
    expect(topBox.getAttribute('aria-activedescendant')).toBe(topOption?.id);
    expect(editBox.getAttribute('aria-activedescendant')).toBe(editOption?.id);
  });
});

// ROAD-41: Jira's own "Add a comment…" box sits at the top of the activity
// thread, directly under the tabs, above every existing comment (verified
// live against ENG-84) — Waypoint's used to sit after the whole list
// instead.
describe('the comment composer sits above the thread', () => {
  it('renders before every existing comment in the DOM, not after them', async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [
        comment({ id: 'c1', body: 'first comment' }),
        comment({ id: 'c2', body: 'second comment' }),
      ],
      total: 2,
    });
    renderDrawer();
    await screen.findByText('first comment');
    await screen.findByText('second comment');

    const box = commentBox();
    const firstComment = screen.getByText('first comment');
    // Neither element is an ancestor of the other (the composer and the
    // thread are siblings under the same panel), so this comparison can
    // only ever come back as exactly DOCUMENT_POSITION_FOLLOWING — no other
    // bit can be set — when `firstComment` comes after `box` in the
    // document. A strict equality check says that without a bitwise `&`,
    // which this project's eslint config disallows outright.
    expect(box.compareDocumentPosition(firstComment)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

describe('the comment composer formatting toolbar', () => {
  function selectAll(box: HTMLTextAreaElement) {
    box.setSelectionRange(0, box.value.length);
  }

  it('wraps a selection in ** when Bold is clicked', () => {
    renderDrawer();
    const box = commentBox();
    fireEvent.change(box, { target: { value: 'important' } });
    selectAll(box);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Bold' }));

    expect(box.value).toBe('**important**');
  });

  it('toggles a bullet prefix off when the line already has one', () => {
    renderDrawer();
    const box = commentBox();
    fireEvent.change(box, { target: { value: '- already a bullet' } });
    box.setSelectionRange(3, 3);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Bullet list' }));

    expect(box.value).toBe('already a bullet');
  });

  it('wraps a selection in a fenced code block', () => {
    renderDrawer();
    const box = commentBox();
    fireEvent.change(box, { target: { value: 'const x = 1;' } });
    selectAll(box);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Code block' }));

    expect(box.value).toBe('```\nconst x = 1;\n```');
  });

  it('opens an emoji popover and inserts the picked emoji at the caret', () => {
    renderDrawer();
    const box = commentBox();
    fireEvent.change(box, { target: { value: 'nice ' } });
    box.setSelectionRange(5, 5);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Emoji' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: /thumbs up/i }));

    expect(box.value).toBe('nice 👍');
  });

  it('attaches a file and links it into the draft at the caret', async () => {
    jest.mocked(uploadJiraAttachment).mockResolvedValue({
      canceled: false,
      ticket: ticket({
        attachments: [attachment({ id: '10099', fileName: 'screenshot.png' })],
      }),
    });
    renderDrawer();
    const box = commentBox();
    fireEvent.change(box, { target: { value: 'see this: ' } });
    box.setSelectionRange(10, 10);

    fireEvent.mouseDown(
      screen.getByRole('button', { name: 'Attach a file to this comment' }),
    );

    await waitFor(() =>
      expect(box.value).toBe(
        'see this: [📎 screenshot.png](https://waypoint123.atlassian.net/rest/api/3/attachment/content/10099) ',
      ),
    );
    expect(onTicketUpdated).toHaveBeenCalled();
  });

  it('does not link anything when the attach dialog is cancelled', async () => {
    jest
      .mocked(uploadJiraAttachment)
      .mockResolvedValue({ canceled: true, ticket: null });
    renderDrawer();
    const box = commentBox();
    fireEvent.change(box, { target: { value: 'see this: ' } });

    fireEvent.mouseDown(
      screen.getByRole('button', { name: 'Attach a file to this comment' }),
    );

    await waitFor(() => expect(uploadJiraAttachment).toHaveBeenCalled());
    expect(box.value).toBe('see this: ');
    expect(onTicketUpdated).not.toHaveBeenCalled();
  });
});

// The failure this guards against is silent by construction: a capped page
// and a whole thread render identically, so a reader finishes 100 comments on
// a 312-comment incident believing they have read the issue.
describe('comment thread truncation', () => {
  function threadComment(id: string) {
    return {
      id,
      ticketId: '10421',
      authorName: 'Sam Lee',
      authorAccountId: 'acct-sam',
      updatedAt: null,
      updateAuthorName: null,
      body: `comment ${id}`,
      createdAt: '2026-09-01T09:00:00.000+0000',
      parentId: null,
      postedByWaypoint: false,
      disclosureText: null,
      bodyAdf: null,
    };
  }

  it('says how many of the thread it is showing when the page is capped', async () => {
    jest.mocked(listJiraComments).mockResolvedValue({
      comments: [threadComment('1'), threadComment('2')],
      total: 312,
    });

    renderDrawer();

    // The real number, from Jira — not a vague "there are more".
    expect(
      await screen.findByText(/Showing the 2 most recent of 312 comments/),
    ).toBeInTheDocument();
  });

  it('says nothing when the thread arrived whole', async () => {
    jest
      .mocked(listJiraComments)
      .mockResolvedValue({ comments: [threadComment('1')], total: 1 });

    renderDrawer();

    await screen.findByText('comment 1');
    expect(screen.queryByText(/most recent of/)).toBeNull();
  });

  // Posting grows the thread. Without the total growing with it, the notice
  // counts a comment on the left of "of" that it never counted on the right.
  it('keeps the notice honest after posting into a capped thread', async () => {
    jest
      .mocked(listJiraComments)
      .mockResolvedValue({ comments: [threadComment('1')], total: 312 });
    jest.mocked(postJiraComment).mockResolvedValue(threadComment('new'));
    renderDrawer();
    await screen.findByText(/most recent of 312/);

    fireEvent.change(commentBox(), { target: { value: 'a reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    expect(
      await screen.findByText(/Showing the 2 most recent of 313 comments/),
    ).toBeInTheDocument();
  });
});

// The gap that let two silent mention bugs ship. Every test that existed
// inserted a mention and posted immediately; none of them EDITED the draft
// afterwards, which is where both failures lived. The assertion that matters
// is not "a span survived" but "the span still names the mention in the text
// being posted" — a span that has drifted still looks like a span, and
// buildCommentAdf silently degrades it to plain text, so the comment posts
// looking correct and notifies nobody.
describe('mention spans survive ordinary editing', () => {
  async function draftWithMention() {
    const box = commentBox();
    fireEvent.change(box, { target: { value: 'hi @sa' } });
    await runDebounce();
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Sam Lee' }));
    expect(box.value).toBe('hi @Sam Lee ');
    return box;
  }

  /** What buildCommentAdf will check at serialization time, asserted here
   *  against whatever the composer actually handed over. */
  async function postedMentionSlices(): Promise<string[]> {
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(postJiraComment).toHaveBeenCalled());
    const [, text, mentions] = jest.mocked(postJiraComment).mock.calls[0];
    return (mentions ?? []).map((m) => text.slice(m.start, m.end));
  }

  beforeEach(() => {
    jest.mocked(postJiraComment).mockResolvedValue(comment());
  });

  // wrapSelection passed a delta of prefix+suffix+selectionLength; the net
  // change is only prefix+suffix, so every mention after the selection
  // over-shifted by the selection's own length. "@Sam Lee" sliced to
  // "m Lee st".
  it('keeps a mention intact when text before it is bolded', async () => {
    renderDrawer();
    const box = await draftWithMention();

    box.setSelectionRange(0, 2); // "hi"
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Bold' }));

    expect(box.value).toBe('**hi** @Sam Lee ');
    expect(await postedMentionSlices()).toEqual(['@Sam Lee']);
  });

  // A mention inside the wrapped range used to be dropped outright by the
  // overlap-means-drop rule, so bolding a line containing a mention silently
  // stopped it notifying.
  it('keeps a mention intact when the selection wrapping it is bolded', async () => {
    renderDrawer();
    const box = await draftWithMention();

    box.setSelectionRange(0, 12); // the whole draft, mention included
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Bold' }));

    expect(box.value).toBe('**hi @Sam Lee **');
    expect(await postedMentionSlices()).toEqual(['@Sam Lee']);
  });

  // handleChange reverse-engineered the edited range from a length delta,
  // which is wrong for any edit that both removes and inserts. This dropped
  // the span entirely — the mention was never touched by the user.
  it('keeps a mention intact when a word before it is selected and retyped', async () => {
    renderDrawer();
    const box = await draftWithMention();

    fireEvent.change(box, { target: { value: 'hello @Sam Lee ' } });

    expect(await postedMentionSlices()).toEqual(['@Sam Lee']);
  });

  // Same edit, shrinking instead of growing.
  it('keeps a mention intact when text before it is shortened', async () => {
    renderDrawer();
    const box = await draftWithMention();

    fireEvent.change(box, { target: { value: 'h @Sam Lee ' } });

    expect(await postedMentionSlices()).toEqual(['@Sam Lee']);
  });

  // The old guard was `if (delta !== 0)`, so a same-length replacement
  // changed the text while skipping the shift entirely, leaving the span
  // pointing at characters that had been typed over.
  it('drops a mention typed over by a same-length replacement', async () => {
    renderDrawer();
    const box = await draftWithMention();

    // "@Sam Lee" replaced by 8 different characters: same length, no delta.
    fireEvent.change(box, { target: { value: 'hi XXXXXXXX ' } });

    expect(await postedMentionSlices()).toEqual([]);
  });
});

// ROAD-41: subtasks, linked work items, labels and a due date all landed on
// JiraTicket with the read side of the ticket detail as their only consumer
// so far — the data-layer fill for these fields is a separate, parallel
// change, so every fixture in this file (via `ticket()`'s own defaults)
// leaves them empty, which is exactly the common case these tests pin: a
// section with nothing in it renders an explicit "nothing here" line rather
// than a bare heading over blank space, matching how Attachments and
// Comments already handle emptiness in this same component.
describe('subtasks, linked work items, labels and due date (ROAD-41)', () => {
  it('renders an explicit empty state for each, not a bare heading', () => {
    renderDrawer();

    expect(screen.getByText('No subtasks.')).toBeInTheDocument();
    expect(screen.getByText('No linked work items.')).toBeInTheDocument();
    // Epic, Sprint, Labels and Due date all render "None" on this fixture —
    // one more "None" than before this change pins that Labels joined them
    // rather than silently falling back to a blank cell.
    expect(screen.getAllByText('None')).toHaveLength(4);
  });

  it('lists subtasks with their key, title and current state', () => {
    renderDrawer({
      subtasks: [
        {
          id: 'st-1',
          key: 'ENG-422',
          title: 'Add a retry queue',
          stateName: 'To Do',
          stateColor: 'var(--text-muted)',
        },
        {
          id: 'st-2',
          key: 'ENG-423',
          title: 'Backfill dropped events',
          stateName: 'Done',
          stateColor: 'var(--success)',
        },
      ],
    });

    expect(screen.getByText('ENG-422')).toBeInTheDocument();
    expect(screen.getByText('Add a retry queue')).toBeInTheDocument();
    expect(screen.getByText('To Do')).toBeInTheDocument();
    expect(screen.getByText('ENG-423')).toBeInTheDocument();
    expect(screen.getByText('Backfill dropped events')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.queryByText('No subtasks.')).toBeNull();
  });

  it('groups linked work items under their own relation, not one flat list', () => {
    renderDrawer({
      links: [
        {
          id: 'l-1',
          relation: 'blocks',
          key: 'ENG-500',
          title: 'Rate limiter rollout',
          stateName: 'In Progress',
          stateColor: 'var(--warning)',
        },
        {
          id: 'l-2',
          relation: 'is blocked by',
          key: 'OPS-12',
          title: 'Provision the queue cluster',
          stateName: 'To Do',
          stateColor: 'var(--text-muted)',
        },
      ],
    });

    expect(screen.getByText('blocks')).toBeInTheDocument();
    expect(screen.getByText('ENG-500')).toBeInTheDocument();
    expect(screen.getByText('Rate limiter rollout')).toBeInTheDocument();
    expect(screen.getByText('is blocked by')).toBeInTheDocument();
    expect(screen.getByText('OPS-12')).toBeInTheDocument();
    expect(screen.getByText('Provision the queue cluster')).toBeInTheDocument();
    expect(screen.queryByText('No linked work items.')).toBeNull();
  });

  it('renders labels as chips instead of the empty placeholder', () => {
    renderDrawer({ labels: ['flaky-test', 'needs-design'] });

    expect(screen.getByText('flaky-test')).toBeInTheDocument();
    expect(screen.getByText('needs-design')).toBeInTheDocument();
    // Epic, Sprint and Due date still fall back to "None" on this fixture —
    // Labels no longer does, so the count drops back to the pre-Labels three.
    expect(screen.getAllByText('None')).toHaveLength(3);
  });

  // dueDate is date-only ("2026-09-14"), never a timestamp — parsing it as a
  // UTC instant and formatting in a western-of-UTC test runner would print
  // the day before it. This pins the literal calendar date, not just "some
  // non-empty string".
  it("renders the due date as Jira's own calendar date, not a UTC-shifted one", () => {
    renderDrawer({ dueDate: '2026-09-14' });

    expect(screen.getByText('Sep 14, 2026')).toBeInTheDocument();
    expect(screen.queryByText('2026-09-14')).toBeNull();
  });

  // The description already had a plain-text path before this change;
  // JiraRichText is a stub today (adf is unread, it renders `fallback`), so
  // this pins that the switch to it did not regress the plain-text render
  // this file's other tests were never written to cover directly.
  it('still shows the plain-text description through JiraRichText', () => {
    renderDrawer({ description: 'Retries should back off exponentially.' });

    expect(
      screen.getByText('Retries should back off exponentially.'),
    ).toBeInTheDocument();
  });
});

// MY_JIRA_IMPROVEMENTS.md §5: this used to be a `fixed inset-0 bg-black/40`
// modal — a backdrop covering the whole window, unreachable-Copilot-toggle
// bug included. De-modalized to CopilotPanel.tsx's own docked-panel shape.
describe('de-modalized: no full-viewport backdrop', () => {
  it('renders no backdrop element', () => {
    renderDrawer();

    expect(document.querySelector('.bg-black\\/40')).toBeNull();
  });

  it('marks its own root with data-ticket-drawer, same as the native TicketDrawer', () => {
    renderDrawer();

    expect(document.querySelector('[data-ticket-drawer]')).toBeInTheDocument();
  });
});

// Escape used to call onClose() unconditionally, the instant it fired
// anywhere in the document. Now gated on focus, matching CopilotPanel.tsx's
// own Escape handler, for the same reason: keydown bubbles to `document`
// regardless of what's actually focused.
describe('Escape only closes when focus is inside the drawer', () => {
  function renderWithClose(onClose: () => void) {
    return render(
      <MemoryRouter>
        <JiraTicketDrawer
          ticket={ticket()}
          onTicketUpdated={onTicketUpdated}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
  }

  it('does nothing when focus is outside the drawer', () => {
    const onClose = jest.fn();
    renderWithClose(onClose);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    document.body.removeChild(outside);
  });

  it('closes when focus is inside the drawer', () => {
    const onClose = jest.fn();
    renderWithClose(onClose);
    commentBox().focus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// Same fix as CopilotPanel.tsx's previousFocusRef: without it, closing the
// drawer (via Escape, or its own × button) drops focus to <body> with
// nothing to return it to.
describe('focus restoration on close', () => {
  it('restores focus to whatever was focused before the drawer opened', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(
      <MemoryRouter>
        <JiraTicketDrawer
          ticket={ticket()}
          onTicketUpdated={onTicketUpdated}
          onClose={jest.fn()}
        />
      </MemoryRouter>,
    );

    // The caller unmounts this component on close (see e.g. MyJiraPage.tsx's
    // `{drawerTicket && <JiraTicketDrawer .../>}`) — this asserts the
    // cleanup effect that runs on that unmount, not a call to onClose.
    unmount();

    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });
});

// MY_JIRA_IMPROVEMENTS.md §5: once de-modalized, this drawer and CopilotPanel
// can both be on screen at once — same coordination TicketDrawer.test.tsx
// asserts for native tickets.
describe('docks beside Copilot when it is open', () => {
  function drawerRoot(): HTMLElement {
    return document.querySelector('[data-ticket-drawer]') as HTMLElement;
  }

  it('sits flush against the right edge while Copilot is closed', () => {
    jest.mocked(useCopilotOpenState).mockReturnValue(false);
    renderDrawer();

    expect(drawerRoot().className).toContain('right-0');
    expect(drawerRoot().className).not.toContain('right-[400px]');
  });

  it('shifts left by Copilot panel width while Copilot is open', () => {
    jest.mocked(useCopilotOpenState).mockReturnValue(true);
    renderDrawer();

    expect(drawerRoot().className).toContain('right-[400px]');
    expect(drawerRoot().className).not.toContain('right-0');
  });
});
