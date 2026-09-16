import { describe, it, expect, vi, beforeEach } from 'vitest';

function chainable(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.then = (resolve: (value: unknown) => void) => resolve(resolvedValue);
  return chain;
}

const { db } = vi.hoisted(() => ({ db: { select: vi.fn() } }));
vi.mock('../db/client.js', () => ({ db }));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, inArray: vi.fn(actual.inArray), eq: vi.fn(actual.eq) };
});

const { members, agents } = await import('../db/schema/index.js');
const { resolveActorNames } = await import('./actorNames.js');
const { inArray, eq } = await import('drizzle-orm');
const { runWithIdentity } = await import('./requestContext.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveActorNames', () => {
  it('returns an empty map for no ids, without querying', async () => {
    const result = await resolveActorNames([]);

    expect(result.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('resolves member ids to their display name, and agent ids to "<name> (agent)"', async () => {
    db.select
      .mockReturnValueOnce(chainable([{ id: 'mem-4', name: 'Lena' }]))
      .mockReturnValueOnce(chainable([{ id: 'agent-claude', name: 'Ethan' }]));

    const result = await resolveActorNames(['mem-4', 'agent-claude']);

    expect(result.get('mem-4')).toBe('Lena');
    expect(result.get('agent-claude')).toBe('Ethan (agent)');
  });

  it('queries with deduplicated ids', async () => {
    const memberChain = chainable([]);
    const agentChain = chainable([]);
    db.select.mockReturnValueOnce(memberChain).mockReturnValueOnce(agentChain);

    await resolveActorNames(['mem-4', 'mem-4', 'mem-4']);

    expect(memberChain.from).toHaveBeenCalledWith(members);
    expect(agentChain.from).toHaveBeenCalledWith(agents);
    expect(inArray).toHaveBeenCalledWith(members.id, ['mem-4']);
    expect(inArray).toHaveBeenCalledWith(agents.id, ['mem-4']);
  });

  it('leaves an unresolvable id absent from the map, not thrown', async () => {
    db.select.mockReturnValueOnce(chainable([])).mockReturnValueOnce(chainable([]));

    const result = await resolveActorNames(['mem-ghost']);

    expect(result.has('mem-ghost')).toBe(false);
  });

  // Ninth review round, proven live: every prior caller only ever handed
  // this ids read back off an already-scoped row, so an unscoped lookup
  // survived eight rounds — but mcp/proposalTools.ts hands it a
  // caller-supplied assigneeId directly, turning a cross-tenant id into a
  // real display-name read plus an existence oracle. Both lookups must be
  // filtered to the caller's own workspace, not just deduplicated ids.
  it('scopes both the member and the agent lookup to the current request workspace', async () => {
    db.select.mockReturnValueOnce(chainable([])).mockReturnValueOnce(chainable([]));

    await runWithIdentity({ userId: 'u-1', memberId: 'mem-1', workspaceId: 'ws-at11', role: 'member' }, () =>
      resolveActorNames(['mem-4']),
    );

    expect(eq).toHaveBeenCalledWith(members.workspaceId, 'ws-at11');
    expect(eq).toHaveBeenCalledWith(agents.workspaceId, 'ws-at11');
  });

  it('falls back to the Personal workspace constant outside any request context', async () => {
    db.select.mockReturnValueOnce(chainable([])).mockReturnValueOnce(chainable([]));

    await resolveActorNames(['mem-4']);

    expect(eq).toHaveBeenCalledWith(members.workspaceId, 'ws-1');
    expect(eq).toHaveBeenCalledWith(agents.workspaceId, 'ws-1');
  });
});
