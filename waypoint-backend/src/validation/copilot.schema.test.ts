import { describe, it, expect } from 'vitest';
import { postCopilotMessageSchema } from './copilot.schema.js';

describe('postCopilotMessageSchema', () => {
  it('accepts a normal message', () => {
    const result = postCopilotMessageSchema.safeParse({ content: 'hi' });
    expect(result.success).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const result = postCopilotMessageSchema.safeParse({ content: '  hi  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.content).toBe('hi');
  });

  it('rejects an empty string', () => {
    expect(postCopilotMessageSchema.safeParse({ content: '' }).success).toBe(false);
  });

  it('rejects whitespace-only content (empty after trim)', () => {
    expect(postCopilotMessageSchema.safeParse({ content: '   ' }).success).toBe(false);
  });

  it('rejects a missing content field', () => {
    expect(postCopilotMessageSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-string content value', () => {
    expect(postCopilotMessageSchema.safeParse({ content: 42 }).success).toBe(false);
  });

  it('accepts content at exactly the 8000-char limit', () => {
    expect(postCopilotMessageSchema.safeParse({ content: 'a'.repeat(8000) }).success).toBe(true);
  });

  it('rejects content over the 8000-char limit', () => {
    expect(postCopilotMessageSchema.safeParse({ content: 'a'.repeat(8001) }).success).toBe(false);
  });
});
