import { describe, expect, it } from 'vitest';
import { addCommentSchema, COMMENT_BODY_MAX_LENGTH, editCommentSchema } from './tickets.schema.js';

describe('comment body rules', () => {
  it('caps the body at the same length Jira allows a comment', () => {
    // An unbounded body let one member post a comment that made a ticket
    // page expensive (and, before the renderer fix, crashed it) for every
    // reader.
    expect(addCommentSchema.safeParse({ bodyHtml: 'x'.repeat(COMMENT_BODY_MAX_LENGTH) }).success).toBe(true);
    expect(addCommentSchema.safeParse({ bodyHtml: 'x'.repeat(COMMENT_BODY_MAX_LENGTH + 1) }).success).toBe(false);
    expect(editCommentSchema.safeParse({ bodyHtml: 'x'.repeat(COMMENT_BODY_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it('accepts a comment that is files alone, but not one that is nothing', () => {
    expect(addCommentSchema.safeParse({ bodyHtml: '', attachmentIds: ['att-1'] }).success).toBe(true);
    expect(addCommentSchema.safeParse({ bodyHtml: '   ' }).success).toBe(false);
    expect(addCommentSchema.safeParse({ bodyHtml: '' }).success).toBe(false);
  });
});
