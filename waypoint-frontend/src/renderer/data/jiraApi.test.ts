// Each test gets its OWN fresh copy of this module via freshApi() below.
// jiraApi.ts's fixtures are plain mutable module-level state with no reset
// hook (unlike jiraStore.ts's resetJiraStoreForTests) — a transition, an
// approve, a dismiss all mutate arrays/objects in place, so tests that
// shared one module instance would leak state into each other depending on
// run order. jest.resetModules() + a fresh require() sidesteps that
// entirely, at the cost of losing static ES import ergonomics for this one
// file.
type JiraApiModule = typeof import('./jiraApi');

function freshApi(): JiraApiModule {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./jiraApi');
}

describe('jiraApi — per-project workflows', () => {
  it('GRW has no In Review state, unlike ENG and PLAT', async () => {
    const api = freshApi();
    const grw12 = (await api.listMyJiraTickets()).find((t) => t.key === 'GRW-12')!;
    const transitions = await api.getJiraTransitions(grw12.id);
    expect(transitions.map((t) => t.targetStateName)).toEqual(['In Progress', 'Done']);
  });

  it('ENG requires a Resolution (and offers an optional Time spent) to reach Done, but not to reach In Review', async () => {
    const api = freshApi();
    const eng421 = (await api.listMyJiraTickets()).find((t) => t.key === 'ENG-421')!;
    const transitions = await api.getJiraTransitions(eng421.id);

    const toReview = transitions.find((t) => t.targetStateName === 'In Review');
    const toDone = transitions.find((t) => t.targetStateName === 'Done');
    expect(toReview?.requiresFields).toEqual([]);
    expect(toDone?.requiresFields.map((f) => f.key)).toEqual(['resolution', 'timeSpent']);
    expect(toDone?.requiresFields.find((f) => f.key === 'resolution')?.required).toBe(true);
    expect(toDone?.requiresFields.find((f) => f.key === 'timeSpent')?.required).toBe(false);
  });

  it('GRW requires a Resolution to reach Done directly from To Do, unlike ENG', async () => {
    const api = freshApi();
    const grw12 = (await api.listMyJiraTickets()).find((t) => t.key === 'GRW-12')!;
    const transitions = await api.getJiraTransitions(grw12.id);
    const toDone = transitions.find((t) => t.targetStateName === 'Done');
    expect(toDone?.requiresFields.map((f) => f.key)).toEqual(['resolution']);
  });

  it('PLAT requires a Resolution on Done from In Review too, unlike ENG which only requires it from In Progress', async () => {
    const api = freshApi();
    const plat88 = (await api.listMyJiraTickets()).find((t) => t.key === 'PLAT-88')!;
    const fromInProgress = await api.getJiraTransitions(plat88.id);
    const toInReview = fromInProgress.find((t) => t.targetStateName === 'In Review')!;

    await api.transitionJiraTicket(plat88.id, toInReview.id, {});

    const fromInReview = await api.getJiraTransitions(plat88.id);
    const toDone = fromInReview.find((t) => t.targetStateName === 'Done');
    expect(toDone?.requiresFields.map((f) => f.key)).toEqual(['resolution', 'timeSpent']);
  });

  it('transitionJiraTicket rejects a transition missing a required field, and never mutates the ticket', async () => {
    const api = freshApi();
    const eng421 = (await api.listMyJiraTickets()).find((t) => t.key === 'ENG-421')!;
    const transitions = await api.getJiraTransitions(eng421.id);
    const toDone = transitions.find((t) => t.targetStateName === 'Done')!;

    await expect(api.transitionJiraTicket(eng421.id, toDone.id, {})).rejects.toThrow('Resolution is required');

    const stillUnchanged = await api.getJiraTicket(eng421.id);
    expect(stillUnchanged?.stateName).toBe('In Progress');
  });

  it('transitionJiraTicket succeeds once the required field is supplied', async () => {
    const api = freshApi();
    const eng421 = (await api.listMyJiraTickets()).find((t) => t.key === 'ENG-421')!;
    const transitions = await api.getJiraTransitions(eng421.id);
    const toDone = transitions.find((t) => t.targetStateName === 'Done')!;

    const updated = await api.transitionJiraTicket(eng421.id, toDone.id, { resolution: 'Fixed' });
    expect(updated.stateName).toBe('Done');
  });
});

describe('jiraApi — tombstone and conflict', () => {
  it('dismissJiraTombstone removes the ticket from the list entirely', async () => {
    const api = freshApi();
    const before = await api.listMyJiraTickets();
    const tomb = before.find((t) => t.isTombstoned)!;

    await api.dismissJiraTombstone(tomb.id);

    const after = await api.listMyJiraTickets();
    expect(after.find((t) => t.id === tomb.id)).toBeUndefined();
  });

  it('resolveJiraConflict clears the conflict and adopts the remote state', async () => {
    const api = freshApi();
    const before = await api.listMyJiraTickets();
    const conflicted = before.find((t) => t.hasConflict)!;

    const resolved = await api.resolveJiraConflict(conflicted.id);

    expect(resolved.hasConflict).toBe(false);
    expect(resolved.conflict).toBeNull();
    expect(resolved.stateName).toBe('In Review');
  });
});

