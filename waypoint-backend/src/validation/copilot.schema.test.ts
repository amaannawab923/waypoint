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
  it('accepts a real (UUID-shaped) session id', () => {
    const result = postCopilotAssistantMessageSchema.safeParse({
      content: 'here is my answer',
      claudeSessionId: '6b16ad5b-1e3f-4a2c-8f9d-2c7e5a9b3d10',
    });
    expect(result.success).toBe(true);
  });

  // Real Claude Code session ids are always UUIDs; this value flows straight
  // into `spawn(claude, ['--resume', claudeSessionId])` on the frontend,
  // where a value starting with `-` isn't consumed as --resume's argument —
  // it's parsed as its own separate flag. Rejecting non-UUID shapes here is
  // what keeps a flag-shaped string out of the database in the first place.
  it('rejects a non-UUID session id, even a flag-shaped one', () => {
    const result = postCopilotAssistantMessageSchema.safeParse({
      content: 'here is my answer',
      claudeSessionId: '--dangerously-skip-permissions',
    });
    expect(result.success).toBe(false);
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
