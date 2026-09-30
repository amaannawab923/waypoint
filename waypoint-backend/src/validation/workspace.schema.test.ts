import { describe, it, expect } from 'vitest';
import { notificationPrefsSchema, updateWorkspaceSchema } from './workspace.schema.js';

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

describe('notificationPrefsSchema', () => {
  // Found in review: replies/assignments were silently dropped (the object
  // wasn't strict), so their switches showed "off" and never saved.
  it('keeps every in-app notification setting', () => {
    const prefs = { mentions: false, replies: false, comments: false, assignments: false, email: true, push: false };
    expect(notificationPrefsSchema.parse(prefs)).toEqual(prefs);
  });

  it('refuses a key it doesn\'t know instead of dropping it', () => {
    expect(() => notificationPrefsSchema.parse({ replys: false })).toThrow();
  });
});
