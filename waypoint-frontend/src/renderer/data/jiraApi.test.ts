import type { JiraTruncation, JiraWireTicket } from '../../main/jira/jiraTypes';
import type { JiraComment } from '@/types/jira';

// Each test gets its OWN fresh copy of this module via freshApi(). jiraApi.ts
// keeps a small module-level session cache (the last ticket list, the
// transitions that came with it, the last sync time), and that cache is
// exactly what several of these tests are about — so they must not inherit
// each other's. jest.resetModules() + a fresh require() is the same approach
// this file used when the cache was fixtures, for the same reason.
type JiraApiModule = typeof import('./jiraApi');

const bridge = {
  status: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  listTickets: jest.fn(),
  listTransitions: jest.fn(),
  transition: jest.fn(),
  listPriorityOptions: jest.fn(),
  setPriority: jest.fn(),
  searchAssignableUsers: jest.fn(),
  setAssignee: jest.fn(),
  listComments: jest.fn(),
  postComment: jest.fn(),
  updateComment: jest.fn(),
  deleteComment: jest.fn(),
  getCommentPermissions: jest.fn(),
};

function freshApi(): JiraApiModule {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./jiraApi');
}

function wireTicket(overrides: Partial<JiraWireTicket> = {}): JiraWireTicket {
  return {
    id: '10421',
    key: 'ENG-421',
    projectKey: 'ENG',
    title: 'Webhook receiver drops events past 500/min',
    role: 'assignee',
    stateName: 'In Progress',
    stateCategory: 'in-progress',
    priority: 'urgent',
    priorityId: '1',
    priorityName: 'Highest',
    assigneeName: 'Max Chen',
    assigneeAccountId: '5f8a',
    reporterName: 'Sam Lee',
    description: 'Details.',
    epicName: null,
    storyPoints: null,
    sprintName: null,
    labels: [],
    dueDate: null,
    subtasks: [],
    links: [],
    descriptionAdf: null,
    attachments: [],
    transitions: [],
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

/** The shape main now answers `jira:tickets:list` with — the tickets plus
 * whether the page cap cut the crawl short. Wrapped in a helper because every
 * one of these call sites cares about the array and none of them cares about
 * the flag; spelling `{ tickets, truncated: false }` out a dozen times would
 * bury the one test where the flag is the point. */
function ticketsResult(
  tickets: JiraWireTicket[],
  truncated: JiraTruncation = false,
) {
  return { ok: true as const, value: { tickets, truncated } };
}

const CONNECTED = {
  connected: true,
  identity: {
    site: 'waypoint123.atlassian.net',
    accountId: '5f8a',
    email: 'max@northwind.dev',
    displayName: 'Max Chen',
    avatarUrl: null,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  (window as unknown as { electron: unknown }).electron = { jira: bridge };
  bridge.status.mockResolvedValue(CONNECTED);
  bridge.listTickets.mockResolvedValue(ticketsResult([]));
});

describe('failure handling', () => {
  // Main answers with a discriminated union; every component above this layer
  // is written around try/catch and showErrorToast, so the conversion happens
  // once, here.
  it("throws with Jira's own message rather than a generic one", async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue({
      ok: false,
      reason: 'jira_error',
      message: 'Resolution is required.',
    });

    await expect(api.listMyJiraTickets()).rejects.toThrow(
      'Resolution is required.',
    );
  });

  // The kind rides along on the error, not just the sentence: the UI has to
  // tell "your token died — reconnect" from "you're offline — try again", and
  // dropping `reason` here is what made those indistinguishable.
  it("carries main's failure reason on the thrown error", async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue({
      ok: false,
      reason: 'invalid_credentials',
      message: 'Jira rejected that email and API token.',
    });

    await expect(api.listMyJiraTickets()).rejects.toMatchObject({
      name: 'JiraApiError',
      reason: 'invalid_credentials',
      message: 'Jira rejected that email and API token.',
    });
  });

  it('explains itself when there is no Electron bridge at all', async () => {
    const api = freshApi();
    (window as unknown as { electron?: unknown }).electron = undefined;

    await expect(api.listMyJiraTickets()).rejects.toThrow(
      /Jira connection is unavailable/,
    );
  });
});

describe('listMyJiraTickets', () => {
  it("colors a ticket from Jira's status category, the only portable grouping", async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([
        wireTicket({ id: '1', stateCategory: 'todo' }),
        wireTicket({ id: '2', stateCategory: 'in-progress' }),
        wireTicket({ id: '3', stateCategory: 'done' }),
      ]),
    );

    const { tickets } = await api.listMyJiraTickets();

    expect(tickets.map((t) => t.stateColor)).toEqual([
      'var(--text-muted)',
      'var(--warning)',
      'var(--success)',
    ]);
  });

  // Tombstones and conflicts both describe drift between a previous read
  // and the current one. The very first time this module ever sees a ticket
  // id there is nothing to compare against, so "new to the queue" must never
  // read as "changed under you" — and tombstoning stays unconditionally
  // false regardless (see toTicket's own note on why absence from a JQL read
  // can never honestly be called a reassignment).
  it('never marks a ticket as tombstoned, and never conflicted on its first read', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(ticketsResult([wireTicket()]));

    expect(await api.listMyJiraTickets()).toMatchObject({
      tickets: [
        expect.objectContaining({
          isTombstoned: false,
          tombstone: null,
          hasConflict: false,
          conflict: null,
        }),
      ],
    });
  });

  // The whole point of the pair. A capped read and a complete one are the
  // same array; if this flag were dropped anywhere between the client and
  // here, the UI would go back to rendering "here is everything" over a
  // prefix and nothing would fail.
  // The REASON travels, not just the fact — the two cases print different
  // sentences, and the cap's names a 500-issue limit that the other case must
  // never claim.
  it.each([['page-cap'], ['no-cursor']] as const)(
    "carries main's %s truncation through untouched",
    async (reason) => {
      const api = freshApi();
      bridge.listTickets.mockResolvedValue(
        ticketsResult([wireTicket()], reason),
      );

      expect(await api.listMyJiraTickets()).toMatchObject({
        truncated: reason,
      });
    },
  );

  // The counts on the Connection tab, the sidebar badge and the wizard are
  // all derived from the same cached list, so they inherit its cap. Reporting
  // a capped 500 as a flat "500 issues in your queue" is a specific wrong
  // number in the one panel whose job is to say what Waypoint can see.
  // Both reasons, deliberately. Whether the counts are floors is a genuine
  // yes/no question — unlike the banner copy, which has to name a cause — so
  // this pins the Boolean() coercion against BOTH string values. A regression
  // that special-cased 'page-cap' would otherwise slip through silently,
  // since the string values are all main can now produce.
  it.each([['page-cap'], ['no-cursor']] as const)(
    'marks the derived counts as floors when the read was %s truncated',
    async (reason) => {
      const api = freshApi();
      bridge.listTickets.mockResolvedValue(
        ticketsResult([wireTicket()], reason),
      );
      await api.listMyJiraTickets();

      expect(await api.getJiraConnectionStatus()).toMatchObject({
        issueCount: 1,
        countsTruncated: true,
      });
    },
  );

  it('reports complete counts as complete', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(ticketsResult([wireTicket()], false));
    await api.listMyJiraTickets();

    expect(await api.getJiraConnectionStatus()).toMatchObject({
      countsTruncated: false,
    });
  });

  // updatedAt crossed the wire from the first read and then went no further:
  // toTicket simply didn't copy it, which is why the list could only render
  // in whatever order the search happened to return. It is a sort key now, so
  // it has to survive the mapping verbatim — not reformatted, not defaulted.
  it("keeps the issue's last-updated time verbatim", async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-03-04T05:06:07.008Z' })]),
    );

    const { tickets } = await api.listMyJiraTickets();

    expect(tickets[0].updatedAt).toBe('2026-03-04T05:06:07.008Z');
  });
});

