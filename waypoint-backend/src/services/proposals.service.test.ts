import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '../middleware/errors.js';

// Same mocked-Drizzle approach as copilot.service.test.ts: these tests
// verify THIS service's own logic — which methods run, with what columns
// and conditions, in what order, and crucially which underlying service
// functions do or do NOT execute — not real Postgres behavior. The claim
// UPDATE's actual serialization under concurrency is a database property
// the mocks cannot prove; what they CAN prove is that the claim carries the
// exact WHERE (id AND status='proposed') that makes it correct.
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

// Spies wrapping the REAL drizzle helpers (not fakes) — asserting the
// column/value actually passed to eq()/and()/inArray() is what
// distinguishes e.g. a claim conditioned on status='proposed' from one
// conditioned on nothing (the single-execution bug this design exists to
// prevent). See copilot.service.test.ts for the mutation-test history
// behind this pattern.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn(actual.eq),
    and: vi.fn(actual.and),
    lt: vi.fn(actual.lt),
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

const { copilotProposals, copilotConversations } = await import('../db/schema/index.js');
const ticketsService = await import('./tickets.service.js');
const commentsService = await import('./comments.service.js');
const statesService = await import('./states.service.js');
const membersService = await import('./members.service.js');
const projectsService = await import('./projects.service.js');
const {
  createProposal,
  listProposals,
  approveProposal,
  rejectProposal,
  rejectAllPending,
  markProposalsNotified,
  ProposalValidationError,
  PROPOSAL_TTL_MS,
} = await import('./proposals.service.js');
const { eq, and, inArray, isNull } = await import('drizzle-orm');

type Vfn = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(membersService.getCurrentUser).mockResolvedValue({ displayName: 'Amaan' } as never);
});

// ---------------------------------------------------------------------------
// createProposal
// ---------------------------------------------------------------------------

// createProposal's transaction runs, in order: conversation existence
// select, max(seq) select, per-turn count select, pending count select —
// then (for superseding kinds) one update — then the insert.
function makeCreateTx({
  conversationExists = true,
  maxSeq = '7' as string | number | null,
  turnCount = 0,
  pendingCount = 0,
  insertedRow = { id: 'prop-abc1234' },
} = {}) {
  const selectResults = [
    conversationExists ? [{ id: 'conv-abc1234' }] : [],
    [{ maxSeq }],
    [{ n: turnCount }],
    [{ n: pendingCount }],
  ];
  let selectCall = 0;
  const selectChains: ReturnType<typeof chainable>[] = [];
  const tx = {
    select: vi.fn(() => {
      const chain = chainable(selectResults[selectCall++] ?? []);
      selectChains.push(chain);
      return chain;
    }),
    update: vi.fn(() => chainable(undefined)),
    insert: vi.fn(() => chainable([insertedRow])),
  };
  db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(tx));
  return tx;
}

const COMMENT_INPUT = {
  conversationId: 'conv-abc1234',
  kind: 'comment' as const,
  ticketId: 'wi-1',
  payload: { body: 'hello' },
  snapshot: { identifier: 'WI-1', title: 'A ticket', itemUpdatedAt: '2026-01-01T00:00:00.000Z' },
};

