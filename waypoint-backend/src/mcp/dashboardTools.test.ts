import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * dashboardTools.ts's own handler logic (ROAD-157) — validation, binding
 * resolution branching, and result shaping. Mirrors ticketTools.jira.test.ts's
 * approach exactly: Jira reaches a handler as a plain first argument (the
 * request's own provider), so a stub is passed in directly rather than
 * mocking providers/jira.js — the real provider methods (JQL construction,
 * the allowlist, id-shape tolerance) are covered in jira.test.ts instead.
 */

const {
  listJiraDashboardsHandler,
  describeJiraDashboardHandler,
  searchDashboardGadgetIssuesHandler,
} = await import('./dashboardTools.js');

function jiraStub() {
  return {
    kind: 'jira' as const,
    listDashboards: vi.fn(async () => ({
      dashboards: [] as { id: string; name: string; isFavourite: boolean }[],
      truncated: false,
    })),
    getDashboardGadgets: vi.fn(async () => [] as { id: string; title: string; moduleKey: string }[] | null),
    resolveGadgetBinding: vi.fn(
      async () =>
        ({ kind: 'unresolved', reason: 'stub default' }) as
          | { kind: 'filter'; filterId: string; filterName: string; jql: string }
          | { kind: 'project'; projectKey: string }
          | { kind: 'builtinQuery'; label: string; jql: string }
          | { kind: 'unresolved'; reason: string },
    ),
    getFilter: vi.fn(async () => null as { id: string; name: string; jql: string } | null),
    searchFilters: vi.fn(async () => ({
      filters: [] as { id: string; name: string }[],
      truncated: false,
    })),
    searchIssuesByFilter: vi.fn(async () => ({
      jql: 'filter = 10123 AND assignee = currentUser()',
      issues: [] as { key: string; summary: string; status: string; issueType: string; updated: string; url: string }[],
      truncated: false,
    })),
    searchIssuesByBuiltinQuery: vi.fn(async () => ({
      jql: 'assignee = currentUser() AND statusCategory != 3 ORDER BY issuetype ASC, updated DESC',
      issues: [] as { key: string; summary: string; status: string; issueType: string; updated: string; url: string }[],
      truncated: false,
    })),
  };
}

let jira: ReturnType<typeof jiraStub> | null;

function parse(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

function connectJira() {
  jira = jiraStub();
  return jira;
}

beforeEach(() => {
  jira = null;
});

const JIRA_NOT_CONNECTED_TEXT = /Jira is not connected/;

describe('listJiraDashboardsHandler', () => {
  it('refuses when Jira is not connected', async () => {
    const result = await listJiraDashboardsHandler(null, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(JIRA_NOT_CONNECTED_TEXT);
  });

  it('passes nameContains and the resolved limit straight through', async () => {
    const stub = connectJira();
    stub.listDashboards.mockResolvedValue({
      dashboards: [{ id: '10810', name: 'Sprint Health', isFavourite: true }],
      truncated: false,
    });

    const result = await listJiraDashboardsHandler(jira, { nameContains: 'sprint', limit: 10 });

    expect(stub.listDashboards).toHaveBeenCalledWith('sprint', 10);
    expect(parse(result)).toEqual({
      dashboards: [{ id: '10810', name: 'Sprint Health', isFavourite: true }],
      truncated: false,
    });
  });

  it('surfaces truncated so the model can tell "not found" apart from "not found in the first page"', async () => {
    const stub = connectJira();
    stub.listDashboards.mockResolvedValue({ dashboards: [], truncated: true });

    const result = await listJiraDashboardsHandler(jira, { nameContains: 'does-not-exist' });

    expect(parse(result)).toEqual({ dashboards: [], truncated: true });
  });
});

describe('describeJiraDashboardHandler', () => {
  it('refuses when Jira is not connected', async () => {
    const result = await describeJiraDashboardHandler(null, { dashboardId: '10810' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(JIRA_NOT_CONNECTED_TEXT);
  });

  it('reports a real miss as not found, not an empty gadget list', async () => {
    const stub = connectJira();
    stub.getDashboardGadgets.mockResolvedValue(null);

    const result = await describeJiraDashboardHandler(jira, { dashboardId: '99999' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('dashboard not found');
  });

  it('resolves every gadget on the dashboard and reports each binding', async () => {
    const stub = connectJira();
    stub.getDashboardGadgets.mockResolvedValue([
      { id: '161155', title: 'Two-dimensional filter', moduleKey: 'com.atlassian.jira.gadgets:twodimensional-stats-gadget' },
      { id: '10001', title: 'Spaces', moduleKey: 'com.atlassian.jira.gadgets:project-gadget' },
    ]);
    stub.resolveGadgetBinding.mockImplementation(async (_dashboardId, gadgetId) =>
      gadgetId === '161155'
        ? { kind: 'filter', filterId: '10123', filterName: 'My Team Board', jql: 'project = ENG' }
        : { kind: 'unresolved', reason: 'no config' },
    );

    const result = await describeJiraDashboardHandler(jira, { dashboardId: '10810' });

    expect(stub.resolveGadgetBinding).toHaveBeenCalledWith(
      '10810',
      '161155',
      'com.atlassian.jira.gadgets:twodimensional-stats-gadget',
    );
    expect(stub.resolveGadgetBinding).toHaveBeenCalledWith(
      '10810',
      '10001',
      'com.atlassian.jira.gadgets:project-gadget',
    );
    expect(parse(result)).toEqual({
      dashboardId: '10810',
      gadgets: [
        {
          gadgetId: '161155',
          title: 'Two-dimensional filter',
          moduleKey: 'com.atlassian.jira.gadgets:twodimensional-stats-gadget',
          binding: { kind: 'filter', filterId: '10123', filterName: 'My Team Board', jql: 'project = ENG' },
        },
        {
          gadgetId: '10001',
          title: 'Spaces',
          moduleKey: 'com.atlassian.jira.gadgets:project-gadget',
          binding: { kind: 'unresolved', reason: 'no config' },
        },
      ],
      truncated: false,
    });
  });

  // Round-1 review (ROAD-157): resolving every gadget concurrently is
  // bounded, not open-ended — a dashboard's gadget count is not something
  // this app's own query controls, unlike every other list tool's `limit`.
  it('resolves at most 25 gadgets and reports truncated, rather than firing an unbounded burst of requests', async () => {
    const stub = connectJira();
    const gadgets = Array.from({ length: 30 }, (_, i) => ({
      id: `${10000 + i}`,
      title: `Gadget ${i}`,
      moduleKey: 'x',
    }));
    stub.getDashboardGadgets.mockResolvedValue(gadgets);
    stub.resolveGadgetBinding.mockResolvedValue({ kind: 'unresolved', reason: 'no config' });

    const result = await describeJiraDashboardHandler(jira, { dashboardId: '10810' });

    expect(stub.resolveGadgetBinding).toHaveBeenCalledTimes(25);
    const parsed = parse(result);
    expect(parsed.gadgets).toHaveLength(25);
    expect(parsed.truncated).toBe(true);
  });

  // Round-10 review (ROAD-157): a recognized built-in gadget's binding
  // surfaces through describe_jira_dashboard the same way a filter/project
  // binding does — just a new `kind`, not a different shape a caller has to
  // special-case.
  it('reports a builtinQuery binding for a recognized built-in gadget', async () => {
    const stub = connectJira();
    stub.getDashboardGadgets.mockResolvedValue([
      { id: '10002', title: 'Assigned to Me', moduleKey: 'com.atlassian.jira.gadgets:assigned-to-me-gadget' },
    ]);
    stub.resolveGadgetBinding.mockResolvedValue({
      kind: 'builtinQuery',
      label: 'Assigned to Me',
      jql: 'assignee = currentUser() AND statusCategory != 3',
    });

    const result = await describeJiraDashboardHandler(jira, { dashboardId: '10810' });

    expect(parse(result)).toEqual({
      dashboardId: '10810',
      gadgets: [
        {
          gadgetId: '10002',
          title: 'Assigned to Me',
          moduleKey: 'com.atlassian.jira.gadgets:assigned-to-me-gadget',
          binding: {
            kind: 'builtinQuery',
            label: 'Assigned to Me',
            jql: 'assignee = currentUser() AND statusCategory != 3',
          },
        },
      ],
      truncated: false,
    });
  });
});

describe('searchDashboardGadgetIssuesHandler — validation', () => {
  it('refuses when Jira is not connected', async () => {
    const result = await searchDashboardGadgetIssuesHandler(null, { assigneeScope: 'me', filterId: '10123' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(JIRA_NOT_CONNECTED_TEXT);
  });

  it('refuses when neither a filter nor a dashboard+gadget pair is given', async () => {
    const result = await searchDashboardGadgetIssuesHandler(connectJira(), { assigneeScope: 'me' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Pass either/);
  });

  it('refuses when BOTH a filter and a dashboard+gadget pair are given, not just neither', async () => {
    const result = await searchDashboardGadgetIssuesHandler(connectJira(), {
      assigneeScope: 'me',
      filterId: '10123',
      dashboardId: '10810',
      gadgetId: '161155',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Pass either/);
  });

  it('refuses a dashboardId with no gadgetId (or vice versa) rather than silently ignoring the half-pair', async () => {
    const result = await searchDashboardGadgetIssuesHandler(connectJira(), {
      assigneeScope: 'me',
      dashboardId: '10810',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must be given together/);
  });

  it('refuses assigneeScope "accountId" with no accountId', async () => {
    const result = await searchDashboardGadgetIssuesHandler(connectJira(), {
      assigneeScope: 'accountId',
      filterId: '10123',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/accountId is required/);
  });
});

describe('searchDashboardGadgetIssuesHandler — filterId path', () => {
  it('queries the given filter directly, with no gadget resolution at all', async () => {
    const stub = connectJira();
    stub.searchIssuesByFilter.mockResolvedValue({
      jql: 'filter = 10123 AND assignee = currentUser()',
      issues: [
        {
          key: 'ENG-4',
          summary: 'Login bug',
          status: 'In Progress',
          issueType: 'Bug',
          updated: '2026-08-20',
          url: 'https://yourteam.atlassian.net/browse/ENG-4',
        },
      ],
      truncated: false,
    });

    const result = await searchDashboardGadgetIssuesHandler(jira, { assigneeScope: 'me', filterId: '10123' });

    expect(stub.resolveGadgetBinding).not.toHaveBeenCalled();
    expect(stub.searchIssuesByFilter).toHaveBeenCalledWith({
      filterId: '10123',
      assigneeScope: 'me',
      accountId: undefined,
      issueTypes: undefined,
      limit: 50,
    });
    const parsed = parse(result);
    expect(parsed.resolvedFrom).toEqual({ kind: 'filter', filterId: '10123' });
    expect(parsed.jql).toBe('filter = 10123 AND assignee = currentUser()');
    // No `total` field (round-5 review, ROAD-157) — result.issues.length
    // after searchIssuesByFilter's own limit slice is a floor on the real
    // match count whenever truncated is true, not a count, and a field
    // literally named `total` invited exactly that misreading.
    expect(parsed).not.toHaveProperty('total');
    expect(parsed.groups).toEqual([
      {
        key: 'Bug',
        count: 1,
        issues: [
          {
            key: 'ENG-4',
            summary: 'Login bug',
            status: 'In Progress',
            issueType: 'Bug',
            updated: '2026-08-20',
            url: 'https://yourteam.atlassian.net/browse/ENG-4',
          },
        ],
      },
    ]);
  });
});

describe('searchDashboardGadgetIssuesHandler — dashboard+gadget path', () => {
  it('resolves the gadget to a filter, then queries it, and reports the resolution in resolvedFrom', async () => {
    const stub = connectJira();
    stub.resolveGadgetBinding.mockResolvedValue({
      kind: 'filter',
      filterId: '10123',
      filterName: 'My Team Board',
      jql: 'project = ENG',
    });

    await searchDashboardGadgetIssuesHandler(jira, {
      assigneeScope: 'me',
      dashboardId: '10810',
      gadgetId: '161155',
    });

    // Third arg is the matched gadget's moduleKey — undefined here because
    // the stub's default getDashboardGadgets() returns [] (no gadget with
    // id '161155' to find), not because resolveGadgetBinding was called
    // with only two arguments.
    expect(stub.resolveGadgetBinding).toHaveBeenCalledWith('10810', '161155', undefined);
    expect(stub.searchIssuesByFilter).toHaveBeenCalledWith(
      expect.objectContaining({ filterId: '10123' }),
    );
  });

  // Round-10 review (ROAD-157): the matched gadget's real moduleKey reaches
  // resolveGadgetBinding this time (unlike the filter-path test above,
  // which relies on the stub's default empty gadget list) — getDashboardGadgets
  // is now fetched unconditionally before resolveGadgetBinding is called,
  // specifically so a recognized built-in's moduleKey is available to check.
  it('resolves a recognized built-in gadget and queries it via searchIssuesByBuiltinQuery, not searchIssuesByFilter', async () => {
    const stub = connectJira();
    stub.getDashboardGadgets.mockResolvedValue([
      { id: '10002', title: 'Assigned to Me', moduleKey: 'com.atlassian.jira.gadgets:assigned-to-me-gadget' },
    ]);
    stub.resolveGadgetBinding.mockResolvedValue({
      kind: 'builtinQuery',
      label: 'Assigned to Me',
      jql: 'assignee = currentUser() AND statusCategory != 3',
    });
    stub.searchIssuesByBuiltinQuery.mockResolvedValue({
      jql: 'assignee = currentUser() AND statusCategory != 3 ORDER BY issuetype ASC, updated DESC',
      issues: [
        {
          key: 'ENG-29',
          summary: 'The audit log',
          status: 'In Progress',
          issueType: 'Bug',
          updated: '2026-09-18',
          url: 'https://yourteam.atlassian.net/browse/ENG-29',
        },
      ],
      truncated: false,
    });

    const result = await searchDashboardGadgetIssuesHandler(jira, {
      assigneeScope: 'me',
      dashboardId: '10810',
      gadgetId: '10002',
    });

    expect(stub.resolveGadgetBinding).toHaveBeenCalledWith(
      '10810',
      '10002',
      'com.atlassian.jira.gadgets:assigned-to-me-gadget',
    );
    expect(stub.searchIssuesByBuiltinQuery).toHaveBeenCalledWith(
      'assignee = currentUser() AND statusCategory != 3',
      { issueTypes: undefined, limit: 50 },
    );
    expect(stub.searchIssuesByFilter).not.toHaveBeenCalled();
    const parsed = parse(result);
    expect(parsed.resolvedFrom).toEqual({
      kind: 'builtinGadget',
      label: 'Assigned to Me',
      dashboardId: '10810',
      gadgetId: '10002',
    });
    expect(parsed.jql).toBe('assignee = currentUser() AND statusCategory != 3 ORDER BY issuetype ASC, updated DESC');
    expect(parsed.groups).toEqual([
      {
        key: 'Bug',
        count: 1,
        issues: [
          {
            key: 'ENG-29',
            summary: 'The audit log',
            status: 'In Progress',
            issueType: 'Bug',
            updated: '2026-09-18',
            url: 'https://yourteam.atlassian.net/browse/ENG-29',
          },
        ],
      },
    ]);
  });

  it('refuses assigneeScope "accountId" against a built-in gadget instead of silently contradicting its own definition', async () => {
    const stub = connectJira();
    stub.getDashboardGadgets.mockResolvedValue([
      { id: '10002', title: 'Assigned to Me', moduleKey: 'com.atlassian.jira.gadgets:assigned-to-me-gadget' },
    ]);
    stub.resolveGadgetBinding.mockResolvedValue({
      kind: 'builtinQuery',
      label: 'Assigned to Me',
      jql: 'assignee = currentUser() AND statusCategory != 3',
    });

    const result = await searchDashboardGadgetIssuesHandler(jira, {
      assigneeScope: 'accountId',
      accountId: '712020:05c45d40-ca2a-4829-84ad-df1f5429a4d0',
      dashboardId: '10810',
      gadgetId: '10002',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Assigned to Me/);
    expect(result.content[0].text).toMatch(/accountId/);
    expect(stub.searchIssuesByBuiltinQuery).not.toHaveBeenCalled();
  });

  it('returns needsBinding (not an error) when the gadget cannot be auto-resolved, with gadgets and filters to choose from', async () => {
    const stub = connectJira();
    stub.resolveGadgetBinding.mockResolvedValue({ kind: 'unresolved', reason: "doesn't match a recognized binding" });
    stub.getDashboardGadgets.mockResolvedValue([{ id: '161155', title: 'Two-dimensional filter', moduleKey: 'x' }]);
    stub.searchFilters.mockResolvedValue({ filters: [{ id: '10123', name: 'My Team Board' }], truncated: false });

    const result = await searchDashboardGadgetIssuesHandler(jira, {
      assigneeScope: 'me',
      dashboardId: '10810',
      gadgetId: '161155',
    });

    expect(result.isError).toBeUndefined();
    expect(stub.searchIssuesByFilter).not.toHaveBeenCalled();
    // Narrowed by the unresolved gadget's own title, not an unfiltered page
    // of every filter this account can see (round-1 review, ROAD-157).
    expect(stub.searchFilters).toHaveBeenCalledWith('Two-dimensional filter', 20);
    expect(parse(result)).toEqual({
      needsBinding: true,
      reason: "doesn't match a recognized binding",
      dashboardGadgets: [{ id: '161155', title: 'Two-dimensional filter', moduleKey: 'x' }],
      dashboardGadgetsTruncated: false,
      visibleFiltersSearched: true,
      visibleFilters: [{ id: '10123', name: 'My Team Board' }],
      visibleFiltersTruncated: false,
    });
  });

  // Round-6 review (ROAD-157): searchFilters' own isLast now says whether
  // more real name matches exist beyond the 20 shown — confirmed threaded
  // through to this payload, not just computed and dropped.
  it('reports visibleFiltersTruncated from searchFilters\' own isLast signal', async () => {
    const stub = connectJira();
    stub.resolveGadgetBinding.mockResolvedValue({ kind: 'unresolved', reason: 'no config' });
    stub.getDashboardGadgets.mockResolvedValue([{ id: '161155', title: 'Bugs', moduleKey: 'x' }]);
    stub.searchFilters.mockResolvedValue({ filters: [{ id: '10123', name: 'Bugs board' }], truncated: true });

    const result = await searchDashboardGadgetIssuesHandler(jira, {
      assigneeScope: 'me',
      dashboardId: '10810',
      gadgetId: '161155',
    });

    expect(parse(result).visibleFiltersTruncated).toBe(true);
  });

  // Round-4 review (ROAD-157): describeJiraDashboardHandler reports
  // truncated when its own 25-gadget cap trims the list; this sibling cap
  // (same MAX_GADGETS_TO_DESCRIBE) used to trim silently. The find() that
  // narrows the filter search still searches the FULL list — a gadget past
  // the cap is still correctly resolved against — but a caller reading
  // dashboardGadgets alone should know it isn't the complete set.
  it('reports dashboardGadgetsTruncated when the dashboard has more gadgets than the cap, without affecting the narrowing search itself', async () => {
    const stub = connectJira();
    stub.resolveGadgetBinding.mockResolvedValue({ kind: 'unresolved', reason: 'no config' });
    const gadgets = Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, title: `Gadget ${i}`, moduleKey: 'x' }));
    // The requested gadget is past index 25 — outside what gets reported.
    stub.getDashboardGadgets.mockResolvedValue(gadgets);

    const result = await searchDashboardGadgetIssuesHandler(jira, {
      assigneeScope: 'me',
      dashboardId: '10810',
      gadgetId: 'g27',
    });

    // Narrowing is unaffected by the cap: the full list was searched, so
    // the real title for g27 reaches searchFilters.
    expect(stub.searchFilters).toHaveBeenCalledWith('Gadget 27', 20);
    const parsed = parse(result);
    expect(parsed.dashboardGadgets).toHaveLength(25);
    expect(parsed.dashboardGadgetsTruncated).toBe(true);
  });

  // Round-3 review (ROAD-157): round 2's needsBinding narrowing fix landed
  // with only the happy-path case covered — the three fallback branches it
  // actually exists for (a stale/wrong-dashboard gadgetId, the dashboard
  // itself gone, an untitled gadget) had no regression test, which is
  // exactly the shape of gap round 2 flagged in the first place. These pin
  // each one directly against the handler's observable behavior, not just
  // the provider guard underneath it.
  it('reports the dashboard as not found (not an empty needsBinding) when it no longer exists', async () => {
    const stub = connectJira();
    stub.resolveGadgetBinding.mockResolvedValue({ kind: 'unresolved', reason: 'no config' });
    stub.getDashboardGadgets.mockResolvedValue(null);

    const result = await searchDashboardGadgetIssuesHandler(jira, {
      assigneeScope: 'me',
      dashboardId: '99999',
      gadgetId: '161155',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('dashboard not found');
    expect(stub.searchFilters).not.toHaveBeenCalled();
  });

  it('passes no real narrowing term (and gets no candidate filters back) when gadgetId is not on the dashboard', async () => {
    const stub = connectJira();
    stub.resolveGadgetBinding.mockResolvedValue({ kind: 'unresolved', reason: 'no config' });
    // A different gadget id than the one asked about — the stale/
    // wrong-dashboard case.
    stub.getDashboardGadgets.mockResolvedValue([{ id: '10001', title: 'Spaces', moduleKey: 'x' }]);

    const result = await searchDashboardGadgetIssuesHandler(jira, {
      assigneeScope: 'me',
      dashboardId: '10810',
      gadgetId: '161155',
    });

    // jira.searchFilters is still called (the real provider — not this
    // stub — is what refuses an unfiltered search; see jira.test.ts's own
    // coverage of that refusal), but with no real title to narrow by.
    expect(stub.searchFilters).toHaveBeenCalledWith(undefined, 20);
    const parsed = parse(result);
    expect(parsed.needsBinding).toBe(true);
    expect(parsed.visibleFilters).toEqual([]);
    // Round-9 review (ROAD-157): visibleFilters: [] here means "no search
    // ran" (no real title to narrow by), NOT "searched and found nothing"
    // — visibleFiltersSearched: false is the signal that tells them apart,
    // so Copilot doesn't report "your account has no visible saved
    // filters" when no search was actually attempted.
    expect(parsed.visibleFiltersSearched).toBe(false);
  });

  it('passes no real narrowing term (and gets no candidate filters back) when the matched gadget has no title', async () => {
    const stub = connectJira();
    stub.resolveGadgetBinding.mockResolvedValue({ kind: 'unresolved', reason: 'no config' });
    stub.getDashboardGadgets.mockResolvedValue([{ id: '161155', title: '', moduleKey: 'x' }]);

    const result = await searchDashboardGadgetIssuesHandler(jira, {
      assigneeScope: 'me',
      dashboardId: '10810',
      gadgetId: '161155',
    });

    expect(stub.searchFilters).toHaveBeenCalledWith('', 20);
    const parsed = parse(result);
    expect(parsed.needsBinding).toBe(true);
    expect(parsed.visibleFilters).toEqual([]);
    expect(parsed.visibleFiltersSearched).toBe(false);
  });

  it('refuses a project-bound gadget with a message pointing at search_tickets instead of guessing', async () => {
    const stub = connectJira();
    stub.resolveGadgetBinding.mockResolvedValue({ kind: 'project', projectKey: 'ENG' });

    const result = await searchDashboardGadgetIssuesHandler(jira, {
      assigneeScope: 'me',
      dashboardId: '10810',
      gadgetId: '10001',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/project "ENG"/);
    expect(result.content[0].text).toMatch(/search_tickets/);
    expect(stub.searchIssuesByFilter).not.toHaveBeenCalled();
  });
});

describe('searchDashboardGadgetIssuesHandler — grouping', () => {
  const ISSUES = [
    { key: 'ENG-1', summary: 'A', status: 'Open', issueType: 'Bug', updated: '2026-08-20', url: 'https://yourteam.atlassian.net/browse/ENG-1' },
    { key: 'ENG-2', summary: 'B', status: 'Open', issueType: 'Epic', updated: '2026-08-19', url: 'https://yourteam.atlassian.net/browse/ENG-2' },
    { key: 'ENG-3', summary: 'C', status: 'In Progress', issueType: 'Bug', updated: '2026-08-18', url: 'https://yourteam.atlassian.net/browse/ENG-3' },
  ];

  it('groups by issueType by default', async () => {
    const stub = connectJira();
    stub.searchIssuesByFilter.mockResolvedValue({ jql: 'x', issues: ISSUES, truncated: false });

    const parsed = parse(await searchDashboardGadgetIssuesHandler(jira, { assigneeScope: 'me', filterId: '10123' }));

    expect(parsed.groups).toEqual([
      { key: 'Bug', count: 2, issues: [ISSUES[0], ISSUES[2]] },
      { key: 'Epic', count: 1, issues: [ISSUES[1]] },
    ]);
  });

  it('groups by status when asked', async () => {
    const stub = connectJira();
    stub.searchIssuesByFilter.mockResolvedValue({ jql: 'x', issues: ISSUES, truncated: false });

    const parsed = parse(
      await searchDashboardGadgetIssuesHandler(jira, { assigneeScope: 'me', filterId: '10123', groupBy: 'status' }),
    );

    expect(parsed.groups).toEqual([
      { key: 'Open', count: 2, issues: [ISSUES[0], ISSUES[1]] },
      { key: 'In Progress', count: 1, issues: [ISSUES[2]] },
    ]);
  });

  it('returns one ungrouped bucket when groupBy is "none"', async () => {
    const stub = connectJira();
    stub.searchIssuesByFilter.mockResolvedValue({ jql: 'x', issues: ISSUES, truncated: false });

    const parsed = parse(
      await searchDashboardGadgetIssuesHandler(jira, { assigneeScope: 'me', filterId: '10123', groupBy: 'none' }),
    );

    expect(parsed.groups).toEqual([{ key: 'all', count: 3, issues: ISSUES }]);
  });
});