describe('conflict detection', () => {
  // The core positive case: a real re-read reports a later `updated` than
  // the one this module cached from the previous read, with nothing of
  // Waypoint's own in between. That is exactly "someone else moved it while
  // you were looking" — the case the whole feature exists for.
  it('flags a genuine third-party edit between two reads', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:00:00.000Z' })]),
    );
    await api.listMyJiraTickets();

    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:05:00.000Z' })]),
    );
    const { tickets } = await api.listMyJiraTickets();

    expect(tickets[0]).toMatchObject({
      hasConflict: true,
      conflict: { changedAt: '2026-09-01T10:05:00.000Z' },
    });
    // The identity is genuinely unknown — Jira's issue payload carries no
    // changelog author, only the timestamp — so this must not read as a
    // real name. `changedBy` still has to be a non-empty string (the type
    // requires it), but it must not be fabricated to look authoritative.
    expect(tickets[0].conflict?.changedBy).toBeTruthy();
    expect(tickets[0].conflict?.changedBy).not.toMatch(/@|\d/);
  });

  // Our OWN comment moves the issue's `updated` in Jira. The four
  // ticket-returning writes re-baseline from the ticket they get back;
  // posting a comment gets a comment back, so without dropping the stale
  // cached timestamp the very next refresh would tell the user "Someone
  // changed this" about their own comment — and disable every other write
  // until they reloaded. This is the regression guard for that.
  it("does not flag the user's own comment as a third-party edit", async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:00:00.000Z' })]),
    );
    await api.listMyJiraTickets();

    bridge.postComment.mockResolvedValue({
      ok: true,
      value: {
        id: 'c1',
        ticketId: '10421',
        authorName: 'Amaan Nawab',
        body: 'a comment',
        createdAt: '2026-09-01T10:05:00.000Z',
        postedByWaypoint: true,
        disclosureText: null,
      },
    });
    await api.postJiraComment('10421', 'a comment');

    // Jira now reports a later `updated` — moved by our own comment.
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:05:00.000Z' })]),
    );
    const { tickets } = await api.listMyJiraTickets();

    expect(tickets[0]).toMatchObject({ hasConflict: false, conflict: null });
  });

  // Re-reading with nothing having actually changed must not flag — the
  // ordinary "Refresh now" / background sync case, run far more often than
  // any real conflict.
  it('does not flag when a re-read reports the same updated time', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:00:00.000Z' })]),
    );
    await api.listMyJiraTickets();

    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:00:00.000Z' })]),
    );
    const { tickets } = await api.listMyJiraTickets();

    expect(tickets[0]).toMatchObject({ hasConflict: false, conflict: null });
  });

  // Either side's updatedAt can legitimately be null (Jira omitted `updated`
  // — see JiraTicket.updatedAt's own comment on why this module refuses to
  // fabricate a timestamp). Unknown must resolve to "no conflict", not to
  // "unchanged" and not to "conflicted": there is no honest basis for either
  // claim, and a strip that fires on missing data is the false positive that
  // gets a safety feature switched off.
  it.each([
    ['2026-09-01T10:00:00.000Z', null],
    [null, '2026-09-01T10:05:00.000Z'],
    [null, null],
  ])(
    'does not flag when either side of the comparison is unknown (%s -> %s)',
    async (firstUpdatedAt, secondUpdatedAt) => {
      const api = freshApi();
      bridge.listTickets.mockResolvedValue(
        ticketsResult([wireTicket({ updatedAt: firstUpdatedAt })]),
      );
      await api.listMyJiraTickets();

      bridge.listTickets.mockResolvedValue(
        ticketsResult([wireTicket({ updatedAt: secondUpdatedAt })]),
      );
      const { tickets } = await api.listMyJiraTickets();

      expect(tickets[0]).toMatchObject({ hasConflict: false, conflict: null });
    },
  );

  // The false-positive case the whole design is built around: Waypoint's
  // own transition just moved `updated` on the real issue, and the very
  // next re-read must not mistake that for a rival edit. transitionJiraTicket
  // patches the cache with the write's own response directly (toTicket
  // called with no `previous`), so that response becomes the new baseline
  // rather than a value compared against the stale one.
  it('does not flag Waypoint’s own write on the next re-read', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([
        wireTicket({
          updatedAt: '2026-09-01T10:00:00.000Z',
          transitions: [
            {
              id: '21',
              targetStateName: 'In Review',
              targetStateCategory: 'in-progress',
              requiresFields: [],
            },
          ],
        }),
      ]),
    );
    await api.listMyJiraTickets();

    // The transition itself moves Jira's `updated` — a later time than what
    // was just cached — exactly as a real write does.
    bridge.transition.mockResolvedValue({
      ok: true,
      value: wireTicket({ updatedAt: '2026-09-01T10:00:05.000Z' }),
    });
    const written = await api.transitionJiraTicket('10421', '21', {});
    expect(written).toMatchObject({ hasConflict: false, conflict: null });

    // A background sync right after sees the same time the write already
    // landed — no drift since Waypoint's own change was cached.
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:00:05.000Z' })]),
    );
    const { tickets } = await api.listMyJiraTickets();

    expect(tickets[0]).toMatchObject({ hasConflict: false, conflict: null });
  });

  // Same false-positive shape, for setJiraTicketPriority and
  // setJiraTicketAssignee — every write in this file follows the identical
  // "patch the cache with the write's own response" pattern.
  it('does not flag Waypoint’s own priority or assignee write', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:00:00.000Z' })]),
    );
    await api.listMyJiraTickets();

    bridge.setPriority.mockResolvedValue({
      ok: true,
      value: wireTicket({
        updatedAt: '2026-09-01T10:00:05.000Z',
        priorityId: '3',
      }),
    });
    const afterPriority = await api.setJiraTicketPriority('10421', '3');
    expect(afterPriority).toMatchObject({ hasConflict: false });

    bridge.setAssignee.mockResolvedValue({
      ok: true,
      value: wireTicket({
        updatedAt: '2026-09-01T10:00:10.000Z',
        assigneeAccountId: 'acct-sam',
      }),
    });
    const afterAssignee = await api.setJiraTicketAssignee('10421', 'acct-sam');
    expect(afterAssignee).toMatchObject({ hasConflict: false });
  });

  // resolveJiraConflict's whole job: a real re-read after the user clicks
  // "Reload" recomputes against the just-flagged read as its new baseline,
  // so a conflict that isn't still actively racing clears rather than
  // sticking forever.
  it('resolveJiraConflict clears a flagged conflict once the re-read settles', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:00:00.000Z' })]),
    );
    await api.listMyJiraTickets();

    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:05:00.000Z' })]),
    );
    const { tickets: flagged } = await api.listMyJiraTickets();
    expect(flagged[0].hasConflict).toBe(true);

    // Nothing further changed in Jira between the flagged read and the
    // user's click.
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:05:00.000Z' })]),
    );
    const resolved = await api.resolveJiraConflict('10421');

    expect(resolved).toMatchObject({ hasConflict: false, conflict: null });
  });
});

describe('getJiraTransitions', () => {
  const BULK_TRANSITION = {
    id: '21',
    targetStateName: 'In Review',
    targetStateCategory: 'in-progress' as const,
    requiresFields: [],
  };

  it('uses the transitions the bulk search already returned, with no extra call', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ transitions: [BULK_TRANSITION] })]),
    );
    await api.listMyJiraTickets();

    const transitions = await api.getJiraTransitions('10421');

    expect(bridge.listTransitions).not.toHaveBeenCalled();
    expect(transitions).toEqual([
      {
        id: '21',
        targetStateName: 'In Review',
        targetStateColor: 'var(--warning)',
        requiresFields: [],
      },
    ]);
  });

  // The important one. An empty transitions array from the bulk search is
  // ambiguous — "no legal moves" and "the expand didn't populate" look
  // identical — and believing it would show a user an empty menu on a ticket
  // their Jira plainly lets them move.
  it('does not believe an empty bulk result, and asks per-issue instead', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ transitions: [] })]),
    );
    bridge.listTransitions.mockResolvedValue({
      ok: true,
      value: [BULK_TRANSITION],
    });
    await api.listMyJiraTickets();

    const transitions = await api.getJiraTransitions('10421');

    expect(bridge.listTransitions).toHaveBeenCalledWith('10421');
    expect(transitions).toHaveLength(1);
  });

  it('asks per-issue for a ticket the last list never mentioned', async () => {
    const api = freshApi();
    bridge.listTransitions.mockResolvedValue({ ok: true, value: [] });

    expect(await api.getJiraTransitions('99999')).toEqual([]);
    expect(bridge.listTransitions).toHaveBeenCalledWith('99999');
  });
});

describe('transitionJiraTicket', () => {
  it('returns the re-read ticket and forgets the now-stale transition list', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([
        wireTicket({
          transitions: [
            {
              id: '21',
              targetStateName: 'In Review',
              targetStateCategory: 'in-progress',
              requiresFields: [],
            },
          ],
        }),
      ]),
    );
    await api.listMyJiraTickets();
    bridge.transition.mockResolvedValue({
      ok: true,
      value: wireTicket({ stateName: 'Done', stateCategory: 'done' }),
    });
    bridge.listTransitions.mockResolvedValue({ ok: true, value: [] });

    const updated = await api.transitionJiraTicket('10421', '21', {
      resolution: 'Fixed',
    });

    expect(bridge.transition).toHaveBeenCalledWith({
      ticketId: '10421',
      transitionId: '21',
      fieldValues: { resolution: 'Fixed' },
    });
    expect(updated).toMatchObject({
      stateName: 'Done',
      stateColor: 'var(--success)',
    });

    // The move changes which transitions are legal from here, so the cached
    // set for this ticket must not be reused.
    await api.getJiraTransitions('10421');
    expect(bridge.listTransitions).toHaveBeenCalledWith('10421');
  });
});