describe('createProposal', () => {
  it('inserts a prop- id row with the computed anchorSeq, stored payload/snapshot, and a ~24h expiresAt', async () => {
    const tx = makeCreateTx({ maxSeq: '7' });
    const before = Date.now();

    const result = await createProposal(COMMENT_INPUT);

    expect(tx.insert).toHaveBeenCalledWith(copilotProposals);
    const values = (tx.insert.mock.results[0].value.values as Vfn).mock.calls[0][0];
    expect(values.id).toMatch(/^prop-/);
    expect(values).toMatchObject({
      conversationId: 'conv-abc1234',
      kind: 'comment',
      ticketId: 'wi-1',
      payload: { body: 'hello' },
      snapshot: COMMENT_INPUT.snapshot,
      // max(seq) came back as the string '7' (postgres-js bigint behavior)
      // — the stored anchor must be the NUMBER 7.
      anchorSeq: 7,
    });
    const drift = values.expiresAt.getTime() - (before + PROPOSAL_TTL_MS);
    expect(Math.abs(drift)).toBeLessThan(5_000);
    expect(result).toEqual({ id: 'prop-abc1234' });
  });

  it('anchors at seq 0 for a conversation with no messages yet', async () => {
    const tx = makeCreateTx({ maxSeq: null });

    await createProposal(COMMENT_INPUT);

    const values = (tx.insert.mock.results[0].value.values as Vfn).mock.calls[0][0];
    expect(values.anchorSeq).toBe(0);
  });

  it('throws NotFoundError (and inserts nothing) for a bogus conversation id', async () => {
    const tx = makeCreateTx({ conversationExists: false });

    await expect(createProposal(COMMENT_INPUT)).rejects.toThrow(NotFoundError);
    expect(eq).toHaveBeenCalledWith(copilotConversations.id, 'conv-abc1234');
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('accepts the 10th proposal of a turn (9 existing) but rejects the 11th (10 existing), without inserting', async () => {
    const tenth = makeCreateTx({ turnCount: 9 });
    await createProposal(COMMENT_INPUT);
    expect(tenth.insert).toHaveBeenCalledTimes(1);

    const eleventh = makeCreateTx({ turnCount: 10 });
    const error = await createProposal(COMMENT_INPUT).then(
      () => null,
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(ProposalValidationError);
    expect(error?.message).toMatch(/Too many proposals this turn \(max 10\)/);
    expect(eleventh.insert).not.toHaveBeenCalled();
    // The turn cap counts rows sharing this proposal's own (conversation,
    // anchorSeq) — i.e. this turn, not the whole conversation.
    expect(eq).toHaveBeenCalledWith(copilotProposals.anchorSeq, 7);
  });

  it('rejects the 21st pending proposal in a conversation, counting only proposed rows', async () => {
    const tx = makeCreateTx({ pendingCount: 20 });

    await expect(
      createProposal(COMMENT_INPUT).catch((e) => Promise.reject(e.message)),
    ).rejects.toMatch(/Too many pending proposals in this conversation \(max 20\)/);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith(copilotProposals.status, 'proposed');
  });

  it('supersedes a pending state_change on the same (conversation, ticket, kind) — and only proposed rows', async () => {
    const tx = makeCreateTx();

    await createProposal({
      conversationId: 'conv-abc1234',
      kind: 'state_change',
      ticketId: 'wi-1',
      payload: { stateId: 'st-done' },
      snapshot: {},
    });

    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledWith(copilotProposals);
    const setArgs = (tx.update.mock.results[0].value.set as Vfn).mock.calls[0][0];
    expect(setArgs).toMatchObject({ status: 'superseded' });
    expect(setArgs.resolvedAt).toBeInstanceOf(Date);
    // Row-level condition assertions: exactly the four columns that define
    // "the same pending proposal", nothing broader.
    expect(eq).toHaveBeenCalledWith(copilotProposals.conversationId, 'conv-abc1234');
    expect(eq).toHaveBeenCalledWith(copilotProposals.ticketId, 'wi-1');
    expect(eq).toHaveBeenCalledWith(copilotProposals.kind, 'state_change');
    expect(eq).toHaveBeenCalledWith(copilotProposals.status, 'proposed');
  });

  it('supersede for assignee_change additionally matches the payload assigneeId (five conditions, not four)', async () => {
    makeCreateTx();

    await createProposal({
      conversationId: 'conv-abc1234',
      kind: 'assignee_change',
      ticketId: 'wi-1',
      payload: { assigneeId: 'mem-2', action: 'add' },
      snapshot: {},
    });

    // The supersede WHERE is the and() built from the per-row conditions —
    // for assignee_change it must carry the extra payload->>'assigneeId'
    // sql fragment on top of state_change's four column equalities.
    const supersedeAnd = (and as unknown as Vfn).mock.calls.find((c) => c.length === 5);
    expect(supersedeAnd).toBeDefined();
  });

  it('never supersedes for comment proposals — several comments can coexist', async () => {
    const tx = makeCreateTx();

    await createProposal(COMMENT_INPUT);

    expect(tx.update).not.toHaveBeenCalled();
  });

  it('never supersedes for create_work_item proposals', async () => {
    const tx = makeCreateTx();

    await createProposal({
      conversationId: 'conv-abc1234',
      kind: 'create_work_item',
      ticketId: null,
      payload: { projectId: 'proj-1', title: 'New', stateId: 'st-1' },
      snapshot: {},
    });

    expect(tx.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// approveProposal
// ---------------------------------------------------------------------------

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prop-abc1234',
    conversationId: 'conv-abc1234',
    kind: 'comment',
    ticketId: 'wi-1',
    payload: { body: 'hello <script>alert(1)</script>' },
    snapshot: { identifier: 'WI-1', title: 'A ticket', itemUpdatedAt: '2026-01-01T00:00:00.000Z' },
    anchorSeq: 7,
    status: 'executing',
    statusReason: null,
    resultInfo: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    modelNotifiedAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
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

describe('approveProposal', () => {
  it('claims via a conditional UPDATE — WHERE id AND status=proposed — before anything executes', async () => {
    const claimChain = chainable([proposalRow()]);
    const finalizeChain = chainable([proposalRow({ status: 'executed' })]);
    db.update.mockReturnValueOnce(claimChain).mockReturnValueOnce(finalizeChain);
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket() as never);
    vi.mocked(commentsService.addComment).mockResolvedValue({ id: 'cm-1' } as never);

    await approveProposal('prop-abc1234');

    const claimSet = (claimChain.set as Vfn).mock.calls[0][0];
    expect(claimSet.status).toBe('executing');
    // The claim's WHERE is the whole single-execution guarantee.
    expect(eq).toHaveBeenCalledWith(copilotProposals.id, 'prop-abc1234');
    expect(eq).toHaveBeenCalledWith(copilotProposals.status, 'proposed');
    expect(and).toHaveBeenCalled();
  });

  it('is idempotent: an already-executed row (claim matches nothing) is echoed with the service NOT called again', async () => {
    db.update.mockReturnValueOnce(chainable([]));
    db.select.mockReturnValueOnce(
      chainable([proposalRow({ status: 'executed', resultInfo: { commentId: 'cm-1' } })]),
    );

    const view = await approveProposal('prop-abc1234');

    expect(view.status).toBe('executed');
    expect(view.resultInfo).toEqual({ commentId: 'cm-1' });
    expect(commentsService.addComment).not.toHaveBeenCalled();
    expect(ticketsService.updateTicket).not.toHaveBeenCalled();
    // Exactly one update ever ran — the failed claim; nothing re-finalized.
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundError when the proposal does not exist at all', async () => {
    db.update.mockReturnValueOnce(chainable([]));
    db.select.mockReturnValueOnce(chainable([]));

    await expect(approveProposal('prop-missing')).rejects.toThrow(NotFoundError);
  });

  it('finalizes an expired claim as expired without executing', async () => {
    db.update
      .mockReturnValueOnce(chainable([proposalRow({ expiresAt: new Date(Date.now() - 1000) })]))
      .mockReturnValueOnce(chainable([proposalRow({ status: 'expired' })]));

    const view = await approveProposal('prop-abc1234');

    expect(view.status).toBe('expired');
    expect(commentsService.addComment).not.toHaveBeenCalled();
    const finalizeSet = ((db.update.mock.results[1].value as ReturnType<typeof chainable>).set as Vfn)
      .mock.calls[0][0];
    expect(finalizeSet).toMatchObject({ status: 'expired' });
    expect(finalizeSet.statusReason).toMatch(/expired/i);
  });

  // Staleness matrix — every branch must finalize as stale WITH a reason
  // and must never reach the underlying service function.
  describe('staleness re-checks (fresh reads at approve, execution skipped)', () => {
    function claimThenFinalize(claimed: Record<string, unknown>) {
      const finalizeChain = chainable([proposalRow({ ...claimed, status: 'stale' })]);
      db.update.mockReturnValueOnce(chainable([proposalRow(claimed)])).mockReturnValueOnce(finalizeChain);
      return finalizeChain;
    }

    function expectFinalizedStale(finalizeChain: ReturnType<typeof chainable>, reasonPattern: RegExp) {
      const setArgs = (finalizeChain.set as Vfn).mock.calls[0][0];
      expect(setArgs.status).toBe('stale');
      expect(setArgs.statusReason).toMatch(reasonPattern);
      expect(setArgs.resolvedAt).toBeInstanceOf(Date);
    }

    it('comment: a deleted ticket is stale', async () => {
      const finalize = claimThenFinalize({ kind: 'comment' });
      vi.mocked(ticketsService.getTicket).mockResolvedValue(undefined as never);

      const view = await approveProposal('prop-abc1234');

      expect(view.status).toBe('stale');
      expect(commentsService.addComment).not.toHaveBeenCalled();
      expectFinalizedStale(finalize, /no longer available/);
    });

    it('comment: a ticket hidden as a draft is stale, same as missing', async () => {
      const finalize = claimThenFinalize({ kind: 'comment' });
      vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket({ isDraft: true }) as never);

      await approveProposal('prop-abc1234');

      expect(commentsService.addComment).not.toHaveBeenCalled();
      expectFinalizedStale(finalize, /no longer available/);
    });

    it('state_change: the ticket having moved off the snapshotted fromStateId is stale', async () => {
      const finalize = claimThenFinalize({
        kind: 'state_change',
        payload: { stateId: 'st-done' },
        snapshot: { fromStateId: 'st-progress' },
      });
      vi.mocked(ticketsService.getTicket).mockResolvedValue(
        ticket({ stateId: 'st-review' }) as never,
      );

      await approveProposal('prop-abc1234');

      expect(ticketsService.updateTicket).not.toHaveBeenCalled();
      expectFinalizedStale(finalize, /changed since Copilot proposed this/);
    });

    it('state_change: a target state deleted from the project since propose time is stale', async () => {
      const finalize = claimThenFinalize({
        kind: 'state_change',
        payload: { stateId: 'st-done' },
        snapshot: { fromStateId: 'st-progress' },
      });
      vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket() as never);
      vi.mocked(statesService.listStates).mockResolvedValue([{ id: 'st-progress' }] as never);

      await approveProposal('prop-abc1234');

      expect(ticketsService.updateTicket).not.toHaveBeenCalled();
      expectFinalizedStale(finalize, /target state no longer exists/);
    });

    it('priority_change: a priority changed since the snapshot is stale', async () => {
      const finalize = claimThenFinalize({
        kind: 'priority_change',
        payload: { priority: 'urgent' },
        snapshot: { fromPriority: 'medium' },
      });
      vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket({ priority: 'high' }) as never);

      await approveProposal('prop-abc1234');

      expect(ticketsService.updateTicket).not.toHaveBeenCalled();
      expectFinalizedStale(finalize, /changed since Copilot proposed this/);
    });

    it('assignee_change add: already assigned is stale — the toggle must never silently remove', async () => {
      const finalize = claimThenFinalize({
        kind: 'assignee_change',
        payload: { assigneeId: 'mem-2', action: 'add' },
        snapshot: {},
      });
      vi.mocked(ticketsService.getTicket).mockResolvedValue(
        ticket({ assigneeIds: ['mem-2'] }) as never,
      );

      await approveProposal('prop-abc1234');

      expect(ticketsService.toggleTicketAssignee).not.toHaveBeenCalled();
      expectFinalizedStale(finalize, /already assigned/);
    });

    it('assignee_change remove: not currently assigned is stale — the toggle must never silently add', async () => {
      const finalize = claimThenFinalize({
        kind: 'assignee_change',
        payload: { assigneeId: 'mem-2', action: 'remove' },
        snapshot: {},
      });
      vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket({ assigneeIds: [] }) as never);

      await approveProposal('prop-abc1234');

      expect(ticketsService.toggleTicketAssignee).not.toHaveBeenCalled();
      expectFinalizedStale(finalize, /not currently assigned/);
    });

    it('create_work_item: a deleted project is stale', async () => {
      const finalize = claimThenFinalize({
        kind: 'create_work_item',
        ticketId: null,
        payload: { projectId: 'proj-1', title: 'New', stateId: 'st-1' },
        snapshot: {},
      });
      vi.mocked(projectsService.getProject).mockResolvedValue(undefined as never);

      await approveProposal('prop-abc1234');

      expect(ticketsService.createTicket).not.toHaveBeenCalled();
      expectFinalizedStale(finalize, /project is no longer available/);
    });

    it('create_work_item: the resolved default state having been deleted is stale', async () => {
      const finalize = claimThenFinalize({
        kind: 'create_work_item',
        ticketId: null,
        payload: { projectId: 'proj-1', title: 'New', stateId: 'st-gone' },
        snapshot: {},
      });
      vi.mocked(projectsService.getProject).mockResolvedValue({ id: 'proj-1' } as never);
      vi.mocked(statesService.listStates).mockResolvedValue([{ id: 'st-1' }] as never);

      await approveProposal('prop-abc1234');

      expect(ticketsService.createTicket).not.toHaveBeenCalled();
      expectFinalizedStale(finalize, /state no longer exists/);
    });
  });

  it('executes an approved comment with the disclosure-prefixed, entity-escaped html — script tags neutered', async () => {
    const finalizeChain = chainable([proposalRow({ status: 'executed' })]);
    db.update.mockReturnValueOnce(chainable([proposalRow()])).mockReturnValueOnce(finalizeChain);
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket() as never);
    vi.mocked(commentsService.addComment).mockResolvedValue({ id: 'cm-1' } as never);

    const view = await approveProposal('prop-abc1234');

    expect(commentsService.addComment).toHaveBeenCalledTimes(1);
    const [targetId, html] = vi.mocked(commentsService.addComment).mock.calls[0];
    expect(targetId).toBe('wi-1');
    // Row-level content assertions: the html the comment row will actually
    // store — disclosure (with the CURRENT user's display name) first,
    // model-authored body entity-escaped, raw <script> impossible.
    expect(html.startsWith('<p><em>Hi, this is Copilot — Amaan’s agent — commenting on their behalf: </em>')).toBe(
      true,
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    // Finalized with the execution's own resultInfo.
    const finalizeSet = (finalizeChain.set as Vfn).mock.calls[0][0];
    expect(finalizeSet).toMatchObject({ status: 'executed', resultInfo: { commentId: 'cm-1' } });
    expect(view.status).toBe('executed');
  });

  it('executes a state change with EXACTLY one patch key — stateId — nothing else touched', async () => {
    db.update
      .mockReturnValueOnce(
        chainable([
          proposalRow({
            kind: 'state_change',
            payload: { stateId: 'st-done' },
            snapshot: { fromStateId: 'st-progress' },
          }),
        ]),
      )
      .mockReturnValueOnce(chainable([proposalRow({ status: 'executed' })]));
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket() as never);
    vi.mocked(statesService.listStates).mockResolvedValue([{ id: 'st-done' }] as never);
    vi.mocked(ticketsService.updateTicket).mockResolvedValue({} as never);

    await approveProposal('prop-abc1234');

    expect(ticketsService.updateTicket).toHaveBeenCalledTimes(1);
    expect(ticketsService.updateTicket).toHaveBeenCalledWith('wi-1', { stateId: 'st-done' });
  });

  it('executes a priority change with EXACTLY one patch key — priority', async () => {
    db.update
      .mockReturnValueOnce(
        chainable([
          proposalRow({
            kind: 'priority_change',
            payload: { priority: 'urgent' },
            snapshot: { fromPriority: 'medium' },
          }),
        ]),
      )
      .mockReturnValueOnce(chainable([proposalRow({ status: 'executed' })]));
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket() as never);
    vi.mocked(ticketsService.updateTicket).mockResolvedValue({} as never);

    await approveProposal('prop-abc1234');

    expect(ticketsService.updateTicket).toHaveBeenCalledWith('wi-1', { priority: 'urgent' });
  });

  it('executes an assignee change through the toggle only after the direction guard passed', async () => {
    db.update
      .mockReturnValueOnce(
        chainable([
          proposalRow({
            kind: 'assignee_change',
            payload: { assigneeId: 'mem-2', action: 'add' },
            snapshot: {},
          }),
        ]),
      )
      .mockReturnValueOnce(chainable([proposalRow({ status: 'executed' })]));
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket({ assigneeIds: [] }) as never);
    vi.mocked(ticketsService.toggleTicketAssignee).mockResolvedValue({} as never);

    await approveProposal('prop-abc1234');

    expect(ticketsService.toggleTicketAssignee).toHaveBeenCalledWith('wi-1', 'mem-2');
  });

  it('executes create_work_item with isDraft forced false and finalizes with the created identifier', async () => {
    const finalizeChain = chainable([proposalRow({ status: 'executed' })]);
    db.update
      .mockReturnValueOnce(
        chainable([
          proposalRow({
            kind: 'create_work_item',
            ticketId: null,
            payload: {
              projectId: 'proj-1',
              title: 'New ticket',
              description: 'body',
              stateId: 'st-1',
              priority: 'high',
              assigneeIds: ['mem-2'],
            },
            snapshot: {},
          }),
        ]),
      )
      .mockReturnValueOnce(finalizeChain);
    vi.mocked(projectsService.getProject).mockResolvedValue({ id: 'proj-1' } as never);
    vi.mocked(statesService.listStates).mockResolvedValue([{ id: 'st-1' }] as never);
    vi.mocked(ticketsService.createTicket).mockResolvedValue(
      { id: 'wi-new', identifier: 'PROJ-9' } as never,
    );

    await approveProposal('prop-abc1234');

    expect(ticketsService.createTicket).toHaveBeenCalledWith({
      projectId: 'proj-1',
      title: 'New ticket',
      description: 'body',
      stateId: 'st-1',
      priority: 'high',
      assigneeIds: ['mem-2'],
      isDraft: false,
    });
    const finalizeSet = (finalizeChain.set as Vfn).mock.calls[0][0];
    expect(finalizeSet.resultInfo).toEqual({ ticketId: 'wi-new', identifier: 'PROJ-9' });
  });

  // Final review M2: finalize is guarded on status='executing' — only the
  // holder of a live claim may finalize. A claim lost to the stuck-claim
  // repair (execute outlived EXECUTING_STUCK_MS) must NOT stomp the
  // repaired row with 'executed'; the caller gets the row as the repair
  // left it instead.
  it('does not overwrite a lost claim: a guarded finalize that matches no row returns the repaired row as-is', async () => {
    const lostFinalizeChain = chainable([]); // UPDATE ... WHERE status='executing' matched nothing
    db.update
      .mockReturnValueOnce(chainable([proposalRow({ kind: 'priority_change', payload: { priority: 'urgent' }, snapshot: { fromPriority: 'medium' } })]))
      .mockReturnValueOnce(lostFinalizeChain);
    // finalize's fallback fetch returns the row as the repair parked it.
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket({ priority: 'medium' }) as never);
    vi.mocked(ticketsService.updateTicket).mockResolvedValue({} as never);
    db.select.mockReturnValueOnce(
      chainable([proposalRow({ status: 'stale', statusReason: 'Approval was interrupted' })]),
    );

    const view = await approveProposal('prop-abc1234');

    const finalizeAnd = (lostFinalizeChain.where as Vfn).mock.calls.length;
    expect(finalizeAnd).toBe(1);
    expect(eq).toHaveBeenCalledWith(copilotProposals.status, 'executing');
    expect(view.status).toBe('stale');
  });

  it('reverts the claim (executing → proposed) and rethrows when execution itself throws', async () => {
    const revertChain = chainable([]);
    db.update.mockReturnValueOnce(chainable([proposalRow()])).mockReturnValueOnce(revertChain);
    vi.mocked(ticketsService.getTicket).mockResolvedValue(ticket() as never);
    vi.mocked(commentsService.addComment).mockRejectedValue(new Error('db down'));

    await expect(approveProposal('prop-abc1234')).rejects.toThrow('db down');

    // The second update is the REVERT, not a finalize: back to proposed,
    // claim marker cleared, conditioned on still holding the claim.
    const revertSet = (revertChain.set as Vfn).mock.calls[0][0];
    expect(revertSet).toEqual({ status: 'proposed', resolvedAt: null });
    expect(eq).toHaveBeenCalledWith(copilotProposals.status, 'executing');
  });
});

