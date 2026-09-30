import { MARKDOWN_SYNTAX_HINTS, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders a plain paragraph', () => {
    expect(renderMarkdown('hello world')).toBe('<p>hello world</p>');
  });

  it('renders headings at h2/h3, starting one level below the source', () => {
    expect(renderMarkdown('# Title')).toBe('<h2>Title</h2>');
    expect(renderMarkdown('## Subtitle')).toBe('<h3>Subtitle</h3>');
  });

  it('extends headings through h4–h6, clamping past h6 since HTML has no h7', () => {
    expect(renderMarkdown('### Sub-subtitle')).toBe('<h4>Sub-subtitle</h4>');
    expect(renderMarkdown('#### Level 4')).toBe('<h5>Level 4</h5>');
    expect(renderMarkdown('##### Level 5')).toBe('<h6>Level 5</h6>');
    // A 6th source level would offset to h7, which doesn't exist — it
    // clamps to h6 rather than continuing past the top of the scale, the
    // same level level-5 headings land on.
    expect(renderMarkdown('###### Level 6')).toBe('<h6>Level 6</h6>');
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

  it('renders a root-relative in-app path as a link with no target/rel (same-window, not external)', () => {
    expect(renderMarkdown('[ROAD-40](/projects/proj-cw/tickets/ROAD-40)')).toBe(
      '<p><a href="/projects/proj-cw/tickets/ROAD-40">ROAD-40</a></p>',
    );
  });

  it('does not treat a protocol-relative URL as an in-app path — it could redirect to an external host', () => {
    expect(renderMarkdown('[x](//evil.example/y)')).toBe(
      '<p>[x](//evil.example/y)</p>',
    );
  });

  // Round-11 review: a bare `startsWith('/') && !startsWith('//')` check —
  // this file's own earlier version — still let this through. A browser's
  // URL parser treats `\` as a path separator for a standard scheme exactly
  // like `/`, so `/\evil.example/y` collapses to `//evil.example/y` at
  // resolution time: the same external-host redirect the `//` guard above
  // exists to block, just spelled with a backslash instead.
  it('does not treat a backslash-prefixed path as an in-app path either — it also collapses to a protocol-relative URL', () => {
    expect(renderMarkdown('[x](/\\evil.example/y)')).toBe(
      '<p>[x](/\\evil.example/y)</p>',
    );
  });

  it('rejects a traversal segment inside the ticket path shape', () => {
    expect(renderMarkdown('[x](/projects/p/tickets/..\\..\\admin)')).toBe(
      '<p>[x](/projects/p/tickets/..\\..\\admin)</p>',
    );
  });

  it('only treats the exact native-ticket path shape as an in-app link, not any single-leading-slash path', () => {
    expect(renderMarkdown('[x](/projects/proj-cw/tickets/ROAD-40/extra)')).toBe(
      '<p>[x](/projects/proj-cw/tickets/ROAD-40/extra)</p>',
    );
    expect(renderMarkdown('[x](/some/other/route)')).toBe(
      '<p>[x](/some/other/route)</p>',
    );
  });

  it('escapes quotes in the URL so a link cannot break out of the href attribute', () => {
    // A URL containing a literal `"` must not be able to close the href
    // attribute early and inject a new one (e.g. an onmouseover handler).
    const result = renderMarkdown(
      '[hover me](https://example.com" onmouseover="x)',
    );
    expect(result).not.toContain('onmouseover="x"');
    // Checked as real DOM, not as one exact string: the property that
    // matters is that no element ends up carrying a handler and no href
    // absorbs the injected text. (URLs can't contain spaces now, so this is
    // no longer one link at all; the bare https:// part autolinks with a
    // clean href and the rest stays inert text beside it.)
    const host = document.createElement('div');
    host.innerHTML = result;
    host.querySelectorAll('*').forEach((el) => {
      expect(el.getAttribute('onmouseover')).toBeNull();
    });
    host.querySelectorAll('a').forEach((a) => {
      expect(a.getAttribute('href')).toBe('https://example.com');
    });
  });

  it('renders a fenced code block, escaping its contents but not formatting them as inline markdown', () => {
    const result = renderMarkdown('```\nconst x = 1;\n**not bold**\n```');
    // No newline between <code> and the first line: inside <pre> it would
    // render as a blank line at the top of every block.
    expect(result).toBe('<pre><code>const x = 1;\n**not bold**</code></pre>');
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
      '<ol>\n<li>first step</li>\n</ol>\n<pre><code>some command</code></pre>\n<ol start="2">\n<li>second step</li>\n</ol>',
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
  // paragraph. Since horizontal rules were added, a bare `---` now renders
  // as an <hr> instead of literal text — see the "horizontal rule" suite —
  // but it must still never be mistaken for a table separator row.
  it('does not treat a bare "---" divider (no pipe) as a table separator row — renders as an hr instead', () => {
    const result = renderMarkdown('Use a | b syntax\n---\nnext para');
    expect(result).toBe('<p>Use a | b syntax</p>\n<hr>\n<p>next para</p>');
  });

  it('does not treat a header/separator with mismatched cell counts as a table', () => {
    // None of these three lines are a block construct on their own (the
    // middle line has pipes, so it isn't a bare hr either), so they merge
    // into one paragraph — see the "hard line breaks" suite — but the
    // load-bearing assertion is still that this never becomes a <table>.
    const result = renderMarkdown('A | B\n---|---|---\nrow');
    expect(result).toBe('<p>A | B<br>---|---|---<br>row</p>');
    expect(result).not.toContain('<table>');
  });

  it('closes an open list before starting a table', () => {
    const result = renderMarkdown('- item\n| A |\n|---|\n| 1 |');
    expect(result).toBe(
      '<ul>\n<li>item</li>\n</ul>\n<table>\n<thead><tr><th>A</th></tr></thead>\n<tbody><tr><td>1</td></tr></tbody>\n</table>',
    );
  });

  describe('strikethrough', () => {
    it('renders ~~text~~ as <del>', () => {
      expect(renderMarkdown('~~gone~~')).toBe('<p><del>gone</del></p>');
    });

    it('escapes HTML inside a strikethrough span', () => {
      expect(renderMarkdown('~~<script>alert(1)</script>~~')).toBe(
        '<p><del>&lt;script&gt;alert(1)&lt;/script&gt;</del></p>',
      );
    });
  });

  describe('horizontal rules', () => {
    it('renders a bare run of 3+ dashes, asterisks, or underscores as <hr>', () => {
      expect(renderMarkdown('---')).toBe('<hr>');
      expect(renderMarkdown('***')).toBe('<hr>');
      expect(renderMarkdown('___')).toBe('<hr>');
      expect(renderMarkdown('-----')).toBe('<hr>');
    });

    it('closes an open list before a horizontal rule', () => {
      expect(renderMarkdown('- item\n---')).toBe(
        '<ul>\n<li>item</li>\n</ul>\n<hr>',
      );
    });

    it('never fires inside a real table — the table check runs first', () => {
      const result = renderMarkdown('| A |\n|---|\n| 1 |');
      expect(result).not.toContain('<hr>');
      expect(result).toContain('<table>');
    });

    it('sits between two paragraphs as its own block', () => {
      expect(renderMarkdown('before\n\n---\n\nafter')).toBe(
        '<p>before</p>\n<hr>\n<p>after</p>',
      );
    });
  });

  describe('blockquotes', () => {
    it('renders a single-line blockquote', () => {
      expect(renderMarkdown('> quoted')).toBe(
        '<blockquote>\n<p>quoted</p>\n</blockquote>',
      );
    });

    it('joins consecutive quoted lines into one paragraph inside the blockquote', () => {
      expect(renderMarkdown('> line one\n> line two')).toBe(
        '<blockquote>\n<p>line one<br>line two</p>\n</blockquote>',
      );
    });

    it('renders a nested blockquote ("> >" or ">>") as a blockquote inside a blockquote', () => {
      expect(renderMarkdown('> outer\n>> inner')).toBe(
        '<blockquote>\n<p>outer</p>\n<blockquote>\n<p>inner</p>\n</blockquote>\n</blockquote>',
      );
    });

    it('renders markdown formatting inside a blockquote', () => {
      expect(renderMarkdown('> this is **bold**')).toBe(
        '<blockquote>\n<p>this is <strong>bold</strong></p>\n</blockquote>',
      );
    });

    it('closes the blockquote at the first non-"> " line', () => {
      expect(renderMarkdown('> quoted\nafter')).toBe(
        '<blockquote>\n<p>quoted</p>\n</blockquote>\n<p>after</p>',
      );
    });

    it("escapes HTML inside a blockquote — the known bug this fixes still can't become live markup", () => {
      expect(renderMarkdown('> <img src=x onerror=alert(1)>')).toBe(
        '<blockquote>\n<p>&lt;img src=x onerror=alert(1)&gt;</p>\n</blockquote>',
      );
    });
  });

  describe('nested lists', () => {
    it('nests a bullet list inside a bullet list item', () => {
      const result = renderMarkdown('- parent\n  - child\n- parent2');
      expect(result).toBe(
        '<ul>\n<li>parent<ul>\n<li>child</li>\n</ul></li>\n<li>parent2</li>\n</ul>',
      );
    });

    it('nests an ordered list inside a bullet list item (mixed kinds)', () => {
      const result = renderMarkdown('- parent\n  1. child');
      expect(result).toBe(
        '<ul>\n<li>parent<ol>\n<li>child</li>\n</ol></li>\n</ul>',
      );
    });

    it('supports multiple levels of nesting', () => {
      const result = renderMarkdown('- a\n  - b\n    - c');
      expect(result).toBe(
        '<ul>\n<li>a<ul>\n<li>b<ul>\n<li>c</li>\n</ul></li>\n</ul></li>\n</ul>',
      );
    });
  });

  describe('task lists', () => {
    it('renders "- [ ]" and "- [x]" as a disabled checkbox list', () => {
      const result = renderMarkdown('- [ ] todo\n- [x] done');
      expect(result).toBe(
        '<ul class="task-list">\n<li><input type="checkbox" disabled> todo</li>\n<li><input type="checkbox" disabled checked> done</li>\n</ul>',
      );
    });

    it('accepts an uppercase X too', () => {
      expect(renderMarkdown('- [X] done')).toContain(
        '<input type="checkbox" disabled checked>',
      );
    });

    it('the checkbox is always disabled — a comment is not an interactive form', () => {
      const result = renderMarkdown('- [ ] todo');
      expect(result).toContain('disabled');
    });

    it('escapes HTML inside a task item', () => {
      expect(renderMarkdown('- [ ] <script>alert(1)</script>')).toBe(
        '<ul class="task-list">\n<li><input type="checkbox" disabled> &lt;script&gt;alert(1)&lt;/script&gt;</li>\n</ul>',
      );
    });
  });

  describe('bounded cost (review round 1: a comment took a page down)', () => {
    it('renders 20,000 nested quotes without overflowing the stack, capped in depth', () => {
      // Used to throw "Maximum call stack size exceeded" at ~3,000, which
      // replaced the whole ticket page with an error for every reader.
      const result = renderMarkdown(`${'>'.repeat(20000)} boom`);
      expect((result.match(/<blockquote>/g) ?? []).length).toBe(8);
      expect(result).toContain('boom');
    });

    it('stays linear on unclosed link syntax, which used to be quadratic', () => {
      const started = Date.now();
      renderMarkdown('[a]('.repeat(51_200)); // 200 KB
      // The quadratic version took ~3.7 s here; the linear one ~0.2 s. The
      // bound sits between them with room for slow CI, so it fails on a
      // regression rather than just on a very slow machine.
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('never throws, whatever it is given', () => {
      const hostile = [
        '>'.repeat(50000),
        '['.repeat(100000),
        `a${' '.repeat(100000)}b`,
        '*'.repeat(100000),
        '```\n'.repeat(1000),
        Array.from({ length: 60 }, (_, i) => `${' '.repeat(i)}- x`).join('\n'),
      ];
      hostile.forEach((src) => expect(() => renderMarkdown(src)).not.toThrow());
    });
  });

  describe('inline correctness (review round 1)', () => {
    it('renders a link inside bold as a link, not literal brackets', () => {
      expect(renderMarkdown('**[a](https://a.com)**')).toBe(
        '<p><strong><a href="https://a.com" target="_blank" rel="noreferrer">a</a></strong></p>',
      );
    });

    it("keeps sentence punctuation out of an autolink's href", () => {
      expect(renderMarkdown('see https://example.com/x).')).toBe(
        '<p>see <a href="https://example.com/x" target="_blank" rel="noreferrer">https://example.com/x</a>).</p>',
      );
    });

    it('stops an autolink at an angle bracket, as in <https://a.com>', () => {
      expect(renderMarkdown('<https://a.com> ok')).toBe(
        '<p>&lt;<a href="https://a.com" target="_blank" rel="noreferrer">https://a.com</a>&gt; ok</p>',
      );
    });

    it('never nests a link inside a link label', () => {
      const html = renderMarkdown('[https://evil.com](https://good.com)');
      const host = document.createElement('div');
      host.innerHTML = html;
      const anchors = host.querySelectorAll('a');
      expect(anchors).toHaveLength(1);
      expect(anchors[0].getAttribute('href')).toBe('https://good.com');
      expect(anchors[0].textContent).toBe('https://evil.com');
    });

    it('keeps parentheses that genuinely belong to the URL', () => {
      const url = 'https://en.wikipedia.org/wiki/Foo_(bar)';
      expect(renderMarkdown(url)).toBe(
        `<p><a href="${url}" target="_blank" rel="noreferrer">${url}</a></p>`,
      );
    });

    it('puts a list nested under a task item inside that item', () => {
      expect(renderMarkdown('- [ ] parent\n  - child')).toBe(
        '<ul class="task-list">\n<li><input type="checkbox" disabled> parent<ul>\n<li>child</li>\n</ul></li>\n</ul>',
      );
    });
  });

  describe('image syntax (not supported; never a live <img>)', () => {
    // Images were dropped from the renderer: attachments already render
    // through the comment's attachment list with signed URLs, and a bare
    // markdown path could never carry the signature, so the "supported"
    // image was always a broken one. The syntax is still recognised so it
    // isn't mistaken for "!" + a link, and it renders back as typed.
    it("renders the syntax back as literal text, even for this app's own attachment path", () => {
      expect(renderMarkdown('![screenshot](/attachments/abc123)')).toBe(
        '<p>![screenshot](/attachments/abc123)</p>',
      );
      expect(renderMarkdown('![x](http://evil.example/x.png)')).toBe(
        '<p>![x](http://evil.example/x.png)</p>',
      );
      expect(renderMarkdown('![x](data:text/html,evil)')).toBe(
        '<p>![x](data:text/html,evil)</p>',
      );
    });

    it('never turns a javascript: image URL into a live element', () => {
      const result = renderMarkdown('![x](javascript:alert(1))');
      expect(result).not.toContain('<img');
      expect(result).toBe('<p>![x](javascript:alert(1))</p>');
    });

    it('escapes a script tag smuggled through a rejected data: image URL — stays inert text, never a live <img>', () => {
      const result = renderMarkdown(
        '![x](data:text/html,<script>alert(1)</script>)',
      );
      expect(result).not.toContain('<img');
      expect(result).not.toContain('<script>');
      expect(result).toBe(
        '<p>![x](data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;)</p>',
      );
    });
  });

  describe('autolinks', () => {
    it('turns a bare https:// URL in prose into a link', () => {
      expect(renderMarkdown('See https://example.com for details')).toBe(
        '<p>See <a href="https://example.com" target="_blank" rel="noreferrer">https://example.com</a> for details</p>',
      );
    });

    it('does not linkify a bare javascript: or other non-http(s) "URL" — it never matches the autolink pattern at all', () => {
      // Built via concatenation, not a `javascript:...` string literal —
      // eslint's no-script-url rule flags the literal spelling on sight,
      // even here where it's plain test input, never a navigable URL.
      const unsafeScheme = ['java', 'script:alert(1)'].join('');
      expect(renderMarkdown(unsafeScheme)).toBe(`<p>${unsafeScheme}</p>`);
    });

    it('escapes HTML immediately adjacent to an autolink instead of ever emitting a live tag', () => {
      const result = renderMarkdown(
        'https://evil.example/<script>alert(1)</script>',
      );
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
      // Still a safe, inert https:// link — the escaped text just becomes
      // part of the (harmless, non-executing) href/label string.
      expect(result).toContain('<a href="https://evil.example/');
    });
  });

  describe('hard line breaks', () => {
    it('joins two lines with no blank line between them into one paragraph with a <br>', () => {
      expect(renderMarkdown('line one\nline two')).toBe(
        '<p>line one<br>line two</p>',
      );
    });

    it('still starts a new paragraph when there IS a blank line between', () => {
      expect(renderMarkdown('para one\n\npara two')).toBe(
        '<p>para one</p>\n<p>para two</p>',
      );
    });

    it('trims a trailing hard-break marker (two spaces) rather than leaving a stray literal space before the <br>', () => {
      expect(renderMarkdown('line one  \nline two')).toBe(
        '<p>line one<br>line two</p>',
      );
    });

    it('joins three or more consecutive lines into a single paragraph', () => {
      expect(renderMarkdown('one\ntwo\nthree')).toBe(
        '<p>one<br>two<br>three</p>',
      );
    });
  });

  describe('MARKDOWN_SYNTAX_HINTS', () => {
    it('is non-empty and every entry has a label and syntax', () => {
      expect(MARKDOWN_SYNTAX_HINTS.length).toBeGreaterThan(0);
      MARKDOWN_SYNTAX_HINTS.forEach((hint) => {
        expect(hint.label.length).toBeGreaterThan(0);
        expect(hint.syntax.length).toBeGreaterThan(0);
      });
    });

    // The whole point of exporting this instead of hardcoding a list in the
    // UI: every advertised syntax must genuinely produce real markup when
    // run through the same renderMarkdown the UI itself uses, not just come
    // back as inert escaped text. If a future edit adds a hint for syntax
    // renderMarkdown doesn't actually support, this is the test that catches
    // the lie.
    // A substring, not full equality, for each label — the point isn't to
    // re-specify the whole renderer's output shape here (the tests above
    // and the feature table below already do that precisely), it's to
    // catch the specific lie this list exists to prevent: a hint whose
    // "syntax" renderMarkdown doesn't actually turn into that markup
    // (either because it never implemented the feature, or because the
    // literal example chosen doesn't survive some other rule — e.g. an
    // image example that fails the attachment allowlist). Every one of
    // these tags is genuinely absent from a plain, unrendered-markdown
    // passthrough of the same source, so finding it here proves the
    // feature actually fired.
    const expectedMarkupByLabel: Record<string, string> = {
      Bold: '<strong>',
      Italic: '<em>',
      Strikethrough: '<del>',
      'Inline code': '<code>',
      'Code block': '<pre><code>',
      'Heading (h1–h6)': '<h2>',
      Link: '<a href=',
      Autolink: '<a href=',
      Blockquote: '<blockquote>',
      'Bullet list': '<ul>',
      'Numbered list': '<ol>',
      'Task list': '<input type="checkbox"',
      Table: '<table>',
      'Horizontal rule': '<hr>',
      'Line break (press Enter)': '<br>',
    };

    it('every advertised syntax genuinely renders as the markup its label promises', () => {
      // If this fails because a label changed, update the map above in the
      // same change — it's a deliberate 1:1 mirror of the hints list, not
      // something that should silently drift.
      expect(Object.keys(expectedMarkupByLabel).sort()).toEqual(
        [...MARKDOWN_SYNTAX_HINTS.map((h) => h.label)].sort(),
      );
      MARKDOWN_SYNTAX_HINTS.forEach((hint) => {
        expect(renderMarkdown(hint.syntax)).toContain(
          expectedMarkupByLabel[hint.label],
        );
      });
    });
  });

  // The replacement for a round-trip test now that the comment composer is
  // a plain markdown-source textarea (Write/Preview tabs), not a TipTap
  // WYSIWYG editor with a JSON-to-markdown serializer to round-trip
  // through — see the file header comment. This is the flat "source in,
  // structure out" contract for every feature this renderer claims to
  // support, one row per feature, so a change that quietly regresses any of
  // them fails right here instead of in the live preview.
  describe('markdown source → HTML feature table', () => {
    const cases: Array<[label: string, source: string, expectedHtml: string]> =
      [
        ['bold', '**bold**', '<p><strong>bold</strong></p>'],
        ['italic', '*italic*', '<p><em>italic</em></p>'],
        ['strikethrough', '~~gone~~', '<p><del>gone</del></p>'],
        ['inline code', '`code`', '<p><code>code</code></p>'],
        [
          'fenced code block',
          '```\ncode\n```',
          '<pre><code>code</code></pre>',
        ],
        [
          'fenced code block with a language',
          '```ts\nconst x = 1;\n```',
          '<pre><code class="language-ts">const x = 1;</code></pre>',
        ],
        ['heading', '## Heading', '<h3>Heading</h3>'],
        [
          'link',
          '[Waypoint](https://example.com)',
          '<p><a href="https://example.com" target="_blank" rel="noreferrer">Waypoint</a></p>',
        ],
        [
          'autolink',
          'https://example.com',
          '<p><a href="https://example.com" target="_blank" rel="noreferrer">https://example.com</a></p>',
        ],
        [
          'blockquote',
          '> quoted',
          '<blockquote>\n<p>quoted</p>\n</blockquote>',
        ],
        [
          'bullet list',
          '- one\n- two',
          '<ul>\n<li>one</li>\n<li>two</li>\n</ul>',
        ],
        [
          'numbered list',
          '1. one\n2. two',
          '<ol>\n<li>one</li>\n<li>two</li>\n</ol>',
        ],
        [
          'nested list',
          '- a\n  - b',
          '<ul>\n<li>a<ul>\n<li>b</li>\n</ul></li>\n</ul>',
        ],
        [
          'task list',
          '- [ ] todo\n- [x] done',
          '<ul class="task-list">\n<li><input type="checkbox" disabled> todo</li>\n<li><input type="checkbox" disabled checked> done</li>\n</ul>',
        ],
        [
          'table',
          '| A | B |\n|---|---|\n| 1 | 2 |',
          '<table>\n<thead><tr><th>A</th><th>B</th></tr></thead>\n<tbody><tr><td>1</td><td>2</td></tr></tbody>\n</table>',
        ],
        ['horizontal rule', '---', '<hr>'],
        ['hard line break', 'one\ntwo', '<p>one<br>two</p>'],
      ];

    it.each(cases)('%s: %p → %p', (_label, source, expectedHtml) => {
      expect(renderMarkdown(source)).toBe(expectedHtml);
    });
  });
});