describe('priority', () => {
  // Unlike transitions, these are never cached: nothing about a priority
  // scheme rides along with the ticket list, and a cache would hold a list an
  // admin can change underneath it in exchange for saving one request.
  it('asks Jira every time the menu opens', async () => {
    const api = freshApi();
    bridge.listPriorityOptions.mockResolvedValue({
      ok: true,
      value: [{ id: '3', name: 'Medium' }],
    });

    expect(await api.getJiraPriorityOptions('10421')).toEqual([
      { id: '3', name: 'Medium' },
    ]);
    await api.getJiraPriorityOptions('10421');

    expect(bridge.listPriorityOptions).toHaveBeenCalledTimes(2);
    expect(bridge.listPriorityOptions).toHaveBeenCalledWith('10421');
  });

  // A priority change cannot move a ticket out of the "my work" JQL, so the
  // row is patched in place and never dropped — the `.map()`, not a filter.
  it('patches the cached row rather than removing it', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ id: '10421' }), wireTicket({ id: '10999' })]),
    );
    await api.listMyJiraTickets();
    bridge.setPriority.mockResolvedValue({
      ok: true,
      value: wireTicket({
        id: '10421',
        priorityId: '3',
        priorityName: 'Medium',
      }),
    });

    const updated = await api.setJiraTicketPriority('10421', '3');

    expect(bridge.setPriority).toHaveBeenCalledWith({
      ticketId: '10421',
      priorityId: '3',
    });
    expect(updated).toMatchObject({ priorityId: '3', priorityName: 'Medium' });
    // Both rows still counted: the write patched one, it did not evict it.
    expect(await api.getJiraConnectionStatus()).toMatchObject({
      issueCount: 2,
    });
  });
});

describe('assignee', () => {
  it('searches by the ticket KEY — the one call that does', async () => {
    const api = freshApi();
    bridge.searchAssignableUsers.mockResolvedValue({
      ok: true,
      value: [
        { accountId: 'acct-sam', displayName: 'Sam Lee', avatarUrl: null },
      ],
    });

    expect(await api.searchJiraAssignableUsers('ENG-421', 'sam')).toEqual([
      { accountId: 'acct-sam', displayName: 'Sam Lee', avatarUrl: null },
    ]);
    expect(bridge.searchAssignableUsers).toHaveBeenCalledWith({
      ticketKey: 'ENG-421',
      query: 'sam',
    });
  });

  /**
   * The founder's decision, held by a test rather than by a comment.
   *
   * Reassigning away from yourself genuinely drops the issue out of the "my
   * work" JQL — that query matches assignee OR reporter OR watcher, and this
   * ticket is none of the three to you any more (its `role` comes back as
   * 'none' to say so). The row still must not disappear from under the
   * cursor: it stays until the next refresh re-runs the query.
   *
   * No special case produces that. `.map()` does — the cached row is patched
   * with what Jira returned instead of being filtered out — which is why this
   * test asserts the count is unchanged rather than asserting the absence of
   * some "keep it visible" flag.
   */
  it('patches a ticket reassigned away from you rather than dropping it', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ id: '10421' }), wireTicket({ id: '10999' })]),
    );
    await api.listMyJiraTickets();
    bridge.setAssignee.mockResolvedValue({
      ok: true,
      value: wireTicket({
        id: '10421',
        // No longer yours by any of the three roles the queue matches on.
        role: 'none',
        assigneeName: 'Sam Lee',
        assigneeAccountId: 'acct-sam',
      }),
    });

    const updated = await api.setJiraTicketAssignee('10421', 'acct-sam');

    expect(bridge.setAssignee).toHaveBeenCalledWith({
      ticketId: '10421',
      accountId: 'acct-sam',
    });
    expect(updated).toMatchObject({
      assigneeName: 'Sam Lee',
      assigneeAccountId: 'acct-sam',
      role: 'none',
    });
    // Both rows still counted: the write patched one in place, it did not
    // evict it. This is the whole "stays visible until the next refresh".
    expect(await api.getJiraConnectionStatus()).toMatchObject({
      issueCount: 2,
    });
  });

  // Unassign is a value the user chose, not an argument that went missing, and
  // it has to survive as a literal null across the bridge — jiraIpc.ts checks
  // for exactly this before any string coercion.
  it('sends a literal null for unassign, and keeps the row', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ id: '10421' })]),
    );
    await api.listMyJiraTickets();
    bridge.setAssignee.mockResolvedValue({
      ok: true,
      value: wireTicket({
        id: '10421',
        assigneeName: 'Unassigned',
        assigneeAccountId: null,
      }),
    });

    await api.setJiraTicketAssignee('10421', null);

    expect(bridge.setAssignee).toHaveBeenCalledWith({
      ticketId: '10421',
      accountId: null,
    });
    expect(bridge.setAssignee.mock.calls[0][0].accountId).toBeNull();
    expect(await api.getJiraConnectionStatus()).toMatchObject({
      issueCount: 1,
    });
  });

  // A rejected write must leave the cache exactly as it was — the list is not
  // patched with a state Jira never reached.
  it('leaves the cached row untouched when Jira rejects the write', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ id: '10421', assigneeName: 'Max Chen' })]),
    );
    await api.listMyJiraTickets();
    bridge.setAssignee.mockResolvedValue({
      ok: false,
      reason: 'forbidden',
      message: "Your Jira account isn't allowed to do that.",
    });

    await expect(
      api.setJiraTicketAssignee('10421', 'acct-sam'),
    ).rejects.toThrow("Your Jira account isn't allowed to do that.");
    expect(await api.getJiraConnectionStatus()).toMatchObject({
      issueCount: 1,
    });
  });
});

