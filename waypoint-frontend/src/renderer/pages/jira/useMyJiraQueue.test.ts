import type { JiraTicket } from '@/types/jira';
import {
  compareIssueKeys,
  compareTickets,
  hasActiveQuery,
  matchesQuery,
  pageWindow,
  DEFAULT_QUERY,
  type JiraQueueQuery,
} from './useMyJiraQueue';

// Everything under test here is a pure function, exported precisely so it can
// be exercised without a render. The queue's behaviour through the actual UI
// is MyJiraPage.test.tsx's job; this file is about the two comparators and
// the predicate being right on the cases a rendered test would never think to
// construct.

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

function query(overrides: Partial<JiraQueueQuery> = {}): JiraQueueQuery {
  return { ...DEFAULT_QUERY, ...overrides };
}

describe('compareIssueKeys', () => {
  // The whole reason this function exists rather than a bare localeCompare.
  it('reads the suffix as a number, so ENG-9 comes before ENG-81', () => {
    expect(['ENG-81', 'ENG-9', 'ENG-10'].sort(compareIssueKeys)).toEqual([
      'ENG-9',
      'ENG-10',
      'ENG-81',
    ]);
  });

  it('groups by project before it looks at the number at all', () => {
    expect(['PLAT-1', 'ENG-999'].sort(compareIssueKeys)).toEqual([
      'ENG-999',
      'PLAT-1',
    ]);
  });

  // A project key may legally contain a hyphen, so the split has to be on the
  // last one — splitting on the first would read "ENG-OPS-4" as project "ENG"
  // with the un-numeric suffix "OPS-4".
  it('splits on the last hyphen, not the first', () => {
    expect(['ENG-OPS-81', 'ENG-OPS-9'].sort(compareIssueKeys)).toEqual([
      'ENG-OPS-9',
      'ENG-OPS-81',
    ]);
  });

  // NaN from a comparator is worse than a wrong-but-consistent order: it
  // makes the sort's output depend on the input order and the engine's
  // partitioning, so the same set can render differently twice.
  it('never returns NaN for a suffix that is not a number', () => {
    const result = compareIssueKeys('ENG-X', 'ENG-2');

    expect(Number.isFinite(result)).toBe(true);
    expect(result).not.toBe(0);
    expect(Math.sign(compareIssueKeys('ENG-2', 'ENG-X'))).toBe(
      -Math.sign(result),
    );
  });

  // `Number('')` is 0, so without the explicit emptiness guard a suffix-less
  // key would compare EQUAL to issue zero — two visibly different keys that
  // the comparator calls the same thing, which is the one answer a sort can
  // never recover from.
  it('does not treat a missing suffix as issue zero', () => {
    expect(compareIssueKeys('ENG-', 'ENG-0')).not.toBe(0);
    expect(Number.isFinite(compareIssueKeys('ENG-', 'ENG-0'))).toBe(true);
  });
});

