import { describe, it, expect } from 'vitest';
import { ticketFilterSchema } from './ticketFilter.schema.js';

describe('ticketFilterSchema', () => {
  it('accepts the minimal valid shape (just the version)', () => {
    expect(ticketFilterSchema.safeParse({ v: 1 }).success).toBe(true);
  });

  it('accepts every field populated', () => {
    const result = ticketFilterSchema.safeParse({
      v: 1,
      projectIds: ['proj-1'],
      stateIds: ['st-1'],
      stateGroups: ['backlog', 'started'],
      priorities: ['urgent', 'none'],
      assigneeIds: ['mem-1', '@me', '@unassigned'],
      labelIds: ['lbl-1'],
      sprintIds: ['spr-1'],
      workstreamIds: ['ws-1'],
      sources: ['manual', 'agent'],
      updatedBefore: '-30d',
      createdAfter: '2026-01-01',
      text: 'login bug',
      includeDrafts: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing version', () => {
    expect(ticketFilterSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a version other than 1', () => {
    expect(ticketFilterSchema.safeParse({ v: 2 }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(ticketFilterSchema.safeParse({ v: 1, bogus: true }).success).toBe(false);
  });

  it('rejects an invalid stateGroup value', () => {
    expect(ticketFilterSchema.safeParse({ v: 1, stateGroups: ['triage'] }).success).toBe(false);
  });

  it('rejects an invalid priority value', () => {
    expect(ticketFilterSchema.safeParse({ v: 1, priorities: ['critical'] }).success).toBe(false);
  });

  it('rejects an invalid ticket source value', () => {
    expect(ticketFilterSchema.safeParse({ v: 1, sources: ['webhook'] }).success).toBe(false);
  });

  it('rejects text longer than 200 characters', () => {
    expect(ticketFilterSchema.safeParse({ v: 1, text: 'x'.repeat(201) }).success).toBe(false);
  });

  describe('date tokens (updatedBefore / createdAfter)', () => {
    it('accepts an absolute ISO date', () => {
      expect(ticketFilterSchema.safeParse({ v: 1, updatedBefore: '2026-09-01' }).success).toBe(true);
      expect(ticketFilterSchema.safeParse({ v: 1, updatedBefore: '2026-09-01T00:00:00.000Z' }).success).toBe(true);
    });

    it('accepts a relative day token', () => {
      expect(ticketFilterSchema.safeParse({ v: 1, createdAfter: '-30d' }).success).toBe(true);
      expect(ticketFilterSchema.safeParse({ v: 1, createdAfter: '-1d' }).success).toBe(true);
    });

    it('rejects a garbage token', () => {
      expect(ticketFilterSchema.safeParse({ v: 1, updatedBefore: 'not-a-date' }).success).toBe(false);
    });

    it('rejects a relative token in the wrong direction or unit', () => {
      expect(ticketFilterSchema.safeParse({ v: 1, updatedBefore: '30d' }).success).toBe(false);
      expect(ticketFilterSchema.safeParse({ v: 1, updatedBefore: '-30w' }).success).toBe(false);
    });
  });
});