describe('connect / status / disconnect', () => {
  it('lists immediately after connecting so the counts shown are this account’s real ones', async () => {
    const api = freshApi();
    bridge.connect.mockResolvedValue({ ok: true, value: CONNECTED.identity });
    bridge.listTickets.mockResolvedValue(
      ticketsResult([
        wireTicket({ id: '1', projectKey: 'ENG' }),
        wireTicket({ id: '2', projectKey: 'ENG' }),
        wireTicket({ id: '3', projectKey: 'OPS' }),
      ]),
    );

    const status = await api.connectJira({
      site: 'waypoint123.atlassian.net',
      email: 'max@northwind.dev',
      apiToken: 'ATATT3xFfGF0-not-a-real-token',
    });

    expect(bridge.listTickets).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({
      connected: true,
      accountName: 'Max Chen',
      accountEmail: 'max@northwind.dev',
      site: 'waypoint123.atlassian.net',
      issueCount: 3,
      projectCount: 2,
    });
  });

  it('surfaces a rejected credential without listing anything', async () => {
    const api = freshApi();
    bridge.connect.mockResolvedValue({
      ok: false,
      reason: 'invalid_credentials',
      message: 'Jira rejected that email and API token.',
    });

    await expect(
      api.connectJira({ site: 's', email: 'e', apiToken: 't' }),
    ).rejects.toThrow('Jira rejected that email and API token.');
    expect(bridge.listTickets).not.toHaveBeenCalled();
  });

  // Status is a local read of the credential store — the sidebar and the page
  // both ask on every mount, so it must not put a Jira request in front of
  // rendering a nav item.
  it('reads status without touching the network', async () => {
    const api = freshApi();

    await api.getJiraConnectionStatus();

    expect(bridge.status).toHaveBeenCalledTimes(1);
    expect(bridge.listTickets).not.toHaveBeenCalled();
  });

  it('drops the cached counts on disconnect', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(ticketsResult([wireTicket()]));
    await api.listMyJiraTickets();
    expect((await api.getJiraConnectionStatus()).issueCount).toBe(1);

    await api.disconnectJira();

    expect(bridge.disconnect).toHaveBeenCalledTimes(1);
    expect((await api.getJiraConnectionStatus()).issueCount).toBe(0);
  });

  // lastSyncAt is what the page's "synced Ns ago" indicator reports, so it
  // has to move only when the list is genuinely re-read — and must not exist
  // at all before one has.
  it('reports no sync time until a read has actually succeeded', async () => {
    const api = freshApi();

    expect((await api.getJiraConnectionStatus()).lastSyncAt).toBeNull();
  });

  it('leaves lastSyncAt unset when the list read fails', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue({
      ok: false,
      reason: 'network',
      message: "Couldn't reach Jira. Check your connection and try again.",
    });

    await expect(api.listMyJiraTickets()).rejects.toThrow(/reach Jira/);

    expect((await api.getJiraConnectionStatus()).lastSyncAt).toBeNull();
  });

  it('refreshJiraSync genuinely re-reads and advances lastSyncAt', async () => {
    jest.useFakeTimers();
    try {
      const api = freshApi();
      await api.listMyJiraTickets();
      const before = (await api.getJiraConnectionStatus()).lastSyncAt;
      expect(before).not.toBeNull();
      jest.advanceTimersByTime(60_000);

      const refreshed = await api.refreshJiraSync();

      expect(bridge.listTickets).toHaveBeenCalledTimes(2);
      expect(new Date(refreshed.lastSyncAt ?? 0).getTime()).toBeGreaterThan(
        new Date(before ?? 0).getTime(),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

// Found in review: a connected account with real tickets showed "0 issues"
// / "not synced yet" on the All Projects page's Jira tile indefinitely,
// because that tile only ever called the fast, count-blind
// getJiraConnectionStatus() — nothing about landing on All Projects first
// (rather than My Jira) ever triggered a real read. These pin
// ensureJiraSynced, the fix jiraStore.ts's useLoadedJiraConnection now
// routes through.
describe('ensureJiraSynced', () => {
  it('lists when connected but nothing has synced yet, and the result carries real counts', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([
        wireTicket({ id: '1', projectKey: 'ENG' }),
        wireTicket({ id: '2', projectKey: 'OPS' }),
      ]),
    );

    const result = await api.ensureJiraSynced();

    expect(bridge.listTickets).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ issueCount: 2, projectCount: 2 });
    expect(result.lastSyncAt).not.toBeNull();
  });

  it('does not list again once a real sync has already happened this session', async () => {
    const api = freshApi();
    await api.listMyJiraTickets();
    bridge.listTickets.mockClear();

    await api.ensureJiraSynced();

    expect(bridge.listTickets).not.toHaveBeenCalled();
  });

  it('does not attempt a list at all when nothing is connected', async () => {
    const api = freshApi();
    bridge.status.mockResolvedValue({ connected: false, identity: undefined });

    const result = await api.ensureJiraSynced();

    expect(bridge.listTickets).not.toHaveBeenCalled();
    expect(result.connected).toBe(false);
  });

  // The actual bug this closes: several surfaces (Sidebar,
  // JiraConnectionCard, MyJiraPage) can all mount within the same tick,
  // each independently calling this — without single-flight dedup, a
  // connected session would fire one real Jira search per surface instead
  // of one for the whole app.
  it('deduplicates concurrent callers into a single real list read', async () => {
    const api = freshApi();

    const [first, second, third] = await Promise.all([
      api.ensureJiraSynced(),
      api.ensureJiraSynced(),
      api.ensureJiraSynced(),
    ]);

    expect(bridge.listTickets).toHaveBeenCalledTimes(1);
    expect(first.lastSyncAt).toBe(second.lastSyncAt);
    expect(second.lastSyncAt).toBe(third.lastSyncAt);
  });

  it('still resolves with a usable status, not a rejection, when the list read fails — but logs it', async () => {
    const api = freshApi();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.listTickets.mockResolvedValue({
      ok: false,
      reason: 'network',
      message: "Couldn't reach Jira. Check your connection and try again.",
    });

    const result = await api.ensureJiraSynced();

    expect(result.connected).toBe(true);
    expect(result.lastSyncAt).toBeNull();
    // Found in review: the original version discarded the error entirely —
    // a genuine connectivity failure and "just hasn't synced yet" were then
    // indistinguishable from the outside, with no trace anywhere that a
    // real read was even attempted and failed.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  // Found in review: an earlier version of ensureJiraSynced had its OWN
  // single-flight guard, separate from listMyJiraTickets() — which
  // deduplicated concurrent calls to ensureJiraSynced against each other,
  // but NOT against a concurrent DIRECT call to listMyJiraTickets(), which
  // is exactly what MyJiraPage's own foreground "My work" read is. Landing
  // on My Jira with Jira connected and nothing synced yet could fire two
  // real searches: MyJiraPage's own read, and the sidebar's
  // useLoadedJiraConnection concurrently calling ensureJiraSynced. Moving
  // the dedup into listMyJiraTickets() itself (shared by both call paths)
  // closes this specific gap.
  it('deduplicates a concurrent direct listMyJiraTickets() call against an in-flight ensureJiraSynced, not just against another ensureJiraSynced', async () => {
    const api = freshApi();

    const [fromEnsureSynced, fromDirectCall] = await Promise.all([
      api.ensureJiraSynced(),
      api.listMyJiraTickets(),
    ]);

    expect(bridge.listTickets).toHaveBeenCalledTimes(1);
    expect(fromEnsureSynced.lastSyncAt).not.toBeNull();
    expect(fromDirectCall.tickets).toEqual([]);
  });
});

describe('comments', () => {
  it('maps a posted comment, and never claims Jira knows it came from Waypoint', async () => {
    const api = freshApi();
    bridge.postComment.mockResolvedValue({
      ok: true,
      value: {
        id: '10502',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: 'Taking it.',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    });

    const comment = await api.postJiraComment('10421', 'Taking it.');

    expect(bridge.postComment).toHaveBeenCalledWith({
      ticketId: '10421',
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Taking it.' }],
          },
        ],
      },
    });
    // Jira has no property to carry provenance and this app keeps no record
    // of what it posted, so a comment read back is just a comment.
    expect(comment).toMatchObject({
      body: 'Taking it.',
      postedByWaypoint: false,
      disclosureText: null,
    });
  });

  it('builds a real mention node for a selected mention span', async () => {
    const api = freshApi();
    bridge.postComment.mockResolvedValue({
      ok: true,
      value: {
        id: '10503',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: 'hi @Sam Lee can you take this?',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    });

    await api.postJiraComment('10421', 'hi @Sam Lee can you take this?', [
      { start: 3, end: 11, accountId: 'acct-sam', displayName: 'Sam Lee' },
    ]);

    expect(bridge.postComment).toHaveBeenCalledWith({
      ticketId: '10421',
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'hi ' },
              {
                type: 'mention',
                attrs: { id: 'acct-sam', text: '@Sam Lee' },
              },
              { type: 'text', text: ' can you take this?' },
            ],
          },
        ],
      },
    });
  });

  it('drops a mention span the text no longer matches, and sends the real text as plain text instead', async () => {
    const api = freshApi();
    bridge.postComment.mockResolvedValue({
      ok: true,
      value: {
        id: '10504',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: 'hi @Sam can you take this?',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    });

    // The span still claims [3, 11) is "@Sam Lee", but the user deleted
    // " Lee" after selecting it from the picker — the text at that range no
    // longer reads "@Sam Lee", so this must not turn into a mention node.
    await api.postJiraComment('10421', 'hi @Sam can you take this?', [
      { start: 3, end: 11, accountId: 'acct-sam', displayName: 'Sam Lee' },
    ]);

    expect(bridge.postComment).toHaveBeenCalledWith({
      ticketId: '10421',
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'hi @Sam can you take this?' }],
          },
        ],
      },
    });
  });

  it('splits a multi-line draft into one paragraph per line', async () => {
    const api = freshApi();
    bridge.postComment.mockResolvedValue({
      ok: true,
      value: {
        id: '10505',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: 'line one\nline two',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    });

    await api.postJiraComment('10421', 'line one\nline two');

    expect(bridge.postComment).toHaveBeenCalledWith({
      ticketId: '10421',
      body: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'line one' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'line two' }] },
        ],
      },
    });
  });
});

