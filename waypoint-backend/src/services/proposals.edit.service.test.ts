import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError, NotFoundError } from '../middleware/errors.js';

// W5c: editProposalBody — a comment proposal's body may be changed by the
// person before they approve it; nothing else, and nothing once it has
// moved. Same mocked-Drizzle approach as the other proposals tests: this
// proves what is read under lock, what is written, and what is refused.
function chainable(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'set', 'for', 'leftJoin'];
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  chain.returning = vi.fn(() => Promise.resolve(resolvedValue));
  chain.then = (resolve: (value: unknown) => void) => resolve(resolvedValue);
  return chain;
}

const { db } = vi.hoisted(() => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../db/client.js', () => ({ db }));

vi.mock('./tickets.service.js');
vi.mock('./comments.service.js');
vi.mock('./states.service.js');
vi.mock('./members.service.js');
vi.mock('./projects.service.js');
vi.mock('./agentRuns.service.js');
vi.mock('../providers/jira.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/jira.js')>()),
  getJiraProvider: vi.fn(),
}));

const membersService = await import('./members.service.js');
const agentRunsService = await import('./agentRuns.service.js');
const { editProposalBody } = await import('./proposals.service.js');

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prop-abc1234',
    conversationId: 'conv-abc1234',
    kind: 'comment',
    ticketId: 'wi-1',
    payload: { body: 'The root cause is X.' },
    snapshot: { identifier: 'WI-1', title: 'A ticket', itemUpdatedAt: '2026-01-01T00:00:00.000Z' },
    anchorSeq: 7,
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    origin: 'agent_run',
    agentRunId: 'run-abc1234',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    modelNotifiedAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function txWith(row: unknown, written?: unknown) {
  const selectChain = chainable(row ? [row] : []);
  const updateChain = chainable(written ? [written] : []);
  const tx = {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
  };
  db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(tx));
  return { tx, selectChain, updateChain };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Second review round: editProposalBody now opens with
  // assertProposalInWorkspace's own db.select(...) guard, run before the
  // db.transaction() these tests already mock via txWith() — a separate
  // mock target, so it needs its own default here. None of these tests
  // are about workspace scoping (that's proven live, separately, in
  // workspaceScoping.integration.test.ts); this just lets every one of
  // them pass through the guard the way they already passed db.select for
  // every other purpose before this round.
  db.select.mockReturnValue(chainable([{ id: 'ws-guard-ok' }]));
  vi.mocked(membersService.getCurrentUser).mockResolvedValue({ displayName: 'Amaan' } as never);
  vi.mocked(agentRunsService.appendEvent).mockResolvedValue({} as never);
});

describe('editProposalBody (W5c)', () => {
  it('reads the row under lock, keeps the original body beside the new one, stamps editedAt, and notes the run', async () => {
    const row = proposalRow();
    const written = proposalRow({
      payload: { body: 'The root cause is Y.', originalBody: 'The root cause is X.', editedAt: 'x' },
    });
    const { selectChain, updateChain } = txWith(row, written);

    const view = await editProposalBody('prop-abc1234', 'The root cause is Y.');

    expect(selectChain.for).toHaveBeenCalledWith('update');
    const set = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      payload: { body: string; originalBody: string; editedAt: string };
    };
    expect(set.payload.body).toBe('The root cause is Y.');
    expect(set.payload.originalBody).toBe('The root cause is X.');
    expect(new Date(set.payload.editedAt).getTime()).toBeGreaterThan(0);
    expect(view.payload).toMatchObject({ body: 'The root cause is Y.' });
    // The disclosure is unchanged: still the session's proposal.
    expect(view.disclosureText).toContain('Waypoint session');
    expect(agentRunsService.appendEvent).toHaveBeenCalledWith('run-abc1234', {
      kind: 'note',
      payload: expect.objectContaining({ message: 'the comment was edited before posting', proposalId: 'prop-abc1234' }),
    });
  });

  it('a second edit keeps the first original, not the intermediate body', async () => {
    const row = proposalRow({
      payload: { body: 'second', originalBody: 'first', editedAt: '2026-01-02T00:00:00.000Z' },
    });
    const { updateChain } = txWith(row, row);
    await editProposalBody('prop-abc1234', 'third');
    const set = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as { payload: { originalBody: string } };
    expect(set.payload.originalBody).toBe('first');
  });

  it("a Copilot comment proposal (no run) is editable too, and no run note is written", async () => {
    const row = proposalRow({ origin: 'copilot', agentRunId: null });
    txWith(row, row);
    await editProposalBody('prop-abc1234', 'tweaked');
    expect(agentRunsService.appendEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['a state_change', proposalRow({ kind: 'state_change', payload: { stateId: 'st-1' } }), /Only a comment/],
    ['an executed comment', proposalRow({ status: 'executed' }), /executed proposal can no longer be edited/],
    ['a stale comment', proposalRow({ status: 'stale' }), /stale proposal can no longer be edited/],
  ])('refuses %s with a 409, writing nothing', async (_name, row, message) => {
    const { tx } = txWith(row);
    await expect(editProposalBody('prop-abc1234', 'x')).rejects.toThrow(ConflictError);
    await expect(editProposalBody('prop-abc1234', 'x')).rejects.toThrow(message);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('404s a missing proposal', async () => {
    txWith(null);
    await expect(editProposalBody('prop-missing', 'x')).rejects.toThrow(NotFoundError);
  });
});
