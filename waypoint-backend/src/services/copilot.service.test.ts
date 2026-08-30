import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '../middleware/errors.js';

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

const { db } = vi.hoisted(() => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../db/client.js', () => ({ db }));

// Spies wrapping the REAL asc/eq/desc/count (not fakes) — a mutation test
// caught that merely asserting orderBy()/where() "were called" doesn't
// distinguish ordering by seq from ordering by createdAt (the original bug
// this schema fixed): the chain shape is identical either way. Spying on the
// column actually passed to asc()/eq()/desc() is what makes that distinction
// assertable.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, asc: vi.fn(actual.asc), eq: vi.fn(actual.eq), desc: vi.fn(actual.desc), count: vi.fn(actual.count) };
});

const { copilotConversations, copilotMessages } = await import('../db/schema/index.js');
const {
  createConversation,
  listConversations,
  getConversation,
  deleteConversation,
  renameConversation,
  listMessages,
  postUserMessage,
  postAssistantMessage,
} = await import('./copilot.service.js');
const { asc, eq, desc } = await import('drizzle-orm');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createConversation', () => {
  it('inserts a conversation for the member with no conflict handling', async () => {
    const insertChain = chainable([{ id: 'conv-abc1234', memberId: 'mem-1', title: 'New session' }]);
    db.insert.mockReturnValue(insertChain);

    const result = await createConversation('mem-1');

    expect(db.insert).toHaveBeenCalledWith(copilotConversations);
    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'mem-1' }));
    const insertedId = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0].id;
    expect(insertedId).toMatch(/^conv-/);
    // No onConflictDoNothing — memberId isn't unique anymore (issue #11),
    // so there's nothing left to conflict against.
    expect(insertChain.onConflictDoNothing).not.toHaveBeenCalled();
    expect(insertChain.returning).toHaveBeenCalled();
    expect(result).toEqual({ id: 'conv-abc1234', memberId: 'mem-1', title: 'New session' });
  });
});

describe('listConversations', () => {
  it('selects conversations for the member, ordered by updatedAt descending', async () => {
    const rows = [
      { id: 'conv-2', memberId: 'mem-1', updatedAt: new Date('2026-01-02') },
      { id: 'conv-1', memberId: 'mem-1', updatedAt: new Date('2026-01-01') },
    ];
    const selectChain = chainable(rows);
    db.select.mockReturnValue(selectChain);

    const result = await listConversations('mem-1');

    expect(db.select).toHaveBeenCalled();
    expect(selectChain.from).toHaveBeenCalledWith(copilotConversations);
    expect(eq).toHaveBeenCalledWith(copilotConversations.memberId, 'mem-1');
    // The load-bearing assertion: merely checking orderBy() "was called"
    // can't distinguish descending updatedAt from any other column/direction
    // — asserting the actual column passed to desc() is what makes a
    // regression to ascending or the wrong column fail this test.
    expect(selectChain.orderBy).toHaveBeenCalled();
    expect(desc).toHaveBeenCalledWith(copilotConversations.updatedAt);
    expect(result).toEqual(rows);
  });
});

describe('getConversation', () => {
  it('selects a single conversation by id', async () => {
    const selectChain = chainable([{ id: 'conv-abc1234', memberId: 'mem-1' }]);
    db.select.mockReturnValue(selectChain);

    const result = await getConversation('conv-abc1234');

    expect(selectChain.from).toHaveBeenCalledWith(copilotConversations);
    expect(eq).toHaveBeenCalledWith(copilotConversations.id, 'conv-abc1234');
    expect(selectChain.limit).toHaveBeenCalledWith(1);
    expect(result).toEqual({ id: 'conv-abc1234', memberId: 'mem-1' });
  });

  it('throws NotFoundError when no conversation matches', async () => {
    db.select.mockReturnValue(chainable([]));

    await expect(getConversation('conv-missing')).rejects.toThrow(NotFoundError);
  });
});

describe('deleteConversation', () => {
  it('deletes the conversation by id with no existence pre-check', async () => {
    const deleteChain = chainable(undefined);
    db.delete.mockReturnValue(deleteChain);

    await deleteConversation('conv-abc1234');

    expect(db.delete).toHaveBeenCalledWith(copilotConversations);
    expect(eq).toHaveBeenCalledWith(copilotConversations.id, 'conv-abc1234');
  });
});

describe('renameConversation', () => {
  it('updates the title and bumps updatedAt, returns the updated row', async () => {
    const updateChain = chainable([{ id: 'conv-abc1234', title: 'New title' }]);
    db.update.mockReturnValue(updateChain);

    const result = await renameConversation('conv-abc1234', 'New title');

    expect(db.update).toHaveBeenCalledWith(copilotConversations);
    const setArgs = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(setArgs).toMatchObject({ title: 'New title' });
    expect(setArgs).toHaveProperty('updatedAt');
    expect(eq).toHaveBeenCalledWith(copilotConversations.id, 'conv-abc1234');
    expect(result).toEqual({ id: 'conv-abc1234', title: 'New title' });
  });

  it('throws NotFoundError when no conversation matches', async () => {
    db.update.mockReturnValue(chainable([]));

    await expect(renameConversation('conv-missing', 'New title')).rejects.toThrow(NotFoundError);
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
    expect(selectChain.orderBy).toHaveBeenCalled();
    expect(asc).toHaveBeenCalledWith(copilotMessages.seq);
    expect(result).toEqual(rows);
  });
});