// A reply's own request, and what jiraApi.ts is honest about once Jira
// answers it. Jira genuinely threads comments (verified live against ENG-84
// — see JiraWireComment.parentId's own comment), but the public write
// endpoint accepting `parentId` at all was never confirmed, so the whole
// safety property of this feature is that the returned comment's own
// `parentId` comes from Jira's RESPONSE, never from what was asked for.
describe('postJiraComment — replying', () => {
  it('includes parentId in the bridge call when replying', async () => {
    const api = freshApi();
    bridge.postComment.mockResolvedValue({
      ok: true,
      value: {
        id: 'c2',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: '@Sam Lee on it',
        createdAt: '2026-09-01T10:00:00.000Z',
        parentId: '10158',
      },
    });

    await api.postJiraComment('10421', '@Sam Lee on it', [], '10158');

    expect(bridge.postComment).toHaveBeenCalledWith({
      ticketId: '10421',
      body: expect.anything(),
      parentId: '10158',
    });
  });

  // No `parentId` key at all on an ordinary comment — matching every
  // pre-existing test above this describe block, none of which passes a
  // fourth argument and none of which expects the key in the bridge call.
  it('omits parentId from the bridge call for an ordinary comment', async () => {
    const api = freshApi();
    bridge.postComment.mockResolvedValue({
      ok: true,
      value: {
        id: 'c1',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: 'Taking it.',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    });

    await api.postJiraComment('10421', 'Taking it.');

    const call = bridge.postComment.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(call, 'parentId')).toBe(false);
  });

  // The whole safety property this feature is built on. Never construct the
  // returned comment's own parentId from the request — only from what Jira's
  // response actually reported.
  it('renders flat when the response carries no parentId, even though the request asked for one', async () => {
    const api = freshApi();
    bridge.postComment.mockResolvedValue({
      ok: true,
      value: {
        id: 'c2',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: '@Sam Lee on it',
        createdAt: '2026-09-01T10:00:00.000Z',
        // No parentId: Jira either doesn't recognize the field or silently
        // dropped it — this response is the honest, undocumented-API answer.
      },
    });

    const comment = await api.postJiraComment(
      '10421',
      '@Sam Lee on it',
      [],
      '10158',
    );

    expect(comment.parentId).toBeNull();
  });

  it("maps the response's own parentId when Jira genuinely nested the reply", async () => {
    const api = freshApi();
    bridge.postComment.mockResolvedValue({
      ok: true,
      value: {
        id: 'c2',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: '@Sam Lee on it',
        createdAt: '2026-09-01T10:00:00.000Z',
        parentId: '10158',
      },
    });

    const comment = await api.postJiraComment(
      '10421',
      '@Sam Lee on it',
      [],
      '10158',
    );

    expect(comment.parentId).toBe('10158');
  });
});

describe('deleteJiraComment', () => {
  it('calls the bridge with the ticket and comment id', async () => {
    const api = freshApi();
    bridge.deleteComment.mockResolvedValue({ ok: true, value: undefined });

    await api.deleteJiraComment('10421', 'c1');

    expect(bridge.deleteComment).toHaveBeenCalledWith({
      ticketId: '10421',
      commentId: 'c1',
    });
  });

  it("throws with Jira's own message on failure, same as every other write", async () => {
    const api = freshApi();
    bridge.deleteComment.mockResolvedValue({
      ok: false,
      reason: 'jira_error',
      message: 'You do not have permission to delete this comment.',
    });

    await expect(api.deleteJiraComment('10421', 'c1')).rejects.toThrow(
      'You do not have permission to delete this comment.',
    );
  });

  // A 403 (permission revoked since it was checked) or a 404 (someone else
  // already deleted it) must surface honestly rather than fail silently —
  // this app's toast channel is error-only, and `reason` is what a caller
  // above this layer could use to tell those apart, the same carried value
  // `unwrap` already preserves for every other write.
  it('carries a permission failure reason rather than a generic one', async () => {
    const api = freshApi();
    bridge.deleteComment.mockResolvedValue({
      ok: false,
      reason: 'jira_error',
      message: 'The comment could not be found. It may already be deleted.',
    });

    await expect(api.deleteJiraComment('10421', 'c1')).rejects.toMatchObject({
      name: 'JiraApiError',
      message: 'The comment could not be found. It may already be deleted.',
    });
  });

  // The same trap postJiraComment already solves, on the other side of the
  // same write: deleting a comment moves the ISSUE's `updated` in Jira too,
  // and this call gets nothing back to re-baseline from (main answers a
  // plain 204). Left unhandled, the very next queue read would compare a
  // stale cached timestamp against a value the user's own delete moved and
  // report "Someone changed this" about their own action.
  it("does not flag the user's own delete as a third-party edit", async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:00:00.000Z' })]),
    );
    await api.listMyJiraTickets();

    bridge.deleteComment.mockResolvedValue({ ok: true, value: undefined });
    await api.deleteJiraComment('10421', 'c1');

    // Jira now reports a later `updated` — moved by our own delete.
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:05:00.000Z' })]),
    );
    const { tickets } = await api.listMyJiraTickets();

    expect(tickets[0]).toMatchObject({ hasConflict: false, conflict: null });
  });
});

describe('getJiraCommentPermissions', () => {
  it('maps the four permission booleans through, unchanged', async () => {
    const api = freshApi();
    bridge.getCommentPermissions.mockResolvedValue({
      ok: true,
      value: {
        deleteAll: false,
        deleteOwn: true,
        editAll: false,
        editOwn: true,
      },
    });

    const permissions = await api.getJiraCommentPermissions('ENG-421');

    expect(bridge.getCommentPermissions).toHaveBeenCalledWith('ENG-421');
    expect(permissions).toEqual({
      deleteAll: false,
      deleteOwn: true,
      editAll: false,
      editOwn: true,
    });
  });

  it("throws with Jira's own message on failure", async () => {
    const api = freshApi();
    bridge.getCommentPermissions.mockResolvedValue({
      ok: false,
      reason: 'jira_error',
      message: 'Could not read permissions.',
    });

    await expect(api.getJiraCommentPermissions('ENG-421')).rejects.toThrow(
      'Could not read permissions.',
    );
  });
});

describe('buildJiraCommentPermalink', () => {
  // Verified against live Jira: this is the exact URL shape its own "Copy
  // link" on a comment produces, and JiraTicketDetail.tsx's Copy link action
  // trusts this function for the string it hands to the clipboard —
  // asserted exactly, not as a substring match, since a stray slash or the
  // wrong query key would still "look like a link" while pointing nowhere
  // useful.
  it('builds the exact permalink Jira itself uses for a comment', () => {
    const api = freshApi();

    expect(
      api.buildJiraCommentPermalink(
        'waypoint123.atlassian.net',
        'ENG-421',
        '10502',
      ),
    ).toBe(
      'https://waypoint123.atlassian.net/browse/ENG-421?focusedCommentId=10502',
    );
  });
});

