import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { postJiraComment, searchJiraAssignableUsers } from '@/data/jiraApi';
import { useJiraConnection } from '@/lib/jiraStore';
import type { JiraConnectionStatus } from '@/types/jira';
import { JiraCommentComposer } from './JiraCommentComposer';

// ROAD-17: the mention popover claimed role="listbox" with none of the real
// ARIA wiring that role requires — no role="option" on its rows, no
// aria-activedescendant tracking the highlight, no aria-controls linking the
// textarea to the listbox, no aria-selected on the current option. These
// tests cover exactly that wiring, not the composer's broader behavior
// (posting, formatting, attachments, ...), which is already exercised through
// JiraTicketDrawer.test.tsx.
jest.mock('@/data/jiraApi', () => ({
  postJiraComment: jest.fn(),
  searchJiraAssignableUsers: jest.fn(),
  uploadJiraAttachment: jest.fn(),
}));
jest.mock('@/lib/jiraStore', () => ({ useJiraConnection: jest.fn() }));
jest.mock('@/lib/toast', () => ({ showErrorToast: jest.fn() }));

const CONNECTION: JiraConnectionStatus = {
  connected: true,
  accountName: 'Max Chen',
  accountEmail: 'max@northwind.dev',
  accountId: 'acct-max',
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

function renderComposer() {
  return render(
    <JiraCommentComposer
      ticketId="10421"
      ticketKey="ENG-421"
      attachments={[]}
      onPosted={jest.fn()}
      onTicketUpdated={jest.fn()}
    />,
  );
}

function commentBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Comment…/i) as HTMLTextAreaElement;
}

/** The picker debounces its search by ~250ms; nothing arrives until the
 * timers this advances have run — same helper JiraTicketDrawer.test.tsx uses
 * for the same debounce. */
async function runDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
}

