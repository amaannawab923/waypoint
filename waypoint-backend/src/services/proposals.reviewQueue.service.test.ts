import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '../middleware/errors.js';

// New test file for the W3.2/W3.3 additions to proposals.service.ts (the
// review queue, its counts, bulk approve/reject, and the extracted repair
// pass) — kept separate from proposals.service.test.ts so that file stays
// exactly what its own accept criterion requires: unmodified except for the
// copilot_proposals -> proposals table rename. Same mocked-Drizzle approach
// as that file: these verify THIS service's query shape and orchestration,
// not real Postgres behavior.
function chainable(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'set'];
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

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn(actual.eq),
    and: vi.fn(actual.and),
    or: vi.fn(actual.or),
    lt: vi.fn(actual.lt),
    gte: vi.fn(actual.gte),
    desc: vi.fn(actual.desc),
    asc: vi.fn(actual.asc),
    count: vi.fn(actual.count),
    inArray: vi.fn(actual.inArray),
    isNull: vi.fn(actual.isNull),
  };
});

vi.mock('./tickets.service.js');
vi.mock('./comments.service.js');
vi.mock('./states.service.js');
vi.mock('./members.service.js');
vi.mock('./projects.service.js');

const { proposals } = await import('../db/schema/index.js');
const ticketsService = await import('./tickets.service.js');
const commentsService = await import('./comments.service.js');
const membersService = await import('./members.service.js');
const {
  repairProposals,
  maybeRepairProposals,
  listReviewQueue,
  getProposalCounts,
  bulkApproveProposals,
  bulkRejectProposals,
  listProposalsForTicket,
} = await import('./proposals.service.js');
const { eq, and } = await import('drizzle-orm');

type Vfn = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(membersService.getCurrentUser).mockResolvedValue({ displayName: 'Amaan' } as never);
});

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prop-abc1234',
    origin: 'copilot',
    conversationId: 'conv-abc1234',
    anchorSeq: 7,
    agentRunId: null,
    agentId: null,
    projectId: 'proj-1',
    sourceRequestId: null,
    kind: 'comment',
    ticketId: 'wi-1',
    payload: { body: 'hello' },
    snapshot: { identifier: 'WI-1', title: 'A ticket' },
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    modelNotifiedAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    decidedBy: null,
    trustGrantId: null,
    decisionLatencyMs: null,
    ...overrides,
  };
}

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wi-1',
    projectId: 'proj-1',
    identifier: 'WI-1',
    title: 'A ticket',
    stateId: 'st-progress',
    priority: 'medium',
    isDraft: false,
    assigneeIds: [] as string[],
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// repairProposals / maybeRepairProposals — run FIRST in this file: these
// tests deliberately advance the module-level rate-limit state that later
// describe blocks below rely on being already "warm" (see the comment on
// listReviewQueue's describe block).
// ---------------------------------------------------------------------------

describe('repairProposals', () => {
  it('expires overdue proposed rows and parks stuck executing claims, workspace-wide (no conversation scoping)', async () => {
    const expireChain = chainable(undefined);
    const reviveChain = chainable(undefined);
    db.update.mockReturnValueOnce(expireChain).mockReturnValueOnce(reviveChain);

    await repairProposals();

    expect(db.update).toHaveBeenCalledTimes(2);
    const expireSet = (expireChain.set as Vfn).mock.calls[0][0];
    expect(expireSet.status).toBe('expired');
    const reviveSet = (reviveChain.set as Vfn).mock.calls[0][0];
    expect(reviveSet.status).toBe('stale');
    expect(eq).toHaveBeenCalledWith(proposals.status, 'proposed');
    expect(eq).toHaveBeenCalledWith(proposals.status, 'executing');
    // Exactly two conditions per pass (status + the time bound) — no
    // conversationId condition, unlike the old per-call repair.
    const expireAnd = (and as unknown as Vfn).mock.calls.find((c) => c.length === 2);
    expect(expireAnd).toBeDefined();
  });
});