// buildCommentAdf's markdown-lite subset -- what JiraCommentComposer.tsx's
// toolbar produces, not general Markdown. Exercised through postJiraComment
// like every other case above, so a regression here is caught at the same
// boundary a real post would fail at.
describe('comment formatting', () => {
  async function postAndCaptureBody(text: string) {
    const api = freshApi();
    bridge.postComment.mockResolvedValue({
      ok: true,
      value: {
        id: 'c1',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: text,
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    });
    await api.postJiraComment('10421', text);
    return bridge.postComment.mock.calls[0][0].body;
  }

  // Every one of these posts successfully today and is accepted by Jira —
  // which is exactly why they needed tests. The delimiter scanner knew
  // nothing about mention spans, so a run could start outside a mention and
  // end inside it, and the parser's recursion then resumed from a point in
  // the middle of the mention's own text.
  describe('mentions are not cut by delimiter scanning', () => {
    const M = (start: number, end: number, displayName: string) => ({
      start,
      end,
      accountId: 'acc-1',
      displayName,
    });

    async function postWithMentions(text: string, mentions: unknown[]) {
      const api = freshApi();
      bridge.postComment.mockResolvedValue({
        ok: true,
        value: {
          id: 'c1',
          ticketId: '10421',
          authorName: 'Max Chen',
          body: text,
          createdAt: '2026-09-01T10:00:00.000Z',
        },
      });
      await api.postJiraComment('10421', text, mentions as never);
      // The LAST call, not the first. A test that posts twice (the
      // order-independence one below does) would otherwise assert against the
      // first call's body twice and pass no matter what the second produced.
      const { calls } = bridge.postComment.mock;
      return calls[calls.length - 1][0].body.content[0].content;
    }

    // `_` is legal in an Atlassian display name. It used to pair with any
    // other underscore in the comment and produce a run that cut the
    // mention, emitting the tail of the name a second time: this posted as
    // "@Bob_MarleyMarley cool_".
    it('does not duplicate text when a display name contains a delimiter', async () => {
      expect(
        await postWithMentions('_@Bob_Marley cool_', [M(1, 12, 'Bob_Marley')]),
      ).toEqual([
        { type: 'text', text: '_' },
        { type: 'mention', attrs: { id: 'acc-1', text: '@Bob_Marley' } },
        { type: 'text', text: ' cool_' },
      ]);
    });

    // A fenced block already kept a mention literal; an inline span did not,
    // so two spellings of "this is code" disagreed about whether the text
    // could notify someone.
    it('keeps a mention literal inside inline code, as a fenced block does', async () => {
      expect(
        await postWithMentions('`@Sam Lee`', [M(1, 9, 'Sam Lee')]),
      ).toEqual([
        { type: 'text', text: '@Sam Lee', marks: [{ type: 'code' }] },
      ]);
    });

    // Containment is legitimate and must keep working — the mention still
    // emits unmarked inside the bold run, because Jira rejects a marked one.
    it('still allows a bold run to contain a mention', async () => {
      const out = await postWithMentions('**hi @Sam Lee**', [
        M(5, 13, 'Sam Lee'),
      ]);
      expect(out).toContainEqual({
        type: 'mention',
        attrs: { id: 'acc-1', text: '@Sam Lee' },
      });
      expect(out).toContainEqual({
        type: 'text',
        text: 'hi ',
        marks: [{ type: 'strong' }],
      });
    });

    // Two spans can each be individually valid and still overlap. Whichever
    // came first in the caller's array used to win, so the same draft could
    // post a different mention depending on append order.
    it('resolves overlapping spans the same way whatever order they arrive in', async () => {
      const leftmostWins = [
        { type: 'mention', attrs: { id: 'acc-1', text: '@Sam Lee' } },
      ];
      expect(
        await postWithMentions('@Sam Lee', [
          M(0, 8, 'Sam Lee'),
          M(0, 4, 'Sam'),
        ]),
      ).toEqual(leftmostWins);
      expect(
        await postWithMentions('@Sam Lee', [
          M(0, 4, 'Sam'),
          M(0, 8, 'Sam Lee'),
        ]),
      ).toEqual(leftmostWins);
    });
  });

  describe('link addresses', () => {
    it('keeps a real https link', async () => {
      const body = await postAndCaptureBody('see [the docs](https://x.dev/a)');
      expect(body.content[0].content).toContainEqual({
        type: 'text',
        text: 'the docs',
        marks: [{ type: 'link', attrs: { href: 'https://x.dev/a' } }],
      });
    });

    // People type bare domains. Posted as-is, Jira reads that as a relative
    // link that goes nowhere.
    it('assumes https for a bare domain', async () => {
      const body = await postAndCaptureBody('see [docs](example.com/guide)');
      expect(body.content[0].content).toContainEqual({
        type: 'text',
        text: 'docs',
        marks: [{ type: 'link', attrs: { href: 'https://example.com/guide' } }],
      });
    });

    // The text survives; only the mark is dropped. Letting these through
    // would fail the whole comment at the main-process validator, so one
    // mistyped address would reject everything the user had written.
    it.each([
      ['javascript:alert(1)'],
      ['data:text/html,x'],
      ['file:///etc/passwd'],
      [' '],
    ])('posts %s as plain text rather than a link', async (href) => {
      const body = await postAndCaptureBody(`click [here](${href})`);
      const nodes = body.content[0].content as { marks?: unknown }[];
      expect(JSON.stringify(nodes)).not.toContain('link');
      expect(nodes.map((n) => (n as { text: string }).text).join('')).toContain(
        'here',
      );
    });
  });

  it('wraps **bold** as a strong mark', async () => {
    expect(await postAndCaptureBody('this is **bold** text')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'this is ' },
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' text' },
          ],
        },
      ],
    });
  });

  it('wraps _em_, ~~strike~~ and `code` as their own marks', async () => {
    const body = await postAndCaptureBody('_em_ ~~strike~~ `code`');
    expect(body.content[0].content).toEqual([
      { type: 'text', text: 'em', marks: [{ type: 'em' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'strike', marks: [{ type: 'strike' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'code', marks: [{ type: 'code' }] },
    ]);
  });

  it('turns [text](url) into a link mark', async () => {
    const body = await postAndCaptureBody(
      'see [the docs](https://example.com)',
    );
    expect(body.content[0].content).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'text',
        text: 'the docs',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
      },
    ]);
  });

  it('never puts a mark on a mention, even inside a bold run', async () => {
    const api = freshApi();
    bridge.postComment.mockResolvedValue({
      ok: true,
      value: {
        id: 'c1',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: '**hi @Sam Lee**',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    });

    // "**hi @Sam Lee**" -- the mention span covers [5, 13).
    await api.postJiraComment('10421', '**hi @Sam Lee**', [
      { start: 5, end: 13, accountId: 'acct-sam', displayName: 'Sam Lee' },
    ]);

    const { body } = bridge.postComment.mock.calls[0][0];
    expect(body.content[0].content).toEqual([
      { type: 'text', text: 'hi ', marks: [{ type: 'strong' }] },
      { type: 'mention', attrs: { id: 'acct-sam', text: '@Sam Lee' } },
    ]);
  });

  it('turns a "# " line into a heading', async () => {
    const body = await postAndCaptureBody('# Section title');
    expect(body.content).toEqual([
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'Section title' }],
      },
    ]);
  });

  it('merges consecutive "- " lines into one bullet list', async () => {
    const body = await postAndCaptureBody('- first\n- second');
    expect(body.content).toEqual([
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'second' }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('merges consecutive "1. " lines into one ordered list', async () => {
    const body = await postAndCaptureBody('1. first\n1. second');
    expect(body.content).toEqual([
      {
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'second' }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('turns a "> " line into a blockquote', async () => {
    const body = await postAndCaptureBody('> a real quote');
    expect(body.content).toEqual([
      {
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'a real quote' }],
          },
        ],
      },
    ]);
  });

  it('ends a list when a non-list line follows, starting a new block', async () => {
    const body = await postAndCaptureBody('- item one\nback to prose');
    expect(body.content).toEqual([
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'item one' }],
              },
            ],
          },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'back to prose' }] },
    ]);
  });

  it('collects a fenced code block verbatim, with no inline formatting inside it', async () => {
    const body = await postAndCaptureBody('```\nconst x = **not bold**;\n```');
    expect(body.content).toEqual([
      {
        type: 'codeBlock',
        content: [{ type: 'text', text: 'const x = **not bold**;' }],
      },
    ]);
  });

  it('flushes an unterminated fence as a code block rather than losing it', async () => {
    const body = await postAndCaptureBody('```\nno closing fence');
    expect(body.content).toEqual([
      {
        type: 'codeBlock',
        content: [{ type: 'text', text: 'no closing fence' }],
      },
    ]);
  });
});

describe('listJiraComments — bodyAdf', () => {
  it('carries the raw ADF through alongside the flattened body', async () => {
    const api = freshApi();
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Taking it.' }] },
      ],
    };
    bridge.listComments.mockResolvedValue({
      ok: true,
      value: {
        comments: [
          {
            id: 'c1',
            ticketId: '10421',
            authorName: 'Max Chen',
            authorAccountId: 'acct-max',
            updatedAt: null,
            updateAuthorName: null,
            body: 'Taking it.',
            bodyAdf: adf,
            createdAt: '2026-09-01T10:00:00.000Z',
            parentId: null,
          },
        ],
        total: 1,
      },
    });

    const { comments } = await api.listJiraComments('10421');

    expect(comments[0].bodyAdf).toEqual(adf);
  });

  it('maps a null bodyAdf through unchanged, for a legacy wiki-markup comment', async () => {
    const api = freshApi();
    bridge.listComments.mockResolvedValue({
      ok: true,
      value: {
        comments: [
          {
            id: 'c1',
            ticketId: '10421',
            authorName: 'Max Chen',
            authorAccountId: 'acct-max',
            updatedAt: null,
            updateAuthorName: null,
            body: 'Taking it.',
            bodyAdf: null,
            createdAt: '2026-09-01T10:00:00.000Z',
            parentId: null,
          },
        ],
        total: 1,
      },
    });

    const { comments } = await api.listJiraComments('10421');

    expect(comments[0].bodyAdf).toBeNull();
  });
});

/**
 * `prepareJiraCommentEdit` is the one function anything in this app may
 * trust to decide whether a real comment can be edited in place without
 * changing it — see that function's own header comment in jiraApi.ts for
 * the full reasoning. Every "round-trips" test below proves fidelity the
 * same way the function itself does: deserialize, then feed the result
 * back through the REAL, exported `buildCommentAdf` (not a re-implementation
 * of its logic) and assert the result matches the original ADF exactly —
 * so a regression in either half of the pair fails a test here rather than
 * silently drifting the two apart.
 */
