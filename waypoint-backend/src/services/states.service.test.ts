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
  return { ...actual, inArray: vi.fn(actual.inArray) };
});

const { ticketStates } = await import('../db/schema/index.js');
const { resolveStateNames } = await import('./states.service.js');
const { inArray } = await import('drizzle-orm');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveStateNames', () => {
  it('returns an empty map for no ids, without querying', async () => {
    const result = await resolveStateNames([]);

    expect(result.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('resolves state ids to their name and group', async () => {
    db.select.mockReturnValueOnce(chainable([{ id: 'st-l-progress', name: 'In Progress', group: 'started' }]));

    const result = await resolveStateNames(['st-l-progress']);

    expect(result.get('st-l-progress')).toEqual({ name: 'In Progress', group: 'started' });
  });

  it('queries with deduplicated ids', async () => {
    const chain = chainable([]);
    db.select.mockReturnValueOnce(chain);

    await resolveStateNames(['st-l-progress', 'st-l-progress']);

    expect(chain.from).toHaveBeenCalledWith(ticketStates);
    expect(inArray).toHaveBeenCalledWith(ticketStates.id, ['st-l-progress']);
  });

  it('leaves an unresolvable id absent from the map, not thrown', async () => {
    db.select.mockReturnValueOnce(chainable([]));

    const result = await resolveStateNames(['st-ghost']);

    expect(result.has('st-ghost')).toBe(false);
  });
});
