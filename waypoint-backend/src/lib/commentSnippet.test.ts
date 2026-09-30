import { describe, expect, it } from 'vitest';
import { commentSnippet } from './commentSnippet.js';

describe('commentSnippet', () => {
  it('keeps the words and drops the markdown', () => {
    expect(
      commentSnippet('## Heads up\n\n> quoted\n- **bold** and _em_ and ~~gone~~\n- [a link](https://x.test) and `code`'),
    ).toBe('Heads up quoted bold and em and gone a link and code');
  });

  it('summarizes code blocks and images instead of quoting them', () => {
    expect(commentSnippet('see\n```ts\nconst x = 1;\n```\n![diagram](a.png) ![](b.png)')).toBe(
      'see [code] diagram [image]',
    );
  });

  it('keeps @mentions readable', () => {
    expect(commentSnippet('@Priya can you check the leader tab?')).toBe('@Priya can you check the leader tab?');
  });

  it('caps long text at a word boundary with an ellipsis', () => {
    const s = commentSnippet('word '.repeat(200), 40);
    expect(s.length).toBeLessThanOrEqual(41);
    expect(s.endsWith('…')).toBe(true);
    expect(s).not.toMatch(/ …$/);
  });

  it('is empty for a files-only comment', () => {
    expect(commentSnippet('   ')).toBe('');
  });
});
