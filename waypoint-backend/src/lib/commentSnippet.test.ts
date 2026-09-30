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

  it('leaves snake_case names and arithmetic alone', () => {
    expect(commentSnippet('rename my_var_name in some_file_name.ts')).toBe('rename my_var_name in some_file_name.ts');
    expect(commentSnippet('2*3*4 is 24, and **this** is bold')).toBe('2*3*4 is 24, and this is bold');
  });

  // It runs inside the comment's write transaction: a hostile 32 KB comment
  // (the body limit) must not hold the event loop.
  it.each([
    ['unclosed links', '['.repeat(32_767)],
    ['unclosed images', '!['.repeat(16_000)],
    ['unclosed emphasis', ' _b'.repeat(10_900)],
    ['unclosed fences', '```x\n'.repeat(6_000)],
    ['unclosed inline code', '`a'.repeat(16_000)],
    ['unclosed link urls', '[a]('.repeat(8_000)],
  ])('stays fast on %s', (_label, input) => {
    const t0 = performance.now();
    commentSnippet(input);
    expect(performance.now() - t0).toBeLessThan(25);
  });

  it('keeps the explanation that follows a pasted log', () => {
    const log = Array.from({ length: 40 }, (_, i) => `ERROR at frame ${i} in handler.ts`).join('\n');
    expect(commentSnippet(`\`\`\`\n${log}\n\`\`\`\nThe pager stops one page early — fix incoming.`)).toBe(
      '[code] The pager stops one page early — fix incoming.',
    );
  });

  it('turns a link with a very long URL into its label, never raw markdown', () => {
    const url = `https://example.test/${'a'.repeat(1_200)}`;
    expect(commentSnippet(`See [the dashboard](${url}) for the spike.`)).toBe('See the dashboard for the spike.');
  });

  it('leaves dunder names alone but still unbolds a sentence-final __word__.', () => {
    expect(commentSnippet('edit __init__.py first')).toBe('edit __init__.py first');
    expect(commentSnippet('this is __important__.')).toBe('this is important.');
  });
});