describe('postUserMessage', () => {
  it('inserts the user message, bumps updatedAt, returns the inserted row', async () => {
    const tx = {
      insert: vi.fn(() => chainable([{ id: 'msg-user1', conversationId: 'conv-abc1234', role: 'user' }])),
      select: vi.fn(() => chainable([{ n: 2 }])),
      update: vi.fn(() => chainable(undefined)),
    };
    db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(tx));

    const result = await postUserMessage('conv-abc1234', 'hi');

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    const insertedValues = (tx.insert.mock.results[0].value.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertedValues).toMatchObject({ conversationId: 'conv-abc1234', role: 'user', content: 'hi' });

    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledWith(copilotConversations);
    expect(eq).toHaveBeenCalledWith(copilotConversations.id, 'conv-abc1234');
    // claudeSessionId is untouched here — only postAssistantMessage sets it,
    // since it's only known once a Claude Code stream has completed.
    const setArgs = (tx.update.mock.results[0].value.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(setArgs).not.toHaveProperty('claudeSessionId');

    expect(result).toEqual({ id: 'msg-user1', conversationId: 'conv-abc1234', role: 'user' });
  });

  it('rolls the insert and the updatedAt bump into one db.transaction() call', async () => {
    db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        insert: vi.fn(() => chainable([{}])),
        select: vi.fn(() => chainable([{ n: 1 }])),
        update: vi.fn(() => chainable(undefined)),
      }),
    );

    await postUserMessage('conv-abc1234', 'hi');

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("auto-titles the conversation from the message's content on the first message", async () => {
    const tx = {
      insert: vi.fn(() => chainable([{ id: 'msg-user1' }])),
      select: vi.fn(() => chainable([{ n: 1 }])),
      update: vi.fn(() => chainable(undefined)),
    };
    db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(tx));

    await postUserMessage('conv-abc1234', 'What is going on with my sprint?');

    const setArgs = (tx.update.mock.results[0].value.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(setArgs).toMatchObject({ title: 'What is going on with my sprint?' });
  });

  it('does not overwrite the title once the conversation already has messages', async () => {
    const tx = {
      insert: vi.fn(() => chainable([{ id: 'msg-user2' }])),
      select: vi.fn(() => chainable([{ n: 2 }])),
      update: vi.fn(() => chainable(undefined)),
    };
    db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(tx));

    await postUserMessage('conv-abc1234', 'a follow-up message');

    const setArgs = (tx.update.mock.results[0].value.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(setArgs).not.toHaveProperty('title');
  });
});

describe('postAssistantMessage', () => {
  it('inserts the assistant message and sets claudeSessionId in the same transaction', async () => {
    const tx = {
      insert: vi.fn(() =>
        chainable([{ id: 'msg-reply1', conversationId: 'conv-abc1234', role: 'assistant' }]),
      ),
      update: vi.fn(() => chainable(undefined)),
    };
    db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(tx));

    const result = await postAssistantMessage('conv-abc1234', 'here is my answer', 'sess-xyz789');

    expect(db.transaction).toHaveBeenCalledTimes(1);
    const insertedValues = (tx.insert.mock.results[0].value.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertedValues).toMatchObject({
      conversationId: 'conv-abc1234',
      role: 'assistant',
      content: 'here is my answer',
    });

    expect(tx.update).toHaveBeenCalledWith(copilotConversations);
    expect(eq).toHaveBeenCalledWith(copilotConversations.id, 'conv-abc1234');
    const setArgs = (tx.update.mock.results[0].value.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(setArgs).toMatchObject({ claudeSessionId: 'sess-xyz789' });

    expect(result).toEqual({ id: 'msg-reply1', conversationId: 'conv-abc1234', role: 'assistant' });
  });

  it('accepts a null claudeSessionId without writing it, so an existing session id is never clobbered', async () => {
    // A null here only ever means "this run never reached a result event" —
    // writing it through unconditionally would silently erase a real
    // session id a previous successful run already set, forcing the next
    // message to start a brand-new Claude Code session for no visible
    // reason. The conversation's updatedAt timestamp should still bump.
    const tx = {
      insert: vi.fn(() => chainable([{ id: 'msg-reply1' }])),
      update: vi.fn(() => chainable(undefined)),
    };
    db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(tx));

    await postAssistantMessage('conv-abc1234', 'reply text', null);

    const setArgs = (tx.update.mock.results[0].value.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(setArgs).not.toHaveProperty('claudeSessionId');
    expect(setArgs).toHaveProperty('updatedAt');
  });
});
