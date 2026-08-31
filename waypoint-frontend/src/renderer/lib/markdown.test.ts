import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders a plain paragraph', () => {
    expect(renderMarkdown('hello world')).toBe('<p>hello world</p>');
  });

  it('renders headings at h2/h3, starting one level below the source', () => {
    expect(renderMarkdown('# Title')).toBe('<h2>Title</h2>');
    expect(renderMarkdown('## Subtitle')).toBe('<h3>Subtitle</h3>');
  });

  it('renders bold, italic, and inline code', () => {
    expect(renderMarkdown('**bold**')).toBe('<p><strong>bold</strong></p>');
    expect(renderMarkdown('*italic*')).toBe('<p><em>italic</em></p>');
    expect(renderMarkdown('`code`')).toBe('<p><code>code</code></p>');
  });

  it('renders a link with target=_blank and rel=noreferrer', () => {
    expect(renderMarkdown('[Waypoint](https://example.com)')).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noreferrer">Waypoint</a></p>',
    );
  });

  it('renders mailto: links but does not turn other unsafe schemes into a link', () => {
    expect(renderMarkdown('[mail](mailto:a@b.com)')).toBe(
      '<p><a href="mailto:a@b.com" target="_blank" rel="noreferrer">mail</a></p>',
    );
    // javascript:/data:/vbscript: (and any other non-http(s)/mailto scheme)
    // must never reach an href — this content comes from LLM chat replies,
    // not a trusted source, and a clickable javascript: URL executes on click.
    expect(renderMarkdown('[click me](javascript:alert(1))')).toBe(
      '<p>[click me](javascript:alert(1))</p>',
    );
    expect(
      renderMarkdown('[x](data:text/html,<script>alert(1)</script>)'),
    ).toBe('<p>[x](data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;)</p>');
  });

  it('escapes quotes in the URL so a link cannot break out of the href attribute', () => {
    // A URL containing a literal `"` must not be able to close the href
    // attribute early and inject a new one (e.g. an onmouseover handler).
    const result = renderMarkdown(
      '[hover me](https://example.com" onmouseover="x)',
    );
    expect(result).not.toContain('onmouseover="x"');
    expect(result).toBe(
      '<p><a href="https://example.com&quot; onmouseover=&quot;x" target="_blank" rel="noreferrer">hover me</a></p>',
    );
  });

  it('renders a fenced code block, escaping its contents but not formatting them as inline markdown', () => {
    const result = renderMarkdown('```\nconst x = 1;\n**not bold**\n```');
    expect(result).toBe(
      '<pre><code>\nconst x = 1;\n**not bold**\n</code></pre>',
    );
    // The load-bearing part of this test: markdown syntax inside a fenced
    // block is escaped as literal text, never turned into <strong>/<em>/etc.
    expect(result).not.toContain('<strong>');
  });

  it('renders a bullet list', () => {
    const result = renderMarkdown('- one\n- two');
    expect(result).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
  });

  it('renders a numbered list with either "1." or "1)" markers', () => {
    expect(renderMarkdown('1. first\n2. second')).toBe(
      '<ol>\n<li>first</li>\n<li>second</li>\n</ol>',
    );
    expect(renderMarkdown('1) first\n2) second')).toBe(
      '<ol>\n<li>first</li>\n<li>second</li>\n</ol>',
    );
  });

  it('closes and reopens the list when switching between bullet and numbered items', () => {
    const result = renderMarkdown('- bullet\n1. numbered');
    expect(result).toBe(
      '<ul>\n<li>bullet</li>\n</ul>\n<ol>\n<li>numbered</li>\n</ol>',
    );
  });

  it('closes an open list before a heading, code block, or blank line', () => {
    expect(renderMarkdown('- item\n# Heading')).toBe(
      '<ul>\n<li>item</li>\n</ul>\n<h2>Heading</h2>',
    );
    expect(renderMarkdown('- item\n\nafter')).toBe(
      '<ul>\n<li>item</li>\n</ul>\n<p>after</p>',
    );
  });

  // Regression test: a code block always closes the current list (see
  // above), so "step 2" after a fenced block between steps became a
  // *second*, separately-numbered <ol> that visibly restarted at "1" —
  // undercounting the real step count for the reader. start="N" on the
  // reopened list is what keeps the visible numbering correct.
  it('continues numbering with start=N when an ordered list is split by a code block', () => {
    const result = renderMarkdown(
      '1. first step\n```\nsome command\n```\n2. second step',
    );
    expect(result).toBe(
      '<ol>\n<li>first step</li>\n</ol>\n<pre><code>\nsome command\n</code></pre>\n<ol start="2">\n<li>second step</li>\n</ol>',
    );
  });

  it('honors a list that genuinely starts at a number other than 1', () => {
    const result = renderMarkdown('5. fifth\n6. sixth');
    expect(result).toBe(
      '<ol start="5">\n<li>fifth</li>\n<li>sixth</li>\n</ol>',
    );
  });

  it('escapes HTML in plain text, list items, and headings — not just inline code', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(renderMarkdown('- <img src=x onerror=alert(1)>')).toBe(
      '<ul>\n<li>&lt;img src=x onerror=alert(1)&gt;</li>\n</ul>',
    );
  });

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n  ')).toBe('');
  });
});
