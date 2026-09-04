import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same mocked-Drizzle approach as projects.service.test.ts/proposals.service.test.ts:
// these tests verify updateSprint's OWN branching (does it call .update() with the right
// payload, or fall through to the plain-select no-op path) rather than real Postgres
// behavior.
function chainable(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'where', 'set', 'values'];
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

const { updateSprint } = await import('./sprints.service.js');

const SPRINT_ROW = {
  id: 'spr-1',
  projectId: 'proj-1',
  name: 'Sprint 12',
  description: '',
  startDate: '2026-01-01',
  endDate: '2026-01-14',
  leadId: 'mem-1',
};

function makeTx({
  updateReturn = [{ ...SPRINT_ROW, leadId: null }] as unknown[],
  selectReturn = [] as unknown[],
} = {}) {
  const tx = {
    select: vi.fn(() => chainable(selectReturn)),
    update: vi.fn(() => chainable(updateReturn)),
    delete: vi.fn(() => chainable(undefined)),
    insert: vi.fn(() => chainable(undefined)),
  };
  db.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(tx));
  return tx;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Regression coverage for the sprint "clear lead" fix: `Object.keys(rest).length` (the
// existing memberIds-only-patch guard, see the comment above this check in
// sprints.service.ts) counts an explicit `leadId: null` as a present key — it must actually
// reach `.update(...).set(...)`, not silently fall through to the read-only-and-return-
// unchanged path the way an all-`undefined` patch correctly does.
describe('updateSprint — clearing a sprint lead', () => {
  it('writes an explicit leadId: null through to the update call', async () => {
    const tx = makeTx();

    const result = await updateSprint('spr-1', { leadId: null });

    expect(tx.update).toHaveBeenCalledTimes(1);
    const updateChain = tx.update.mock.results[0]!.value as { set: ReturnType<typeof vi.fn> };
    expect(updateChain.set).toHaveBeenCalledWith({ leadId: null });
    expect(result.leadId).toBeNull();
  });

  it('still takes the no-op select path for a genuinely empty patch (memberIds-only)', async () => {
    const tx = makeTx({ selectReturn: [SPRINT_ROW] });

    const result = await updateSprint('spr-1', { memberIds: [] });

    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.select).toHaveBeenCalled();
    expect(result.leadId).toBe('mem-1');
  });
});