// ---------------------------------------------------------------------------
// rejectProposal / rejectAllPending / markProposalsNotified / listProposals
// ---------------------------------------------------------------------------

describe('rejectProposal', () => {
  it('rejects via a conditional UPDATE over proposed AND stale rows, preserving statusReason', async () => {
    const rejectChain = chainable([proposalRow({ status: 'rejected', statusReason: 'was stale' })]);
    db.update.mockReturnValueOnce(rejectChain);

    const view = await rejectProposal('prop-abc1234');

    const setArgs = (rejectChain.set as Vfn).mock.calls[0][0];
    // statusReason deliberately NOT in the set — a stale card's reason
    // survives its dismissal.
    expect(Object.keys(setArgs).sort()).toEqual(['resolvedAt', 'status']);
    expect(setArgs.status).toBe('rejected');
    expect(inArray).toHaveBeenCalledWith(copilotProposals.status, ['proposed', 'stale']);
    expect(view.status).toBe('rejected');
    expect(view.statusReason).toBe('was stale');
  });

  it('echoes an already-resolved row idempotently and 404s a missing one', async () => {
    db.update.mockReturnValueOnce(chainable([]));
    db.select.mockReturnValueOnce(chainable([proposalRow({ status: 'executed' })]));
    const view = await rejectProposal('prop-abc1234');
    expect(view.status).toBe('executed');

    db.update.mockReturnValueOnce(chainable([]));
    db.select.mockReturnValueOnce(chainable([]));
    await expect(rejectProposal('prop-missing')).rejects.toThrow(NotFoundError);
  });
});

