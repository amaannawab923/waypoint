import { describe, it, expect } from 'vitest';
import { updateSprintSchema } from './workstreamsSprints.schema.js';

// Regression coverage for the sprint "clear lead" fix: leadId was previously
// `z.string().optional()` — accepting an omitted field but rejecting an explicit `null` — so
// the frontend had no valid request body it could send to clear a sprint's lead. It now
// mirrors updateWorkstreamSchema's identical leadId pattern.
describe('updateSprintSchema leadId', () => {
  it('accepts an explicit null (clear the lead)', () => {
    expect(updateSprintSchema.safeParse({ leadId: null }).success).toBe(true);
  });

  it('accepts a patch that omits leadId entirely', () => {
    expect(updateSprintSchema.safeParse({ name: 'Sprint 13' }).success).toBe(true);
  });

  it('accepts a string leadId', () => {
    expect(updateSprintSchema.safeParse({ leadId: 'mem-1' }).success).toBe(true);
  });

  it('rejects a non-string, non-null leadId', () => {
    expect(updateSprintSchema.safeParse({ leadId: 42 }).success).toBe(false);
  });
});