describe('compareTickets', () => {
  it('sorts urgent first and none last', () => {
    const shuffled = [
      ticket({ key: 'ENG-1', priority: 'low' }),
      ticket({ key: 'ENG-2', priority: 'urgent' }),
      ticket({ key: 'ENG-3', priority: 'none' }),
      ticket({ key: 'ENG-4', priority: 'medium' }),
      ticket({ key: 'ENG-5', priority: 'high' }),
    ];

    expect(
      shuffled
        .sort((a, b) => compareTickets(a, b, 'priority'))
        .map((t) => t.priority),
    ).toEqual(['urgent', 'high', 'medium', 'low', 'none']);
  });

  it('sorts the most recently updated first', () => {
    const shuffled = [
      ticket({ key: 'ENG-1', updatedAt: '2026-09-01T00:00:00.000Z' }),
      ticket({ key: 'ENG-2', updatedAt: '2026-09-03T00:00:00.000Z' }),
      ticket({ key: 'ENG-3', updatedAt: '2026-09-02T00:00:00.000Z' }),
    ];

    expect(
      shuffled
        .sort((a, b) => compareTickets(a, b, 'updated'))
        .map((t) => t.key),
    ).toEqual(['ENG-2', 'ENG-3', 'ENG-1']);
  });

  // Array.prototype.sort being stable is NOT enough here: stability preserves
  // the input order, and the input order is whatever Jira returned on this
  // particular refresh. Feeding the same two tickets in both orders is the
  // only way to tell a real tiebreak from stability doing the work.
  it('breaks ties on the issue key, not on the order it was handed', () => {
    const a = ticket({
      id: 'a',
      key: 'ENG-9',
      priority: 'high',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const b = ticket({
      id: 'b',
      key: 'ENG-2',
      priority: 'high',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });

    const forwards = [a, b].sort((x, y) => compareTickets(x, y, 'priority'));
    const backwards = [b, a].sort((x, y) => compareTickets(x, y, 'priority'));

    expect(forwards.map((t) => t.key)).toEqual(['ENG-2', 'ENG-9']);
    expect(backwards.map((t) => t.key)).toEqual(['ENG-2', 'ENG-9']);
  });

  it('falls through to the key when two issues were updated at the same time', () => {
    const same = '2026-09-01T00:00:00.000Z';
    const sorted = [
      ticket({ key: 'ENG-30', updatedAt: same }),
      ticket({ key: 'ENG-4', updatedAt: same }),
    ].sort((a, b) => compareTickets(a, b, 'updated'));

    expect(sorted.map((t) => t.key)).toEqual(['ENG-4', 'ENG-30']);
  });

  // The bug this sort exists to not repeat: a ticket whose payload omitted
  // `updated` (updatedAt: null) is unknown, not recent, and must not win a
  // "most recently updated" sort against a ticket Jira actually reports as
  // stale.
  it('sorts a null (unknown) updatedAt after every real timestamp, not before', () => {
    const shuffled = [
      ticket({ key: 'ENG-1', updatedAt: null }),
      ticket({ key: 'ENG-2', updatedAt: '2020-01-01T00:00:00.000Z' }),
      ticket({ key: 'ENG-3', updatedAt: '2026-09-01T00:00:00.000Z' }),
    ];

    expect(
      shuffled
        .sort((a, b) => compareTickets(a, b, 'updated'))
        .map((t) => t.key),
    ).toEqual(['ENG-3', 'ENG-2', 'ENG-1']);
  });

  it('breaks a null-vs-null tie on the issue key, not on input order', () => {
    const a = ticket({ id: 'a', key: 'ENG-9', updatedAt: null });
    const b = ticket({ id: 'b', key: 'ENG-2', updatedAt: null });

    const forwards = [a, b].sort((x, y) => compareTickets(x, y, 'updated'));
    const backwards = [b, a].sort((x, y) => compareTickets(x, y, 'updated'));

    expect(forwards.map((t) => t.key)).toEqual(['ENG-2', 'ENG-9']);
    expect(backwards.map((t) => t.key)).toEqual(['ENG-2', 'ENG-9']);
  });

  // A PRESENT but unparseable updatedAt (Date.parse -> NaN) is "unknown" in
  // exactly the same sense a genuinely missing one is, even though the type
  // is still a string. Before this, falling through to the key tiebreak on
  // NaN scattered it among real dates in a way that isn't just wrong, it
  // makes the comparator intransitive — a real Array.prototype.sort
  // correctness bug, not only a display quirk. This reproduces the exact
  // three-item cycle: by key ENG-1 < ENG-2 < ENG-3, but by date (treating
  // the malformed one as if it fell through) ENG-3's real date would beat
  // ENG-1's real date while ENG-2's malformed one sits arbitrarily between
  // them on the key tiebreak alone.
  it('treats an unparseable (but non-null) updatedAt the same as null: after every real timestamp', () => {
    const shuffled = [
      ticket({ key: 'ENG-1', updatedAt: '2020-01-01T00:00:00.000Z' }),
      ticket({ key: 'ENG-2', updatedAt: 'not-a-real-date' }),
      ticket({ key: 'ENG-3', updatedAt: '2026-09-01T00:00:00.000Z' }),
    ];

    expect(
      shuffled
        .sort((a, b) => compareTickets(a, b, 'updated'))
        .map((t) => t.key),
    ).toEqual(['ENG-3', 'ENG-1', 'ENG-2']);
  });
});

describe('matchesQuery', () => {
  it('finds an issue by its key, case-insensitively', () => {
    expect(
      matchesQuery(ticket({ key: 'ENG-421' }), query({ text: 'eng-4' })),
    ).toBe(true);
  });

  it('finds an issue by its title', () => {
    expect(
      matchesQuery(
        ticket({ title: 'Webhook receiver drops events' }),
        query({ text: 'RECEIVER' }),
      ),
    ).toBe(true);
  });

  // A stray space must not narrow anything — see hasActiveQuery, which has to
  // agree with this or the empty state contradicts the list.
  it('treats whitespace-only search text as no search at all', () => {
    expect(matchesQuery(ticket(), query({ text: '   ' }))).toBe(true);
  });

  it('matches every status when no status is selected', () => {
    expect(
      matchesQuery(
        ticket({ stateName: 'Anything' }),
        query({ stateNames: [] }),
      ),
    ).toBe(true);
  });

  it('matches only the selected statuses when some are', () => {
    const selected = query({ stateNames: ['In Progress'] });

    expect(matchesQuery(ticket({ stateName: 'In Progress' }), selected)).toBe(
      true,
    );
    expect(matchesQuery(ticket({ stateName: 'To Do' }), selected)).toBe(false);
  });

  // AND, not OR. A project chip plus a role chip means "ENG issues I watch",
  // and the same has to hold once search joins them.
  it('combines project, role and text as an AND', () => {
    const narrow = query({
      projectKey: 'ENG',
      role: 'watcher',
      text: 'flake',
    });

    expect(
      matchesQuery(
        ticket({ projectKey: 'ENG', role: 'watcher', title: 'A flake' }),
        narrow,
      ),
    ).toBe(true);
    expect(
      matchesQuery(
        ticket({ projectKey: 'PLAT', role: 'watcher', title: 'A flake' }),
        narrow,
      ),
    ).toBe(false);
    expect(
      matchesQuery(
        ticket({ projectKey: 'ENG', role: 'assignee', title: 'A flake' }),
        narrow,
      ),
    ).toBe(false);
    expect(
      matchesQuery(
        ticket({ projectKey: 'ENG', role: 'watcher', title: 'Something else' }),
        narrow,
      ),
    ).toBe(false);
  });
});

describe('hasActiveQuery', () => {
  it('is false for the default query', () => {
    expect(hasActiveQuery(DEFAULT_QUERY)).toBe(false);
  });

  // The whole point: this is what decides between "Nothing in your Jira
  // queue." and "No tickets match these filters.", and a stray space must not
  // turn a true statement into a false one.
  it('is false for whitespace-only search text', () => {
    expect(hasActiveQuery(query({ text: '   ' }))).toBe(false);
  });

  // Being on page 3 is a consequence of a query, not part of one — and
  // "Clear filters" appearing because you paged would be nonsense.
  it('is false for a page change alone', () => {
    expect(hasActiveQuery(query({ page: 3 }))).toBe(false);
  });

  it.each([
    ['project', query({ projectKey: 'ENG' })],
    ['role', query({ role: 'watcher' })],
    ['status', query({ stateNames: ['To Do'] })],
    ['text', query({ text: 'flake' })],
    // A sort cannot be why nothing matched, but Clear is the one control that
    // restores a known-good view, and a Clear that left a surprising order
    // behind is a Clear that didn't clear.
    ['sort', query({ sort: 'priority' })],
  ])('is true when %s is set', (_label, q) => {
    expect(hasActiveQuery(q)).toBe(true);
  });
});

describe('pageWindow', () => {
  it('is just the one page when there is one page', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
  });

  it('shows every page when they all fit', () => {
    expect(pageWindow(2, 3)).toEqual([1, 2, 3]);
  });

  it('keeps first, last and the current neighbourhood', () => {
    expect(pageWindow(5, 20)).toEqual([1, 'gap', 4, 5, 6, 'gap', 20]);
  });

  it('has a single gap at each end of the run', () => {
    expect(pageWindow(1, 20).filter((e) => e === 'gap')).toHaveLength(1);
    expect(pageWindow(20, 20).filter((e) => e === 'gap')).toHaveLength(1);
  });

  // A gap hiding exactly one number costs the same space as the number, tells
  // the reader less, and takes an extra click to reach.
  it('never hides a single page behind a gap', () => {
    expect(pageWindow(4, 6)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