describe('maybeRepairProposals', () => {
  it('runs the repair pass on the first call and skips a second call within the same minute', async () => {
    db.update
      .mockReturnValueOnce(chainable(undefined))
      .mockReturnValueOnce(chainable(undefined));

    await maybeRepairProposals();
    expect(db.update).toHaveBeenCalledTimes(2);

    await maybeRepairProposals();
    // Rate-limited: no additional update calls from the second invocation.
    expect(db.update).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// getProposalCounts / listReviewQueue — by the time these run, the tests
// above already set the module's "last repaired at" timestamp, so
// listReviewQueue's internal maybeRepairProposals() call is a no-op here
// (no db.update calls to mock for it).
// ---------------------------------------------------------------------------

describe('getProposalCounts', () => {
  it('counts proposed and recently-resolved (last 24h) rows, with blocked stubbed to 0', async () => {
    db.select
      .mockReturnValueOnce(chainable([{ n: 4 }]))
      .mockReturnValueOnce(chainable([{ n: 9 }]));

    const counts = await getProposalCounts();

    expect(counts).toEqual({ proposed: 4, blocked: 0, recent: 9 });
  });
});

describe('listReviewQueue', () => {
  it('proposed segment: filters by status=proposed plus optional agentId/projectId/kind', async () => {
    db.select
      .mockReturnValueOnce(chainable([{ n: 1 }])) // counts: proposed
      .mockReturnValueOnce(chainable([{ n: 0 }])) // counts: recent
      .mockReturnValueOnce(chainable([proposalRow()])); // the page itself

    const result = await listReviewQueue({ status: 'proposed', agentId: 'agent-1', projectId: 'proj-1' });

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].id).toBe('prop-abc1234');
    expect(result.counts).toEqual({ proposed: 1, blocked: 0, recent: 0 });
    expect(eq).toHaveBeenCalledWith(proposals.status, 'proposed');
    expect(eq).toHaveBeenCalledWith(proposals.agentId, 'agent-1');
    expect(eq).toHaveBeenCalledWith(proposals.projectId, 'proj-1');
    expect(result.nextCursor).toBeNull();
  });

  it('recent segment: resolved in the last 24h, terminal statuses only (not executing)', async () => {
    const { inArray, gte } = await import('drizzle-orm');
    db.select
      .mockReturnValueOnce(chainable([{ n: 0 }]))
      .mockReturnValueOnce(chainable([{ n: 1 }]))
      .mockReturnValueOnce(chainable([proposalRow({ status: 'executed', resolvedAt: new Date() })]));

    const result = await listReviewQueue({ status: 'recent' });

    expect(result.proposals).toHaveLength(1);
    expect(vi.mocked(inArray)).toHaveBeenCalledWith(
      proposals.status,
      expect.arrayContaining(['executed', 'rejected', 'stale', 'expired', 'superseded', 'reverted']),
    );
    // 'executing' must never appear in the terminal-status list — a row
    // mid-claim is not "recent", it's still pending.
    const terminalCall = vi.mocked(inArray).mock.calls.find((c) => c[0] === proposals.status);
    expect(terminalCall?.[1]).not.toContain('executing');
    expect(vi.mocked(gte)).toHaveBeenCalledWith(proposals.resolvedAt, expect.any(Date));
  });

  it('blocked segment: returns an empty array without querying agent_runs (which does not exist)', async () => {
    db.select
      .mockReturnValueOnce(chainable([{ n: 2 }]))
      .mockReturnValueOnce(chainable([{ n: 0 }]));

    const result = await listReviewQueue({ status: 'blocked' });

    expect(result.proposals).toEqual([]);
    expect(result.counts).toEqual({ proposed: 2, blocked: 0, recent: 0 });
    // Only the two count queries ran — no third select for a page.
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('paginates with a keyset cursor and reports nextCursor only when a further page exists', async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      proposalRow({ id: `prop-${i}`, createdAt: new Date(2026, 0, i + 1) }),
    );
    db.select
      .mockReturnValueOnce(chainable([{ n: 3 }]))
      .mockReturnValueOnce(chainable([{ n: 0 }]))
      .mockReturnValueOnce(chainable(rows)); // limit+1 = 3 returned for a limit of 2

    const result = await listReviewQueue({ status: 'proposed', limit: 2 });

    expect(result.proposals).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();

    // Round-trips through decodeCursor without throwing on the next call.
    db.select
      .mockReturnValueOnce(chainable([{ n: 3 }]))
      .mockReturnValueOnce(chainable([{ n: 0 }]))
      .mockReturnValueOnce(chainable([]));
    const nextPage = await listReviewQueue({ status: 'proposed', limit: 2, cursor: result.nextCursor! });
    expect(nextPage.proposals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// bulkApproveProposals / bulkRejectProposals
// ---------------------------------------------------------------------------

describe('bulkApproveProposals', () => {
  it('mixed batch: a still-pending id executes, an already-stale id is echoed, both results returned', async () => {
    // First id ("prop-live"): claim succeeds, executes as a comment.
    const claimChain = chainable([proposalRow({ id: 'prop-live', status: 'executing' })]);
    const finalizeChain = chainable([proposalRow({ id: 'prop-live', status: 'executed' })]);
    // Second id ("prop-stale"): claim UPDATE matches nothing (row is
    // already 'stale'), falls through to the idempotent-echo select.
    const failedClaimChain = chainable([]);
    const staleEcho = chainable([
      proposalRow({ id: 'prop-stale', status: 'stale', statusReason: 'was already stale' }),
    ]);

    db.update
      .mockReturnValueOnce(claimChain)
      .mockReturnValueOnce(finalizeChain)
      .mockReturnValueOnce(failedClaimChain);
    db.select.mockReturnValueOnce(staleEcho);
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket() as never);
    vi.mocked(commentsService.addComment).mockResolvedValue({ id: 'cm-1' } as never);

    const results = await bulkApproveProposals(['prop-live', 'prop-stale']);

    expect(results).toEqual([
      { id: 'prop-live', status: 'executed', statusReason: null },
      { id: 'prop-stale', status: 'stale', statusReason: 'was already stale' },
    ]);
    // The valid one actually executed — the underlying service call ran.
    expect(commentsService.addComment).toHaveBeenCalledTimes(1);
  });

  it('a nonexistent id resolves as not_found and the rest of the batch still runs', async () => {
    db.update.mockReturnValueOnce(chainable([])); // claim fails
    db.select.mockReturnValueOnce(chainable([])); // and there's no row at all

    const claimChain = chainable([proposalRow({ id: 'prop-live', status: 'executing' })]);
    const finalizeChain = chainable([proposalRow({ id: 'prop-live', status: 'executed' })]);
    db.update.mockReturnValueOnce(claimChain).mockReturnValueOnce(finalizeChain);
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket() as never);
    vi.mocked(commentsService.addComment).mockResolvedValue({ id: 'cm-1' } as never);

    const results = await bulkApproveProposals(['prop-missing', 'prop-live']);

    expect(results[0]).toEqual({ id: 'prop-missing', status: 'not_found', statusReason: 'proposal not found' });
    expect(results[1].status).toBe('executed');
  });
});

describe('bulkRejectProposals', () => {
  it('rejects each id via the existing single-row rejectProposal', async () => {
    const rejectChain = chainable([proposalRow({ id: 'prop-1', status: 'rejected' })]);
    db.update.mockReturnValueOnce(rejectChain);

    const results = await bulkRejectProposals(['prop-1']);

    expect(results).toEqual([{ id: 'prop-1', status: 'rejected', statusReason: null }]);
  });
});

// ---------------------------------------------------------------------------
// listProposalsForTicket
// ---------------------------------------------------------------------------

describe('listProposalsForTicket', () => {
  it('scopes to the ticket, optionally filtered by status', async () => {
    db.select.mockReturnValueOnce(chainable([proposalRow()]));

    const views = await listProposalsForTicket('wi-1', 'proposed');

    expect(views).toHaveLength(1);
    expect(eq).toHaveBeenCalledWith(proposals.ticketId, 'wi-1');
    expect(eq).toHaveBeenCalledWith(proposals.status, 'proposed');
  });

  it('with no status filter, only scopes to the ticket', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    await listProposalsForTicket('wi-1');

    expect(eq).toHaveBeenCalledWith(proposals.ticketId, 'wi-1');
    expect(eq).not.toHaveBeenCalledWith(proposals.status, expect.anything());
  });
});
