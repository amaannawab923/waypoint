import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  getJiraPriorityOptions,
  getJiraTransitions,
  setJiraTicketPriority,
  transitionJiraTicket,
} from '@/data/jiraApi';
import { showErrorToast, showInfoToast } from '@/lib/toast';
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
jest.mock('@/lib/toast', () => ({
  showErrorToast: jest.fn(),
  showInfoToast: jest.fn(),
}));

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

// Customer feedback round 1, Fix 5: a pick no longer writes on its own
// click — the panel asks first, and a write that went through gets an
// undo toast whose button is a real inverse write.
describe('choosing a priority', () => {
  it('writes nothing on the pick alone — the panel asks first', async () => {
    renderRow();

    fireEvent.click(priorityChip());
    fireEvent.click(await screen.findByRole('button', { name: 'Medium' }));

    expect(
      document.querySelector('[data-priority-confirm]')?.textContent,
    ).toMatch(/Set ENG-421 to Medium\?/);
    expect(setJiraTicketPriority).not.toHaveBeenCalled();
  });

  it('Cancel returns to the options, nothing written', async () => {
    renderRow();

    fireEvent.click(priorityChip());
    fireEvent.click(await screen.findByRole('button', { name: 'Medium' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Lowest' })).toBeInTheDocument();
    expect(setJiraTicketPriority).not.toHaveBeenCalled();
  });

  it('Set writes the chosen id, hands the re-read ticket up, and offers Undo', async () => {
    const updated = ticket({
      priority: 'medium',
      priorityId: '3',
      priorityName: 'Medium',
    });
    jest.mocked(setJiraTicketPriority).mockResolvedValue(updated);
    renderRow();

    fireEvent.click(priorityChip());
    fireEvent.click(await screen.findByRole('button', { name: 'Medium' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));

    // The id, not the label: "Medium" is this site's word for priority 3 and
    // another site's word for nothing at all.
    await waitFor(() =>
      expect(setJiraTicketPriority).toHaveBeenCalledWith('10421', '3'),
    );
    expect(onTicketUpdated).toHaveBeenCalledWith(updated);
    await waitFor(() =>
      expect(showInfoToast).toHaveBeenCalledWith(
        'Set ENG-421 to Medium.',
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Undo' }),
        }),
      ),
    );

    // Undo is the previous priority written back — a real write.
    const reverted = ticket();
    jest.mocked(setJiraTicketPriority).mockResolvedValue(reverted);
    const [, options] = jest.mocked(showInfoToast).mock.calls[0];
    options?.action?.onClick();
    await waitFor(() =>
      expect(setJiraTicketPriority).toHaveBeenLastCalledWith('10421', '1'),
    );
    expect(onTicketUpdated).toHaveBeenLastCalledWith(reverted);
    expect(showInfoToast).toHaveBeenLastCalledWith(
      'Reverted.',
      expect.anything(),
    );
  });

  it('surfaces a rejected write and updates nothing', async () => {
    jest
      .mocked(setJiraTicketPriority)
      .mockRejectedValue(new Error('Field priority cannot be set.'));
    renderRow();

    fireEvent.click(priorityChip());
    fireEvent.click(await screen.findByRole('button', { name: 'Medium' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        'Field priority cannot be set.',
      ),
    );
    expect(onTicketUpdated).not.toHaveBeenCalled();
    expect(showInfoToast).not.toHaveBeenCalled();
  });
});

describe('moving a ticket', () => {
  const REVIEW = {
    id: '21',
    targetStateName: 'In Review',
    targetStateColor: 'var(--accent)',
    requiresFields: [],
  };
  const BACK = {
    id: '11',
    targetStateName: 'In Progress',
    targetStateColor: 'var(--warning)',
    requiresFields: [],
  };

  function stateChip(): HTMLElement {
    return screen.getByRole('button', { name: /In Progress/ });
  }

  it('writes nothing on the pick alone — the panel asks first, naming the state', async () => {
    jest.mocked(getJiraTransitions).mockResolvedValue([REVIEW]);
    renderRow();

    fireEvent.click(stateChip());
    fireEvent.click(await screen.findByRole('button', { name: /In Review/ }));

    const confirm = document.querySelector('[data-transition-confirm]');
    expect(confirm?.textContent).toMatch(/Move ENG-421 to In Review\?/);
    expect(confirm?.textContent).toMatch(/Watchers will be notified/);
    expect(transitionJiraTicket).not.toHaveBeenCalled();
  });

  it('Move writes, then offers Undo as the workflow’s own way back', async () => {
    const moved = ticket({ stateName: 'In Review' });
    jest.mocked(getJiraTransitions).mockResolvedValueOnce([REVIEW]);
    jest.mocked(transitionJiraTicket).mockResolvedValue(moved);
    // After the move, the transitions legal from In Review.
    jest.mocked(getJiraTransitions).mockResolvedValueOnce([BACK]);
    renderRow();

    fireEvent.click(stateChip());
    fireEvent.click(await screen.findByRole('button', { name: /In Review/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    await waitFor(() =>
      expect(transitionJiraTicket).toHaveBeenCalledWith('10421', '21', {}),
    );
    expect(onTicketUpdated).toHaveBeenCalledWith(moved);
    await waitFor(() =>
      expect(showInfoToast).toHaveBeenCalledWith(
        'Moved ENG-421 to In Review.',
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Undo' }),
        }),
      ),
    );

    const reverted = ticket();
    jest.mocked(transitionJiraTicket).mockResolvedValue(reverted);
    const [, options] = jest.mocked(showInfoToast).mock.calls[0];
    options?.action?.onClick();
    await waitFor(() =>
      expect(transitionJiraTicket).toHaveBeenLastCalledWith('10421', '11', {}),
    );
    expect(onTicketUpdated).toHaveBeenLastCalledWith(reverted);
  });

  it('offers no Undo when the workflow has no way back', async () => {
    const moved = ticket({ stateName: 'In Review' });
    jest.mocked(getJiraTransitions).mockResolvedValueOnce([REVIEW]);
    jest.mocked(transitionJiraTicket).mockResolvedValue(moved);
    jest
      .mocked(getJiraTransitions)
      .mockResolvedValueOnce([
        { ...REVIEW, id: '31', targetStateName: 'Done' },
      ]);
    renderRow();

    fireEvent.click(stateChip());
    fireEvent.click(await screen.findByRole('button', { name: /In Review/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    await waitFor(() =>
      expect(showInfoToast).toHaveBeenCalledWith(
        'Moved ENG-421 to In Review.',
        expect.not.objectContaining({ action: expect.anything() }),
      ),
    );
  });

  it('a failed Undo is an error toast, not a pretended revert', async () => {
    const moved = ticket({ stateName: 'In Review' });
    jest.mocked(getJiraTransitions).mockResolvedValueOnce([REVIEW]);
    jest.mocked(transitionJiraTicket).mockResolvedValueOnce(moved);
    jest.mocked(getJiraTransitions).mockResolvedValueOnce([BACK]);
    renderRow();

    fireEvent.click(stateChip());
    fireEvent.click(await screen.findByRole('button', { name: /In Review/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(showInfoToast).toHaveBeenCalled());

    jest
      .mocked(transitionJiraTicket)
      .mockRejectedValueOnce(new Error('Transition 11 is not valid here.'));
    const [, options] = jest.mocked(showInfoToast).mock.calls[0];
    options?.action?.onClick();

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        'Transition 11 is not valid here.',
      ),
    );
    expect(onTicketUpdated).toHaveBeenCalledTimes(1);
  });
});

// ROAD-27 / docs/qa/manual-test-cases.md's JIRA-157: a first attempt at this
// row-width fix (9481ce4) asserted these same shrink-0/min-w-0 classes and
// called them "the row survives a narrow width" — but a class existing in
// jsdom output proves nothing about whether the row actually fits any real
// viewport, and a review found the ~600px row still overflowed by 80-120px
// at HEAD despite every one of these classes already being present. jsdom
// does no layout at all, so none of the tests below — before or after this
// fix — can prove the row survives a squeeze at any real width. Each one is
// a class assertion, not a layout measurement, and every name below says so
// explicitly rather than reading as a layout guarantee. The real ~600px
// check happens live in the app; see the arithmetic comment on
// JiraTicketRow.tsx's badge wrapper for what these classes are now meant to
// add up to. The priority chip's `shrink-0` comes from
// JiraPriorityPicker.tsx's own JiraPriorityChip root class, and the
// avatar's from Avatar.tsx's own root class, not from anything this file
// sets — those two remain regression locks on a guarantee owned elsewhere.
describe('row-width class assertions (ROAD-27 / JIRA-157)', () => {
  it('carries shrink-0 on the priority chip (class assertion — jsdom does no layout)', () => {
    renderRow();

    expect(priorityChip()).toHaveClass('shrink-0');
  });

  it('carries shrink-0 on the assignee avatar (class assertion — jsdom does no layout)', () => {
    renderRow();

    expect(screen.getByTitle('Max Chen')).toHaveClass('shrink-0');
  });

  it('carries min-w-0 flex-1 truncate on the title (class assertion — jsdom does no layout)', () => {
    renderRow();

    const title = screen.getByRole('button', {
      name: 'Webhook receiver drops events past 500/min',
    });
    expect(title).toHaveClass('min-w-0');
    expect(title).toHaveClass('flex-1');
    expect(title).toHaveClass('truncate');
  });

  // What this fix (not the first attempt) actually adds: the state chip's
  // label is now bounded rather than unbounded, with the full name preserved
  // in `title` — see JiraTransitionPopover.tsx's JiraStateChip.
  it('bounds the state chip label to max-w-[80px] and truncates it, carrying the full name in title (class assertion — jsdom does no layout)', () => {
    renderRow({ stateName: 'In Progress' });

    const label = screen.getByTitle('In Progress');
    expect(label).toHaveClass('max-w-[80px]');
    expect(label).toHaveClass('truncate');
  });

  // The other half of this fix: the role tag / state chip / priority chip /
  // avatar are grouped into their own `flex flex-wrap` sub-row so they can
  // reflow onto more than one line under a real squeeze instead of being
  // clipped by MyJiraPage.tsx's `overflow-hidden` list wrapper.
  it('groups the trailing badges into a flex-wrap sub-row so they can reflow instead of overflow (class assertion — jsdom does no layout)', () => {
    renderRow({ stateName: 'In Progress' });

    const stateChip = screen.getByRole('button', { name: 'In Progress' });
    expect(stateChip.parentElement).toHaveClass('flex');
    expect(stateChip.parentElement).toHaveClass('flex-wrap');
    // Same wrapper for all four trailing badges, not one each.
    expect(priorityChip().parentElement).toBe(stateChip.parentElement);
    expect(screen.getByTitle('Max Chen').parentElement).toBe(
      stateChip.parentElement,
    );
  });
});
