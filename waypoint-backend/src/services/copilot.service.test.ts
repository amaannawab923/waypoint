import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks Drizzle's fluent query builder shape, not a real database — these
// tests verify this service's own logic (which methods it calls, with what
// arguments, in what order) in isolation. They intentionally do NOT and
// cannot verify real Postgres behavior: the two bugs a prior review found in
// this exact file (transaction-timestamp collisions breaking message order,
// a getOrCreateConversation race creating duplicate rows) were both genuine
// database behaviors these mocks have no way to reproduce. Those are only
// caught by testing against a real Postgres instance.
function chainable(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'onConflictDoNothing', 'set'];
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  chain.returning = vi.fn(() => Promise.resolve(resolvedValue));
  chain.then = (resolve: (value: unknown) => void) => resolve(resolvedValue);
  return chain;
}

const { db } = vi.hoisted(() => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn() } }));
vi.mock('../db/client.js', () => ({ db }));

// Spies wrapping the REAL asc/eq (not fakes) — a mutation test caught that
// merely asserting orderBy()/where() "were called" doesn't distinguish
// ordering by seq from ordering by createdAt (the original bug this schema
// fixed): the chain shape is identical either way. Spying on the column
// actually passed to asc()/eq() is what makes that distinction assertable.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, asc: vi.fn(actual.asc), eq: vi.fn(actual.eq) };
});

const { copilotConversations, copilotMessages } = await import('../db/schema/index.js');
const { getOrCreateConversation, listMessages, postMessage } = await import('./copilot.service.js');
const { asc, eq } = await import('drizzle-orm');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOrCreateConversation', () => {
  it('inserts with onConflictDoNothing targeted at memberId, then selects the row', async () => {
    const insertChain = chainable(undefined);
    const selectChain = chainable([{ id: 'conv-abc1234', memberId: 'mem-1' }]);
    db.insert.mockReturnValue(insertChain);
    db.select.mockReturnValue(selectChain);

    const result = await getOrCreateConversation('mem-1');

    expect(db.insert).toHaveBeenCalledWith(copilotConversations);
    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'mem-1' }));
    const insertedId = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0].id;
    expect(insertedId).toMatch(/^conv-/);
    expect(insertChain.onConflictDoNothing).toHaveBeenCalledWith({ target: copilotConversations.memberId });

    expect(db.select).toHaveBeenCalled();
    expect(selectChain.where).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith(copilotConversations.memberId, 'mem-1');
    expect(selectChain.limit).toHaveBeenCalledWith(1);
    expect(result).toEqual({ id: 'conv-abc1234', memberId: 'mem-1' });
  });
});

describe('listMessages', () => {
  it('selects messages for the conversation, ordered by seq — not createdAt', async () => {
    const rows = [
      { id: 'msg-1', role: 'user', seq: 1 },
      { id: 'msg-2', role: 'assistant', seq: 2 },
    ];
    const selectChain = chainable(rows);
    db.select.mockReturnValue(selectChain);

    const result = await listMessages('conv-abc1234');

    expect(db.select).toHaveBeenCalled();
    expect(selectChain.from).toHaveBeenCalledWith(copilotMessages);
    expect(selectChain.where).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith(copilotMessages.conversationId, 'conv-abc1234');
    // The load-bearing assertion: merely checking orderBy() "was called"
    // can't distinguish ordering by seq from ordering by createdAt — the
    // chain shape is identical either way, and that's exactly the bug this
    // schema fixed (same-transaction inserts get identical createdAt
    // timestamps in Postgres). Asserting the actual column passed to asc()
    // is what makes a regression back to createdAt fail this test.
    expect(selectChain.orderBy).toHaveBeenCalled();
    expect(asc).toHaveBeenCalledWith(copilotMessages.seq);
    expect(result).toEqual(rows);
  });
});

describe('postMessage', () => {
  it('inserts the user message, inserts a canned assistant reply, bumps updatedAt, returns the reply', async () => {
    const insertChains: ReturnType<typeof chainable>[] = [];
    const tx = {
      insert: vi.fn(() => {
        // .returning() resolves to an array of rows in real Drizzle; the
        // bare awaited chain (the first insert below, which never calls
        // .returning()) resolves to something this code never reads.
        const chain = chainable([{ id: 'msg-reply1', conversationId: 'conv-abc1234', role: 'assistant' }]);
        insertChains.push(chain);
        return chain;
      }),
      update: vi.fn(() => chainable(undefined)),
    };
    db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(tx));

    const result = await postMessage('conv-abc1234', 'hi');

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(2);

    const [userCall, assistantCall] = insertChains;
    expect((userCall.values as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      conversationId: 'conv-abc1234',
      role: 'user',
      content: 'hi',
    });
    const assistantValues = (assistantCall.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(assistantValues.role).toBe('assistant');
    expect(typeof assistantValues.content).toBe('string');
    expect(assistantValues.content.length).toBeGreaterThan(0);

    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledWith(copilotConversations);
    expect(eq).toHaveBeenCalledWith(copilotConversations.id, 'conv-abc1234');

    expect(result).toEqual({ id: 'msg-reply1', conversationId: 'conv-abc1234', role: 'assistant' });
  });

  it('rolls the whole transaction into one db.transaction() call, not separate writes', async () => {
    // The bug this guards against isn't reachable through mocks (that's the
    // whole caveat at the top of this file) — this only confirms the *shape*
    // of the call: everything routes through one db.transaction(), which is
    // what makes atomicity possible at all in the real database.
    db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({ insert: vi.fn(() => chainable([{}])), update: vi.fn(() => chainable(undefined)) }),
    );

    await postMessage('conv-abc1234', 'hi');

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});
