import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getJiraPriorityOptions, setJiraTicketPriority } from '@/data/jiraApi';
import { showErrorToast } from '@/lib/toast';
import type { JiraTicket } from '@/types/jira';
import { JiraTicketRow } from './JiraTicketRow';

// The row owns both pickers' data fetching and both writes; the pickers
// themselves are pure. So this is the level the priority flow is actually
// testable at — mocking the data module is what lets the real row, the real
// chip and the real portaled panel render together.
jest.mock('@/data/jiraApi', () => ({
  getJiraTransitions: jest.fn(),
  transitionJiraTicket: jest.fn(),
  getJiraPriorityOptions: jest.fn(),
  setJiraTicketPriority: jest.fn(),
}));
jest.mock('@/lib/toast', () => ({ showErrorToast: jest.fn() }));

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

const OPTIONS = [
  { id: '1', name: 'Highest' },
  { id: '3', name: 'Medium' },
  { id: '5', name: 'Lowest' },
];

const onTicketUpdated = jest.fn();

function renderRow(overrides: Partial<JiraTicket> = {}) {
  return render(
    <JiraTicketRow
      ticket={ticket(overrides)}
      onOpenDrawer={jest.fn()}
      onTicketUpdated={onTicketUpdated}
      onResolveConflict={jest.fn()}
      onDismissTombstone={jest.fn()}
    />,
  );
}

/** By accessible name, deliberately: the chip's content is a decorative glyph,
 * so the aria-label is the only thing naming it — and asking for it this way
 * is what makes "a keyboard/screen-reader user can find this control" part of
 * what these tests hold, rather than only "a mouse user can click it". */
function priorityChip(name = 'Priority: Highest'): HTMLElement {
  return screen.getByRole('button', { name });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getJiraPriorityOptions).mockResolvedValue(OPTIONS);
});

describe('the priority chip', () => {
  // PriorityIcon can only draw the five-bucket normalization, so without this
  // a site that calls its top priority "Blocker" would have that word appear
  // nowhere in the row at all.
  it('is a real button carrying the site’s own priority name', () => {
    renderRow({ priority: 'urgent', priorityName: 'Blocker' });

    const chip = priorityChip('Priority: Blocker');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip).toBeEnabled();
  });

  // Opening a menu is what a user pays a network round trip for; rendering a
  // list of rows must not.
  it('reads nothing from Jira until it is opened', () => {
    renderRow();

    expect(getJiraPriorityOptions).not.toHaveBeenCalled();
  });

  // Keeps its name while disabled — the reason goes in `title`, not over the
  // top of the label, so the control does not go anonymous in the one state
  // where a user most needs to know what it is.
  it('is disabled, and says why, while the ticket is in conflict', () => {
    renderRow({ hasConflict: true });

    const chip = priorityChip();
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('title', 'Write paused until reloaded');
  });
});

describe('opening the priority picker', () => {
  it('fetches this issue’s own options and lists them in the site’s words', async () => {
    renderRow();

    fireEvent.click(priorityChip());

    await waitFor(() =>
      expect(getJiraPriorityOptions).toHaveBeenCalledWith('10421'),
    );
    expect(
      await screen.findByRole('button', { name: 'Medium' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lowest' })).toBeInTheDocument();
  });

  it('marks the priority the issue is already on', async () => {
    renderRow();

    fireEvent.click(priorityChip());

    const current = await screen.findByRole('button', {
      name: /Highest\s+current/i,
    });
    expect(current).toBeInTheDocument();
  });

  // "Jira offers no priorities on this issue" and "we could not ask Jira" are
  // different answers, and a swallowed failure rendering the first one is the
  // exact defect JiraLoadError was introduced for.
  it('renders a failed read as an error, never as "no options"', async () => {
    jest
      .mocked(getJiraPriorityOptions)
      .mockRejectedValue(new Error("Couldn't reach Jira."));
    renderRow();

    fireEvent.click(priorityChip());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't reach Jira.",
    );
    expect(screen.queryByText(/No priority options here/i)).toBeNull();
  });

  // An issue type whose edit screen has no priority field is ordinary, not
  // broken — the same shape as a workflow that offers no moves.
  it('renders a genuinely empty list as an absence, not a failure', async () => {
    jest.mocked(getJiraPriorityOptions).mockResolvedValue([]);
    renderRow();

    fireEvent.click(priorityChip());

    expect(
      await screen.findByText(/No priority options here/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('choosing a priority', () => {
  it('writes the chosen id and hands the re-read ticket up', async () => {
    const updated = ticket({ priority: 'medium', priorityId: '3' });
    jest.mocked(setJiraTicketPriority).mockResolvedValue(updated);
    renderRow();

    fireEvent.click(priorityChip());
    fireEvent.click(await screen.findByRole('button', { name: 'Medium' }));

    // The id, not the label: "Medium" is this site's word for priority 3 and
    // another site's word for nothing at all.
    await waitFor(() =>
      expect(setJiraTicketPriority).toHaveBeenCalledWith('10421', '3'),
    );
    expect(onTicketUpdated).toHaveBeenCalledWith(updated);
  });

  it('surfaces a rejected write and updates nothing', async () => {
    jest
      .mocked(setJiraTicketPriority)
      .mockRejectedValue(new Error('Field priority cannot be set.'));
    renderRow();

    fireEvent.click(priorityChip());
    fireEvent.click(await screen.findByRole('button', { name: 'Medium' }));

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        'Field priority cannot be set.',
      ),
    );
    expect(onTicketUpdated).not.toHaveBeenCalled();
  });
});
