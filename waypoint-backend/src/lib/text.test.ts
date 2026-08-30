import { describe, it, expect } from 'vitest';
import { truncateTitle, DEFAULT_CONVERSATION_TITLE } from './text.js';

describe('truncateTitle', () => {
  it('returns short content unchanged', () => {
    expect(truncateTitle('hi there')).toBe('hi there');
  });

  it('trims surrounding whitespace', () => {
    expect(truncateTitle('  hi there  ')).toBe('hi there');
  });

  it('collapses internal whitespace, including newlines, to single spaces', () => {
    expect(truncateTitle('line one\nline two\n\nline three')).toBe('line one line two line three');
  });

  it('falls back to the default title for whitespace-only content', () => {
    expect(truncateTitle('   \n\t  ')).toBe(DEFAULT_CONVERSATION_TITLE);
  });

  it('returns content at exactly 60 chars unchanged', () => {
    const content = 'a'.repeat(60);
    expect(truncateTitle(content)).toBe(content);
  });

  it('truncates content over 60 chars to 59 chars plus an ellipsis', () => {
    const content = 'a'.repeat(80);
    const result = truncateTitle(content);
    expect(result).toBe(`${'a'.repeat(59)}…`);
    expect(result.length).toBe(60);
  });

  it('trims trailing whitespace introduced by truncation before the ellipsis', () => {
    const content = `${'a'.repeat(58)}  ${'b'.repeat(20)}`;
    const result = truncateTitle(content);
    expect(result.endsWith(' …')).toBe(false);
  });
});
