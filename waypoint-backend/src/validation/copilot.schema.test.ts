import { describe, it, expect } from 'vitest';
import { postCopilotMessageSchema, postCopilotAssistantMessageSchema } from './copilot.schema.js';

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

describe('postCopilotAssistantMessageSchema', () => {
  it('accepts a real session id', () => {
    const result = postCopilotAssistantMessageSchema.safeParse({
      content: 'here is my answer',
      claudeSessionId: 'sess-abc123',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null session id (the stream ended without ever producing one)', () => {
    const result = postCopilotAssistantMessageSchema.safeParse({
      content: 'here is my answer',
      claudeSessionId: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing claudeSessionId field — must be explicit, not merely absent', () => {
    expect(postCopilotAssistantMessageSchema.safeParse({ content: 'hi' }).success).toBe(false);
  });

  it('rejects an empty-string session id', () => {
    expect(
      postCopilotAssistantMessageSchema.safeParse({ content: 'hi', claudeSessionId: '' }).success,
    ).toBe(false);
  });

  it('rejects empty content', () => {
    expect(
      postCopilotAssistantMessageSchema.safeParse({ content: '', claudeSessionId: null }).success,
    ).toBe(false);
  });

  it('allows content longer than the 8000-char user-message limit', () => {
    const result = postCopilotAssistantMessageSchema.safeParse({
      content: 'a'.repeat(20000),
      claudeSessionId: null,
    });
    expect(result.success).toBe(true);
  });
});