describe('jiraApi — connection lifecycle', () => {
  it('starts disconnected (the wizard is now the real path to a connected state)', async () => {
    const api = freshApi();
    const status = await api.getJiraConnectionStatus();
    expect(status.connected).toBe(false);
  });

  it('connectJira / disconnectJira flip the connected flag', async () => {
    const api = freshApi();
    const connected = await api.connectJira();
    expect(connected.connected).toBe(true);

    await api.disconnectJira();
    const after = await api.getJiraConnectionStatus();
    expect(after.connected).toBe(false);
  });

  it('refreshJiraSync bumps lastSyncAt without changing connected state', async () => {
    const api = freshApi();
    await api.connectJira();
    const before = await api.getJiraConnectionStatus();

    const refreshed = await api.refreshJiraSync();

    expect(refreshed.connected).toBe(true);
    expect(new Date(refreshed.lastSyncAt).getTime()).toBeGreaterThanOrEqual(new Date(before.lastSyncAt).getTime());
  });

  it('setJiraSyncPaused persists the paused flag independently of connected', async () => {
    const api = freshApi();
    const initial = await api.getJiraConnectionStatus();
    expect(initial.paused).toBe(false);

    const paused = await api.setJiraSyncPaused(true);
    expect(paused.paused).toBe(true);

    const resumed = await api.setJiraSyncPaused(false);
    expect(resumed.paused).toBe(false);
  });

  it('issueCount/projectCount are recomputed live from the ticket list (excluding tombstones), not hardcoded', async () => {
    const api = freshApi();
    const tickets = await api.listMyJiraTickets();
    const live = tickets.filter((t) => !t.isTombstoned);

    const status = await api.getJiraConnectionStatus();

    expect(status.issueCount).toBe(live.length);
    expect(status.projectCount).toBe(new Set(live.map((t) => t.projectKey)).size);
  });
});

describe('jiraApi — the Copilot rail proposal', () => {
  it('getMyJiraProposal returns the ENG-421 fixture, pending', async () => {
    const api = freshApi();
    const proposal = await api.getMyJiraProposal();
    expect(proposal?.ticketKey).toBe('ENG-421');
    expect(proposal?.status).toBe('proposed');
    expect(proposal?.fromStateName).toBe('In Progress');
    expect(proposal?.toStateName).toBe('In Review');
  });

  it('approveJiraProposal moves the ticket AND appends a disclosed comment, atomically', async () => {
    const api = freshApi();
    const proposal = await api.getMyJiraProposal();

    const approved = await api.approveJiraProposal(proposal!.id);
    expect(approved.status).toBe('executed');
    expect(approved.resolvedAt).not.toBeNull();

    const ticket = await api.getJiraTicket(proposal!.ticketId);
    expect(ticket?.stateName).toBe('In Review');

    const comments = await api.listJiraComments(proposal!.ticketId);
    const posted = comments.find((c) => c.disclosureText != null);
    expect(posted?.disclosureText).toContain('Written by Waypoint Copilot');
    expect(posted?.body).toBe(proposal!.commentBody);
    expect(posted?.mentions).toEqual(['Priya Raman']);
  });

  it('rejectJiraProposal marks it rejected without touching the ticket or posting a comment', async () => {
    const api = freshApi();
    const proposal = await api.getMyJiraProposal();
    const before = await api.getJiraTicket(proposal!.ticketId);
    const commentsBefore = await api.listJiraComments(proposal!.ticketId);

    const rejected = await api.rejectJiraProposal(proposal!.id);

    expect(rejected.status).toBe('rejected');
    const after = await api.getJiraTicket(proposal!.ticketId);
    expect(after?.stateName).toBe(before?.stateName);
    const commentsAfter = await api.listJiraComments(proposal!.ticketId);
    expect(commentsAfter).toHaveLength(commentsBefore.length);
  });

  it('approveJiraProposal / rejectJiraProposal reject an unknown id', async () => {
    const api = freshApi();
    await expect(api.approveJiraProposal('nope')).rejects.toThrow('Unknown Jira proposal');
    await expect(api.rejectJiraProposal('nope')).rejects.toThrow('Unknown Jira proposal');
  });
});

describe('jiraApi — the "Also queued" duplicate nudge', () => {
  it('getJiraDuplicateNudge points at the real GRW-12 ticket, not a synthetic row', async () => {
    const api = freshApi();
    const nudge = await api.getJiraDuplicateNudge();
    expect(nudge?.ticketKey).toBe('GRW-12');
    expect(nudge?.duplicateOfKey).toBe('GRW-9');

    const ticket = await api.getJiraTicket(nudge!.ticketId);
    expect(ticket?.key).toBe('GRW-12');
  });

  it('dismissJiraDuplicateNudge makes it disappear for good', async () => {
    const api = freshApi();
    const nudge = await api.getJiraDuplicateNudge();

    await api.dismissJiraDuplicateNudge(nudge!.id);

    expect(await api.getJiraDuplicateNudge()).toBeUndefined();
  });
});