describe('prepareJiraCommentEdit', () => {
  function commentWithAdf(
    adf: unknown,
    overrides: Partial<JiraComment> = {},
  ): JiraComment {
    return {
      id: 'c1',
      ticketId: '10421',
      authorName: 'Max Chen',
      authorAccountId: 'acct-max',
      updatedAt: null,
      updateAuthorName: null,
      body: 'irrelevant to this function — it reads bodyAdf, not body',
      createdAt: '2026-09-01T10:00:00.000Z',
      parentId: null,
      postedByWaypoint: false,
      disclosureText: null,
      bodyAdf: adf,
      ...overrides,
    };
  }

  // Captured verbatim from the founder's real Jira (ENG-84, comment 10192,
  // created by Jira's own Reply button). Jira's editor stamps identity-only
  // attrs this app never emits — localId on every node it creates, and
  // accessLevel on a mention — so a strict compare refused every comment
  // authored in Jira rather than in Waypoint. Replies always hit it because
  // Jira's Reply always produces one.
  //
  // This is the one fixture standing behind normalizeAdfForCompare's
  // localId/accessLevel exemption — the decision that lets real,
  // Jira-authored comments be edited at all — so `not.toBeNull()` alone
  // proved too little: it only shows deserializing didn't fail, not that
  // what came out is the right text or that reposting it reproduces the
  // original. Every assertion below is checked against this same fixture
  // the way its sibling round-trip tests check theirs: the deserialized
  // text and mentions exactly, then the ADF `buildCommentAdf` — the real
  // posting function, not a copy of its logic — produces from them, which
  // must equal the original `adf` with exactly `localId` and the empty
  // `accessLevel` removed (the only two things normalizeAdfForCompare is
  // documented to ignore) and nothing else different.
  it('accepts a real Jira-authored reply, whose nodes carry localId and accessLevel', () => {
    const api = freshApi();
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'mention',
              attrs: {
                id: '712020:05c45d40-ca2a-4829-84ad-df1f5429a4d0',
                text: '@Amaan Nawab',
                accessLevel: '',
                localId: '6fec578becdd',
              },
            },
            { type: 'text', text: ' Reply Should be like this ' },
          ],
          attrs: { localId: '633aec66e054' },
        },
      ],
    };

    const result = api.prepareJiraCommentEdit(commentWithAdf(adf));
    if (!result) throw new Error('expected the round trip to succeed');

    expect(result.text).toBe('@Amaan Nawab Reply Should be like this ');
    expect(result.mentions).toEqual([
      {
        start: 0,
        end: '@Amaan Nawab'.length,
        accountId: '712020:05c45d40-ca2a-4829-84ad-df1f5429a4d0',
        displayName: 'Amaan Nawab',
      },
    ]);
    // The original `adf` minus exactly what normalizeAdfForCompare is
    // documented to ignore: the mention's `localId` and its empty
    // `accessLevel`, and the paragraph's own `localId` (which leaves it
    // with no `attrs` at all, matching what `blockToAdf` actually emits for
    // a paragraph). Everything that encodes real content — the mention's
    // `id` and `text`, and the reply text itself — must still match
    // exactly.
    expect(api.buildCommentAdf(result.text, result.mentions)).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'mention',
              attrs: {
                id: '712020:05c45d40-ca2a-4829-84ad-df1f5429a4d0',
                text: '@Amaan Nawab',
              },
            },
            { type: 'text', text: ' Reply Should be like this ' },
          ],
        },
      ],
    });
  });

  it('refuses a comment whose bodyAdf is null — nothing to run the proof against', () => {
    const api = freshApi();

    expect(api.prepareJiraCommentEdit(commentWithAdf(null))).toBeNull();
  });

  describe('round-trips every node type and mark the composer can produce', () => {
    it('a plain paragraph', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Taking it.' }],
          },
        ],
      };

      const result = api.prepareJiraCommentEdit(commentWithAdf(adf));
      if (!result) throw new Error('expected the round trip to succeed');

      expect(result.text).toBe('Taking it.');
      expect(api.buildCommentAdf(result.text, result.mentions)).toEqual(adf);
    });

    it.each([1, 2, 3] as const)('a level-%d heading', (level) => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'heading',
            attrs: { level },
            content: [{ type: 'text', text: 'Rollout plan' }],
          },
        ],
      };

      const result = api.prepareJiraCommentEdit(commentWithAdf(adf));
      if (!result) throw new Error('expected the round trip to succeed');

      expect(result.text).toBe(`${'#'.repeat(level)} Rollout plan`);
      expect(api.buildCommentAdf(result.text, result.mentions)).toEqual(adf);
    });

    it('a bullet list', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'first' }],
                  },
                ],
              },
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'second' }],
                  },
                ],
              },
            ],
          },
        ],
      };

      const result = api.prepareJiraCommentEdit(commentWithAdf(adf));
      if (!result) throw new Error('expected the round trip to succeed');

      expect(result.text).toBe('- first\n- second');
      expect(api.buildCommentAdf(result.text, result.mentions)).toEqual(adf);
    });

    it('an ordered list', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'orderedList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'first' }],
                  },
                ],
              },
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'second' }],
                  },
                ],
              },
            ],
          },
        ],
      };

      const result = api.prepareJiraCommentEdit(commentWithAdf(adf));
      if (!result) throw new Error('expected the round trip to succeed');

      // ADF's own orderedList carries no per-item number to preserve, so the
      // exact digits synthesized here are not the point — the round trip
      // through buildCommentAdf is.
      expect(api.buildCommentAdf(result.text, result.mentions)).toEqual(adf);
    });

    it('a blockquote', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'blockquote',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'they said no' }],
              },
            ],
          },
        ],
      };

      const result = api.prepareJiraCommentEdit(commentWithAdf(adf));
      if (!result) throw new Error('expected the round trip to succeed');

      expect(result.text).toBe('> they said no');
      expect(api.buildCommentAdf(result.text, result.mentions)).toEqual(adf);
    });

    it('a fenced code block, verbatim', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'const x = **not bold**;' }],
          },
        ],
      };

      const result = api.prepareJiraCommentEdit(commentWithAdf(adf));
      if (!result) throw new Error('expected the round trip to succeed');

      expect(result.text).toBe('```\nconst x = **not bold**;\n```');
      expect(api.buildCommentAdf(result.text, result.mentions)).toEqual(adf);
    });

    const RAW_TEXT_FOR_MARK: Record<string, string> = {
      strong: 'important',
      em: 'today',
      strike: 'gone',
      code: 'npm test',
    };

    it.each([
      ['strong', '**important**'],
      ['em', '_today_'],
      ['strike', '~~gone~~'],
      ['code', '`npm test`'],
    ] as const)('a %s-marked run', (markType, expectedText) => {
      const api = freshApi();
      const raw = RAW_TEXT_FOR_MARK[markType];
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: raw, marks: [{ type: markType }] }],
          },
        ],
      };

      const result = api.prepareJiraCommentEdit(commentWithAdf(adf));
      if (!result) throw new Error('expected the round trip to succeed');

      expect(result.text).toBe(expectedText);
      expect(api.buildCommentAdf(result.text, result.mentions)).toEqual(adf);
    });

    it('a link mark', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'docs',
                marks: [
                  { type: 'link', attrs: { href: 'https://example.com' } },
                ],
              },
            ],
          },
        ],
      };

      const result = api.prepareJiraCommentEdit(commentWithAdf(adf));
      if (!result) throw new Error('expected the round trip to succeed');

      expect(result.text).toBe('[docs](https://example.com)');
      expect(api.buildCommentAdf(result.text, result.mentions)).toEqual(adf);
    });

    // The one place fidelity means more than "renders the same": a mention
    // must survive an edit as the exact same real ADF mention node,
    // accountId included, not as literal "@Sam Lee" text that would notify
    // nobody.
    it('a mention, surviving unchanged', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'mention',
                attrs: { id: 'acct-sam', text: '@Sam Lee' },
              },
              { type: 'text', text: ' can you take this?' },
            ],
          },
        ],
      };

      const result = api.prepareJiraCommentEdit(commentWithAdf(adf));
      if (!result) throw new Error('expected the round trip to succeed');

      expect(result.text).toBe('@Sam Lee can you take this?');
      expect(result.mentions).toEqual([
        { start: 0, end: 8, accountId: 'acct-sam', displayName: 'Sam Lee' },
      ]);
      expect(api.buildCommentAdf(result.text, result.mentions)).toEqual(adf);
    });

    // A mention inside a bold run: the mark applies only to the text either
    // side of it (Jira's comment-create endpoint 400s on a marked mention —
    // see JiraAdfMentionNode's own comment in main/jira/jiraTypes.ts), and
    // this is the one case where the composer's own write path already
    // produces that exact split. Proves the deserializer reconstructs the
    // same split rather than merging the mention into the marked run.
    it('a mention beside a marked run, in the same paragraph', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'hi ', marks: [{ type: 'strong' }] },
              { type: 'mention', attrs: { id: 'acct-sam', text: '@Sam Lee' } },
            ],
          },
        ],
      };

      const result = api.prepareJiraCommentEdit(commentWithAdf(adf));
      if (!result) throw new Error('expected the round trip to succeed');

      expect(api.buildCommentAdf(result.text, result.mentions)).toEqual(adf);
    });

    // A real Jira response can carry an explicit `marks: []` on an
    // otherwise-plain text node (the same shape main/jira/jiraIpc.ts's own
    // readOptionalMarks already treats as equivalent to the key being
    // absent). Without normalizing that away before comparing, nearly every
    // ordinary, unformatted comment would spuriously fail the round trip —
    // buildCommentAdf never writes an empty `marks` array — which would mean
    // refusing the common case rather than the rare one this proof exists
    // to catch.
    it('a plain text node carrying an explicit empty marks array', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Taking it.', marks: [] }],
          },
        ],
      };

      const result = api.prepareJiraCommentEdit(commentWithAdf(adf));

      expect(result).not.toBeNull();
      expect(result?.text).toBe('Taking it.');
    });

    it('a multi-block document mixing headings, a list, a mention and a code block', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Rollout plan' }],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Assigned to ' },
              { type: 'mention', attrs: { id: 'acct-sam', text: '@Sam Lee' } },
            ],
          },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'ship it' }],
                  },
                ],
              },
            ],
          },
          {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'npm run deploy' }],
          },
        ],
      };

      const result = api.prepareJiraCommentEdit(commentWithAdf(adf));
      if (!result) throw new Error('expected the round trip to succeed');

      expect(api.buildCommentAdf(result.text, result.mentions)).toEqual(adf);
    });
  });

  describe('refuses what it cannot losslessly rebuild', () => {
    it('a table', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    content: [
                      {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'cell' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      expect(api.prepareJiraCommentEdit(commentWithAdf(adf))).toBeNull();
    });

    it('a panel', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'panel',
            attrs: { panelType: 'info' },
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'heads up' }],
              },
            ],
          },
        ],
      };

      expect(api.prepareJiraCommentEdit(commentWithAdf(adf))).toBeNull();
    });

    // The one real failure in the founder's own corpus (27 of 28 comments
    // passed this proof; the sole holdout was exactly this shape).
    it('an embedded image (mediaSingle/media)', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'mediaSingle',
            attrs: { layout: 'center' },
            content: [{ type: 'media', attrs: { id: 'att-1', type: 'file' } }],
          },
        ],
      };

      expect(api.prepareJiraCommentEdit(commentWithAdf(adf))).toBeNull();
    });

    // The case a node-type whitelist alone cannot catch: every node here is
    // a plain, unmarked "text" node — a shape this dialect fully supports —
    // and the deserializer produces text with nothing to reject. Only
    // actually re-running it through buildCommentAdf and comparing catches
    // that the literal `**` pairs would be read back as real bold.
    it('prose containing a literal double-asterisk pair, misread as bold on the way back', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'score is **10** out of **20**' }],
          },
        ],
      };

      expect(api.prepareJiraCommentEdit(commentWithAdf(adf))).toBeNull();
    });

    // Same trap, with a single-character delimiter: `_` is ordinary in a
    // filename or identifier, and nothing about a plain text node marks it
    // as "don't read this as italic."
    it('prose containing a literal underscore, misread as italic on the way back', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'the file is named my_file_name.txt' },
            ],
          },
        ],
      };

      expect(api.prepareJiraCommentEdit(commentWithAdf(adf))).toBeNull();
    });

    // Same trap again, with a backtick: ordinary in prose that mentions a
    // command or a filename without meaning to mark it as code.
    it('prose containing a literal backtick, misread as code on the way back', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'run `npm test` in your terminal' },
            ],
          },
        ],
      };

      expect(api.prepareJiraCommentEdit(commentWithAdf(adf))).toBeNull();
    });

    // A mention carrying a mark is not a shape the composer's own write path
    // can ever produce (Jira's comment-create endpoint 400s on one — see
    // JiraAdfMentionNode's own comment) — refused rather than silently
    // stripping the mark, which would be exactly the kind of guess this
    // feature exists to refuse to make.
    it('a mention that improperly carries a mark', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'mention',
                attrs: { id: 'acct-sam', text: '@Sam Lee' },
                marks: [{ type: 'strong' }],
              },
            ],
          },
        ],
      };

      expect(api.prepareJiraCommentEdit(commentWithAdf(adf))).toBeNull();
    });

    // A link mark whose href this app cannot post (see buildCommentAdf's own
    // postableHref) is not the same failure as a missing href, but it is
    // still a real mark this dialect cannot round-trip.
    it('a link mark with a scheme this app never posts', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'call me',
                marks: [{ type: 'link', attrs: { href: 'tel:+15551234567' } }],
              },
            ],
          },
        ],
      };

      expect(api.prepareJiraCommentEdit(commentWithAdf(adf))).toBeNull();
    });

    // A relative Jira-internal link — real: Jira's own editor produces
    // `/browse/ENG-1` when a user types or pastes an issue key, and
    // JiraRichText.tsx's `safeHref` renders it fine. But this app's composer
    // dialect only ever posts a web address or an email (see postableHref's
    // own comment, and main/jira/jiraIpc.ts's matching `isPostableHref` on
    // the real network boundary) — a relative href is not one, so this is
    // refused the same honest way an unpostable scheme is, rather than
    // deserializing successfully and failing the round trip two steps later
    // for a reason nothing states.
    it('a link mark with a Jira-relative href', () => {
      const api = freshApi();
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'ENG-1',
                marks: [{ type: 'link', attrs: { href: '/browse/ENG-1' } }],
              },
            ],
          },
        ],
      };

      expect(api.prepareJiraCommentEdit(commentWithAdf(adf))).toBeNull();
    });
  });
});