describe('rejectAllPending', () => {
  it('rejects proposed AND stale rows in the conversation, in one UPDATE, returning the count', async () => {
    const chain = chainable([{ id: 'prop-1' }, { id: 'prop-2' }]);
    db.update.mockReturnValueOnce(chain);

    const result = await rejectAllPending('conv-abc1234');

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith(copilotProposals.conversationId, 'conv-abc1234');
    // stale included (final review m5): a stale card's only affordance is
    // Dismiss, so reject-all leaving them behind stranded them.
    expect(inArray).toHaveBeenCalledWith(copilotProposals.status, ['proposed', 'stale']);
    expect(result).toEqual({ rejected: 2 });
  });
});

describe('markProposalsNotified', () => {
  it('stamps modelNotifiedAt only for the given ids, in the given conversation, where not already stamped', async () => {
    const chain = chainable([{ id: 'prop-1' }]);
    db.update.mockReturnValueOnce(chain);

    const result = await markProposalsNotified('conv-abc1234', ['prop-1', 'prop-2']);

    const setArgs = (chain.set as Vfn).mock.calls[0][0];
    expect(Object.keys(setArgs)).toEqual(['modelNotifiedAt']);
    expect(inArray).toHaveBeenCalledWith(copilotProposals.id, ['prop-1', 'prop-2']);
    expect(eq).toHaveBeenCalledWith(copilotProposals.conversationId, 'conv-abc1234');
    expect(isNull).toHaveBeenCalledWith(copilotProposals.modelNotifiedAt);
    expect(result).toEqual({ notified: 1 });
  });
});

