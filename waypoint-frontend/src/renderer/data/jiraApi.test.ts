import type { JiraWireTicket } from '../../main/jira/jiraTypes';

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
    attachments: [],
    transitions: [],
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
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
  bridge.listTickets.mockResolvedValue({ ok: true, value: [] });
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
    bridge.listTickets.mockResolvedValue({
      ok: true,
      value: [
        wireTicket({ id: '1', stateCategory: 'todo' }),
        wireTicket({ id: '2', stateCategory: 'in-progress' }),
        wireTicket({ id: '3', stateCategory: 'done' }),
      ],
    });

    const tickets = await api.listMyJiraTickets();

    expect(tickets.map((t) => t.stateColor)).toEqual([
      'var(--text-muted)',
      'var(--warning)',
      'var(--success)',
    ]);
  });

  // Tombstones and conflicts describe drift between a previous read and the
  // current one. There is no store to compare against in this phase, so
  // nothing invents them.
  it('never marks a real ticket as tombstoned or conflicted', async () => {
    const api = freshApi();
    bridge.listTickets.mockResolvedValue({ ok: true, value: [wireTicket()] });

    expect(await api.listMyJiraTickets()).toEqual([
      expect.objectContaining({
        isTombstoned: false,
        tombstone: null,
        hasConflict: false,
        conflict: null,
      }),
    ]);
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
    bridge.listTickets.mockResolvedValue({
      ok: true,
      value: [wireTicket({ transitions: [BULK_TRANSITION] })],
    });
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
    bridge.listTickets.mockResolvedValue({
      ok: true,
      value: [wireTicket({ transitions: [] })],
    });
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
    bridge.listTickets.mockResolvedValue({
      ok: true,
      value: [
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
      ],
    });
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
    bridge.listTickets.mockResolvedValue({
      ok: true,
      value: [wireTicket({ id: '10421' }), wireTicket({ id: '10999' })],
    });
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
    bridge.listTickets.mockResolvedValue({
      ok: true,
      value: [wireTicket({ id: '10421' }), wireTicket({ id: '10999' })],
    });
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
    bridge.listTickets.mockResolvedValue({
      ok: true,
      value: [wireTicket({ id: '10421' })],
    });
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
    bridge.listTickets.mockResolvedValue({
      ok: true,
      value: [wireTicket({ id: '10421', assigneeName: 'Max Chen' })],
    });
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
    bridge.listTickets.mockResolvedValue({
      ok: true,
      value: [
        wireTicket({ id: '1', projectKey: 'ENG' }),
        wireTicket({ id: '2', projectKey: 'ENG' }),
        wireTicket({ id: '3', projectKey: 'OPS' }),
      ],
    });

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
    bridge.listTickets.mockResolvedValue({ ok: true, value: [wireTicket()] });
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
      body: 'Taking it.',
    });
    // Jira has no property to carry provenance and this app keeps no record
    // of what it posted, so a comment read back is just a comment.
    expect(comment).toMatchObject({
      body: 'Taking it.',
      postedByWaypoint: false,
      disclosureText: null,
    });
  });
});

describe('the Copilot rail', () => {
  // These used to return a hand-written ENG-421 proposal from the design
  // mockup. Against a live site that names an issue the user does not have,
  // and its Approve button would report a state move and a comment that never
  // reached Jira. Nothing generates one for real yet, so nothing is returned.
  it('offers no proposal and no duplicate nudge, rather than an invented one', async () => {
    const api = freshApi();

    expect(await api.getMyJiraProposal()).toBeUndefined();
    expect(await api.getJiraDuplicateNudge()).toBeUndefined();
  });

  it('refuses loudly if an approval is somehow attempted', async () => {
    const api = freshApi();

    await expect(api.approveJiraProposal('any')).rejects.toThrow(
      /isn't built yet/,
    );
  });
});
