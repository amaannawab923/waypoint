import { describe, it, expect } from 'vitest';
import { updateWorkspaceSchema } from './workspace.schema.js';

describe('updateWorkspaceSchema', () => {
  it('accepts a default agent provider, and null to clear it', () => {
    expect(updateWorkspaceSchema.parse({ defaultAgentProvider: 'claude' })).toEqual({
      defaultAgentProvider: 'claude',
    });
    expect(updateWorkspaceSchema.parse({ defaultAgentProvider: null })).toEqual({
      defaultAgentProvider: null,
    });
  });

  it('refuses an empty or over-long provider id', () => {
    expect(() => updateWorkspaceSchema.parse({ defaultAgentProvider: '' })).toThrow();
    expect(() => updateWorkspaceSchema.parse({ defaultAgentProvider: 'x'.repeat(65) })).toThrow();
  });
});