describe('listProposals', () => {
  it('lazily expires overdue proposed rows and revives stuck executing claims, then lists by createdAt with disclosureText', async () => {
    const expireChain = chainable(undefined);
    const reviveChain = chainable(undefined);
    db.update.mockReturnValueOnce(expireChain).mockReturnValueOnce(reviveChain);
    db.select.mockReturnValueOnce(chainable([proposalRow({ status: 'proposed' })]));

    const views = await listProposals('conv-abc1234');

    // Repair pass 1: proposed + past expiry → expired.
    const expireSet = (expireChain.set as Vfn).mock.calls[0][0];
    expect(expireSet.status).toBe('expired');
    // Repair pass 2 (final review M2): a stuck claim is parked as STALE —
    // NOT reverted to proposed — because there is no way to tell whether
    // the crash happened before or after the underlying write ran, and a
    // re-approvable card would run the write a second time (a duplicated
    // comment or ticket, silently).
    const reviveSet = (reviveChain.set as Vfn).mock.calls[0][0];
    expect(reviveSet.status).toBe('stale');
    expect(reviveSet.resolvedAt).toBeInstanceOf(Date);
    expect(reviveSet.statusReason).toMatch(/interrupted/i);
    expect(eq).toHaveBeenCalledWith(copilotProposals.status, 'executing');
    // The view carries the server-computed disclosure for the card preview.
    expect(views).toHaveLength(1);
    expect(views[0].disclosureText).toBe(
      'Hi, this is Copilot — Amaan’s agent — commenting on their behalf: ',
    );
    // No live staleness reads happen at list time — approve is authoritative.
    expect(ticketsService.getTicket).not.toHaveBeenCalled();
  });
});