// jsdom doesn't implement scrollIntoView — the composer calls it on the
// newly-highlighted mention option so keyboard/mouse highlight movement
// stays visible, otherwise harmless in a real browser but throwing as an
// unhandled exception under jsdom. Same fix as TicketList.test.tsx's own
// j/k focus movement.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.mocked(useJiraConnection).mockReturnValue(CONNECTION);
  jest.mocked(searchJiraAssignableUsers).mockResolvedValue(ASSIGNABLE);
  jest.mocked(postJiraComment).mockResolvedValue({
    id: 'c1',
    ticketId: '10421',
    authorName: 'Max Chen',
    body: 'hi @Sam Lee',
    createdAt: '2026-01-01T00:00:00.000Z',
    postedByWaypoint: false,
    disclosureText: null,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('mention combobox wiring on the textarea', () => {
  // Deliberately not role="combobox": ARIA in HTML permits no role
  // override on <textarea> (it's fixed to the implicit "textbox" role),
  // and overriding it would risk losing multi-line textbox semantics for
  // screen readers navigating this composer. aria-expanded/aria-controls/
  // aria-activedescendant/aria-autocomplete are all valid on plain textbox
  // and carry the same popup contract without an invalid role.
  it('carries the popup contract with no role override, starting collapsed with no listbox or active option wired up', () => {
    renderComposer();

    const box = commentBox();
    expect(box).not.toHaveAttribute('role');
    expect(box).toHaveAttribute('aria-autocomplete', 'list');
    expect(box).toHaveAttribute('aria-expanded', 'false');
    expect(box).not.toHaveAttribute('aria-controls');
    expect(box).not.toHaveAttribute('aria-activedescendant');
  });

  it('expands and links aria-controls to the listbox once the popover opens', async () => {
    renderComposer();
    const box = commentBox();

    fireEvent.change(box, { target: { value: '@' } });
    await runDebounce();

    expect(box).toHaveAttribute('aria-expanded', 'true');
    const controlsId = box.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();

    const listbox = screen.getByRole('listbox', {
      name: 'Mention someone on ENG-421',
    });
    expect(listbox).toHaveAttribute('id', controlsId);
  });

  it('collapses aria-expanded and drops aria-controls/aria-activedescendant on Escape', async () => {
    renderComposer();
    const box = commentBox();

    fireEvent.change(box, { target: { value: '@sa' } });
    await runDebounce();
    expect(box).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(box, { key: 'Escape' });

    expect(box).toHaveAttribute('aria-expanded', 'false');
    expect(box).not.toHaveAttribute('aria-controls');
    expect(box).not.toHaveAttribute('aria-activedescendant');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  // Escape is covered above; picking a mention is the OTHER way the
  // popover closes, and it has to drop the same wiring — an unpicked
  // Escape and a genuinely-completed pick are both "the popover is gone
  // now" as far as the combobox contract is concerned.
  it('collapses aria-expanded and drops aria-controls/aria-activedescendant on picking a mention', async () => {
    renderComposer();
    const box = commentBox();

    fireEvent.change(box, { target: { value: '@sa' } });
    await runDebounce();
    expect(box).toHaveAttribute('aria-expanded', 'true');

    fireEvent.mouseDown(screen.getByRole('option', { name: 'Sam Lee' }));

    expect(box).toHaveAttribute('aria-expanded', 'false');
    expect(box).not.toHaveAttribute('aria-controls');
    expect(box).not.toHaveAttribute('aria-activedescendant');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('mention option rows', () => {
  it('gives every row role="option" with a stable id', async () => {
    renderComposer();
    fireEvent.change(commentBox(), { target: { value: '@' } });
    await runDebounce();

    const sam = screen.getByRole('option', { name: 'Sam Lee' });
    const priya = screen.getByRole('option', { name: 'Priya Raman' });
    expect(sam).toHaveAttribute('id');
    expect(priya).toHaveAttribute('id');
    expect(sam.id).not.toBe(priya.id);
  });

  it('marks only the first result as selected by default', async () => {
    renderComposer();
    fireEvent.change(commentBox(), { target: { value: '@' } });
    await runDebounce();

    expect(screen.getByRole('option', { name: 'Sam Lee' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('option', { name: 'Priya Raman' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('is not a Tab stop, since the combobox pattern keeps real focus on the textarea', async () => {
    renderComposer();
    fireEvent.change(commentBox(), { target: { value: '@' } });
    await runDebounce();

    expect(screen.getByRole('option', { name: 'Sam Lee' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });
});

describe('aria-activedescendant tracks the same highlight arrow keys move', () => {
  it('points at the first option as soon as results land', async () => {
    renderComposer();
    const box = commentBox();

    fireEvent.change(box, { target: { value: '@' } });
    await runDebounce();

    const sam = screen.getByRole('option', { name: 'Sam Lee' });
    expect(box).toHaveAttribute('aria-activedescendant', sam.id);
  });

  it('moves to the next option on ArrowDown, agreeing with aria-selected and the visual highlight', async () => {
    renderComposer();
    const box = commentBox();

    fireEvent.change(box, { target: { value: '@' } });
    await runDebounce();

    fireEvent.keyDown(box, { key: 'ArrowDown' });

    const sam = screen.getByRole('option', { name: 'Sam Lee' });
    const priya = screen.getByRole('option', { name: 'Priya Raman' });

    // aria-activedescendant now names Priya...
    expect(box).toHaveAttribute('aria-activedescendant', priya.id);
    // ...and aria-selected agrees: Priya is selected, Sam no longer is...
    expect(priya).toHaveAttribute('aria-selected', 'true');
    expect(sam).toHaveAttribute('aria-selected', 'false');
    // ...and so does the row's own visual highlight class.
    expect(priya.className).toMatch(/bg-surface-2/);
    expect(sam.className).not.toMatch(/bg-surface-2/);
  });

  it('wraps back to the first option on ArrowUp from the first row', async () => {
    renderComposer();
    const box = commentBox();

    fireEvent.change(box, { target: { value: '@' } });
    await runDebounce();

    fireEvent.keyDown(box, { key: 'ArrowUp' });

    const priya = screen.getByRole('option', { name: 'Priya Raman' });
    expect(box).toHaveAttribute('aria-activedescendant', priya.id);
    expect(priya).toHaveAttribute('aria-selected', 'true');
  });

  it('follows hovering a row with the mouse, same as it follows the keyboard', async () => {
    renderComposer();
    const box = commentBox();

    fireEvent.change(box, { target: { value: '@' } });
    await runDebounce();

    const priya = screen.getByRole('option', { name: 'Priya Raman' });
    fireEvent.mouseEnter(priya);

    expect(box).toHaveAttribute('aria-activedescendant', priya.id);
    expect(priya).toHaveAttribute('aria-selected', 'true');
  });

  it('has no active option while results are still loading', async () => {
    renderComposer();
    const box = commentBox();

    fireEvent.change(box, { target: { value: '@' } });
    // Deliberately not running the debounce timer: the popover is open with
    // its "Searching teammates…" state and no option rows exist yet, so
    // aria-activedescendant must not dangle on a nonexistent id.
    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(box).not.toHaveAttribute('aria-activedescendant');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  // The test above passes even without the loadingSuggestions check, since
  // suggestions is still genuinely [] the first time a query is typed. The
  // search effect does NOT clear suggestions on every keystroke, only when
  // trigger goes null entirely — so a RE-query (the query text changes
  // while a previous result set is already showing) is the case that
  // actually exercises loadingSuggestions: suggestions still holds the old
  // rows while loadingSuggestions flips back to true, and only the
  // loadingSuggestions check stops aria-activedescendant/the option rows
  // from carrying on pointing at that stale result set mid-fetch.
  it('has no active option while re-querying, even though the previous results are still in state', async () => {
    renderComposer();
    const box = commentBox();

    fireEvent.change(box, { target: { value: '@' } });
    await runDebounce();
    expect(screen.getByRole('option', { name: 'Sam Lee' })).toBeInTheDocument();

    fireEvent.change(box, { target: { value: '@sa' } });
    // Deliberately not running the debounce timer for this second query.

    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(box).not.toHaveAttribute('aria-activedescendant');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });
});

describe('the listbox has an accessible name', () => {
  it('labels the popover "Mention someone on <ticketKey>"', async () => {
    renderComposer();
    fireEvent.change(commentBox(), { target: { value: '@' } });
    await runDebounce();

    expect(
      screen.getByRole('listbox', { name: 'Mention someone on ENG-421' }),
    ).toBeInTheDocument();
  });
});
