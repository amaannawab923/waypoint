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

  it('renders a GFM pipe table, applying inline formatting inside cells', () => {
    const result = renderMarkdown(
      '| Ticket | Owner |\n|---|---|\n| LAUNCH-3 | **Lena** |\n| LAUNCH-7 | Amaan |',
    );
    expect(result).toBe(
      '<table>\n' +
        '<thead><tr><th>Ticket</th><th>Owner</th></tr></thead>\n' +
        '<tbody><tr><td>LAUNCH-3</td><td><strong>Lena</strong></td></tr><tr><td>LAUNCH-7</td><td>Amaan</td></tr></tbody>\n' +
        '</table>',
    );
  });

  it('renders a table with no body rows (header + separator only)', () => {
    const result = renderMarkdown('| A | B |\n|---|---|');
    expect(result).toBe(
      '<table>\n<thead><tr><th>A</th><th>B</th></tr></thead>\n<tbody></tbody>\n</table>',
    );
  });

  it('ends a table at the first blank line or non-pipe line, resuming normal parsing after', () => {
    const result = renderMarkdown(
      '| A | B |\n|---|---|\n| 1 | 2 |\n\nafter the table',
    );
    expect(result).toBe(
      '<table>\n<thead><tr><th>A</th><th>B</th></tr></thead>\n<tbody><tr><td>1</td><td>2</td></tr></tbody>\n</table>\n<p>after the table</p>',
    );
  });

  it('does not treat a plain paragraph containing a pipe as a table — the separator-row lookahead is what triggers it', () => {
    const result = renderMarkdown('Cost | benefit analysis, not a table.');
    expect(result).toBe('<p>Cost | benefit analysis, not a table.</p>');
  });

  it('tolerates a table with no outer pipes on its rows', () => {
    const result = renderMarkdown('A | B\n--- | ---\n1 | 2');
    expect(result).toBe(
      '<table>\n<thead><tr><th>A</th><th>B</th></tr></thead>\n<tbody><tr><td>1</td><td>2</td></tr></tbody>\n</table>',
    );
  });

  // Regression test: a `---` divider is NOT a GFM table separator row —
  // previously the lookahead treated any `---`-shaped next line as one
  // regardless of whether it had a pipe, so a header line containing `|`
  // followed by a bare `---` divider rendered as a bogus one-row table,
  // swallowing the header line's own markup instead of leaving it as a
  // paragraph.
  it('does not treat a bare "---" divider (no pipe) as a table separator row', () => {
    const result = renderMarkdown('Use a | b syntax\n---\nnext para');
    expect(result).toBe(
      '<p>Use a | b syntax</p>\n<p>---</p>\n<p>next para</p>',
    );
  });

  it('does not treat a header/separator with mismatched cell counts as a table', () => {
    const result = renderMarkdown('A | B\n---|---|---\nrow');
    expect(result).toBe('<p>A | B</p>\n<p>---|---|---</p>\n<p>row</p>');
  });

  it('closes an open list before starting a table', () => {
    const result = renderMarkdown('- item\n| A |\n|---|\n| 1 |');
    expect(result).toBe(
      '<ul>\n<li>item</li>\n</ul>\n<table>\n<thead><tr><th>A</th></tr></thead>\n<tbody><tr><td>1</td></tr></tbody>\n</table>',
    );
  });
});