describe('updateJiraComment', () => {
  it('sends the ADF built from text and mentions to the bridge, with the ticket and comment id', async () => {
    const api = freshApi();
    bridge.updateComment.mockResolvedValue({
      ok: true,
      value: {
        id: 'c1',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: 'edited text',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    });

    await api.updateJiraComment('10421', 'c1', 'edited text');

    expect(bridge.updateComment).toHaveBeenCalledWith({
      ticketId: '10421',
      commentId: 'c1',
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'edited text' }],
          },
        ],
      },
    });
  });

  it('maps the response through the same toComment every read and write uses', async () => {
    const api = freshApi();
    bridge.updateComment.mockResolvedValue({
      ok: true,
      value: {
        id: 'c1',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: 'edited text',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    });

    const comment = await api.updateJiraComment('10421', 'c1', 'edited text');

    expect(comment).toMatchObject({
      id: 'c1',
      body: 'edited text',
      postedByWaypoint: false,
      disclosureText: null,
    });
  });

  // The whole safety property this shares with postJiraComment's own reply
  // handling: parentId comes from Jira's RESPONSE, never fabricated from
  // what this function already knew locally — an edited reply keeps
  // whatever thread position Jira's response still reports for it.
  it("preserves the response's own parentId, so an edited reply does not jump out of its thread", async () => {
    const api = freshApi();
    bridge.updateComment.mockResolvedValue({
      ok: true,
      value: {
        id: 'c2',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: 'edited reply',
        createdAt: '2026-09-01T10:00:00.000Z',
        parentId: '10158',
      },
    });

    const comment = await api.updateJiraComment('10421', 'c2', 'edited reply');

    expect(comment.parentId).toBe('10158');
  });

  it("throws with Jira's own message on failure, same as every other write", async () => {
    const api = freshApi();
    bridge.updateComment.mockResolvedValue({
      ok: false,
      reason: 'jira_error',
      message: 'You do not have permission to edit this comment.',
    });

    await expect(
      api.updateJiraComment('10421', 'c1', 'edited text'),
    ).rejects.toThrow('You do not have permission to edit this comment.');
  });

  // The same trap postJiraComment and deleteJiraComment already solve:
  // editing a comment moves the ISSUE's `updated` in Jira too. Left
  // unhandled, the very next queue read would compare a stale cached
  // timestamp against a value the user's own edit moved and report "Someone
  // changed this" about their own action.
  it("does not flag the user's own edit as a third-party change", async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:00:00.000Z' })]),
    );
    await api.listMyJiraTickets();

    bridge.updateComment.mockResolvedValue({
      ok: true,
      value: {
        id: 'c1',
        ticketId: '10421',
        authorName: 'Max Chen',
        body: 'edited text',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    });
    await api.updateJiraComment('10421', 'c1', 'edited text');

    // Jira now reports a later `updated` — moved by our own edit.
    bridge.listTickets.mockResolvedValue(
      ticketsResult([wireTicket({ updatedAt: '2026-09-01T10:05:00.000Z' })]),
    );
    const { tickets } = await api.listMyJiraTickets();

    expect(tickets[0]).toMatchObject({ hasConflict: false, conflict: null });
  });
});
