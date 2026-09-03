import { describe, it, expect } from 'vitest';
import { createViewSchema, updateViewSchema } from './views.schema.js';

describe('createViewSchema filters', () => {
  it('accepts a minimally versioned filter', () => {
    const result = createViewSchema.safeParse({ name: 'My view', filters: { v: 1 } });
    expect(result.success).toBe(true);
  });

  it('accepts the empty-object shape no longer parsing at all — {} is not a valid ticketFilterSchema value', () => {
    // Guards the exact scenario the W3.5 data migration exists for: a
    // pre-migration row's filters value ('{}', no `v`) is no longer
    // something the write path accepts going forward. Existing rows are
    // fixed up by the migration, not by loosening this schema.
    expect(createViewSchema.safeParse({ name: 'My view', filters: {} }).success).toBe(false);
  });

  it('accepts a fully populated typed filter', () => {
    const result = createViewSchema.safeParse({
      name: 'Assigned to me',
      filters: { v: 1, assigneeIds: ['@me'], priorities: ['urgent', 'high'] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a filter with an unknown field', () => {
    const result = createViewSchema.safeParse({ name: 'My view', filters: { v: 1, bogus: true } });
    expect(result.success).toBe(false);
  });

  it('rejects a filter with an invalid enum value', () => {
    const result = createViewSchema.safeParse({ name: 'My view', filters: { v: 1, priorities: ['critical'] } });
    expect(result.success).toBe(false);
  });

  it('rejects a missing name', () => {
    expect(createViewSchema.safeParse({ filters: { v: 1 } }).success).toBe(false);
  });
});

describe('updateViewSchema filters', () => {
  it('allows omitting filters entirely (patch just the name)', () => {
    expect(updateViewSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });

  it('validates filters against the typed schema when present', () => {
    expect(updateViewSchema.safeParse({ filters: { v: 1, stateIds: ['st-1'] } }).success).toBe(true);
    expect(updateViewSchema.safeParse({ filters: { stateIds: ['st-1'] } }).success).toBe(false);
  });
});
