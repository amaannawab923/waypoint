import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { JiraRichText } from './JiraRichText';

// This component's one hard rule: whatever else happens, the user's words
// must still show up. Every test here either renders formatting and checks
// it's real React output (not innerHTML), or breaks the ADF in some way and
// checks the text survives anyway.
describe('JiraRichText', () => {
  it('falls back to the plain text when adf is null', () => {
    render(<JiraRichText adf={null} fallback="Just plain text here." />);
    expect(screen.getByText('Just plain text here.')).toBeInTheDocument();
  });

  it('falls back to the plain text when adf is an empty object', () => {
    render(<JiraRichText adf={{}} fallback="Fallback wins." />);
    expect(screen.getByText('Fallback wins.')).toBeInTheDocument();
  });

  it('falls back to the plain text when adf is a bare array, not a doc', () => {
    render(
      <JiraRichText
        adf={[{ type: 'text', text: 'stray' }]}
        fallback="Not a document."
      />,
    );
    expect(screen.getByText('Not a document.')).toBeInTheDocument();
  });

  it('falls back to the plain text when adf is a primitive', () => {
    render(
      <JiraRichText
        adf={'just a string' as unknown}
        fallback="Primitive fallback."
      />,
    );
    expect(screen.getByText('Primitive fallback.')).toBeInTheDocument();
  });

  it('renders an empty doc as nothing, not the fallback', () => {
    const { container } = render(
      <JiraRichText adf={{ type: 'doc', content: [] }} fallback="" />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders a simple paragraph as real text content', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Hello from ADF.' }],
            },
          ],
        }}
        fallback="Hello from ADF."
      />,
    );
    expect(screen.getByText('Hello from ADF.')).toBeInTheDocument();
  });

  it('never uses dangerouslySetInnerHTML-style raw HTML injection', () => {
    // A paragraph whose text happens to look like markup must render as
    // literal text, not be interpreted.
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }],
            },
          ],
        }}
        fallback="<img src=x onerror=alert(1)>"
      />,
    );
    expect(
      screen.getByText('<img src=x onerror=alert(1)>'),
    ).toBeInTheDocument();
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });

  it('applies strong, em, strike, underline, code and link marks as real elements', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'gone', marks: [{ type: 'strike' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'under', marks: [{ type: 'underline' }] },
                { type: 'text', text: ' ' },
                { type: 'text', text: 'code', marks: [{ type: 'code' }] },
                { type: 'text', text: ' ' },
                {
                  type: 'text',
                  text: 'a link',
                  marks: [
                    { type: 'link', attrs: { href: 'https://example.com/x' } },
                  ],
                },
              ],
            },
          ],
        }}
        fallback="bold italic gone under code a link"
      />,
    );
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('gone').tagName).toBe('S');
    expect(screen.getByText('under').tagName).toBe('U');
    expect(screen.getByText('code').tagName).toBe('CODE');
    const link = screen.getByRole('link', { name: 'a link' });
    expect(link).toHaveAttribute('href', 'https://example.com/x');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders a mailto link', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'email me',
                  marks: [{ type: 'link', attrs: { href: 'mailto:a@b.com' } }],
                },
              ],
            },
          ],
        }}
        fallback="email me"
      />,
    );
    expect(screen.getByRole('link', { name: 'email me' })).toHaveAttribute(
      'href',
      'mailto:a@b.com',
    );
  });

  it('strips a javascript: href but keeps the link text visible', () => {
    // This is the exact malicious value safeHref must reject; the test is
    // meaningless without a real javascript: URL.
    // eslint-disable-next-line no-script-url
    const dangerousHref = 'javascript:alert(1)';
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'click me',
                  marks: [{ type: 'link', attrs: { href: dangerousHref } }],
                },
              ],
            },
          ],
        }}
        fallback="click me"
      />,
    );
    expect(screen.getByText('click me')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('strips a data: href but keeps the link text visible', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'click me',
                  marks: [
                    {
                      type: 'link',
                      attrs: {
                        href: 'data:text/html,<script>alert(1)</script>',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }}
        fallback="click me"
      />,
    );
    expect(screen.getByText('click me')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders headings with their own level', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: { level: 2 },
              content: [{ type: 'text', text: 'A heading' }],
            },
          ],
        }}
        fallback="A heading"
      />,
    );
    expect(
      screen.getByRole('heading', { level: 2, name: 'A heading' }),
    ).toBeInTheDocument();
  });

  it('clamps an out-of-range heading level instead of throwing', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: { level: 99 },
              content: [{ type: 'text', text: 'Too deep' }],
            },
          ],
        }}
        fallback="Too deep"
      />,
    );
    expect(
      screen.getByRole('heading', { level: 6, name: 'Too deep' }),
    ).toBeInTheDocument();
  });

  it('renders deeply nested bullet lists, all items reachable', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'top level' }],
                    },
                    {
                      type: 'bulletList',
                      content: [
                        {
                          type: 'listItem',
                          content: [
                            {
                              type: 'paragraph',
                              content: [{ type: 'text', text: 'second level' }],
                            },
                            {
                              type: 'bulletList',
                              content: [
                                {
                                  type: 'listItem',
                                  content: [
                                    {
                                      type: 'paragraph',
                                      content: [
                                        { type: 'text', text: 'third level' },
                                      ],
                                    },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }}
        fallback="top level\nsecond level\nthird level"
      />,
    );
    expect(screen.getByText('top level')).toBeInTheDocument();
    expect(screen.getByText('second level')).toBeInTheDocument();
    expect(screen.getByText('third level')).toBeInTheDocument();
    // Three nested <ul>s, one per level.
    expect(document.querySelectorAll('ul').length).toBe(3);
  });

  it('renders a code block with its language on the code element', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'codeBlock',
              attrs: { language: 'ts' },
              content: [{ type: 'text', text: 'const x = 1;' }],
            },
          ],
        }}
        fallback="const x = 1;"
      />,
    );
    const code = screen.getByText('const x = 1;');
    expect(code.tagName).toBe('CODE');
    expect(code).toHaveAttribute('data-language', 'ts');
    expect(code.closest('pre')).not.toBeNull();
  });

  it('renders a table inside a panel, and the table scrolls in its own container', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'panel',
              attrs: { panelType: 'warning' },
              content: [
                {
                  type: 'table',
                  content: [
                    {
                      type: 'tableRow',
                      content: [
                        {
                          type: 'tableHeader',
                          content: [
                            {
                              type: 'paragraph',
                              content: [{ type: 'text', text: 'Col' }],
                            },
                          ],
                        },
                      ],
                    },
                    {
                      type: 'tableRow',
                      content: [
                        {
                          type: 'tableCell',
                          content: [
                            {
                              type: 'paragraph',
                              content: [{ type: 'text', text: 'Cell value' }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }}
        fallback="Col\nCell value"
      />,
    );
    expect(screen.getByText('Col').closest('th')).not.toBeNull();
    expect(screen.getByText('Cell value').closest('td')).not.toBeNull();
    const table = screen.getByText('Cell value').closest('table');
    expect(table).not.toBeNull();
    // The table's own scroll container, not the page.
    const scrollContainer = table!.parentElement;
    expect(scrollContainer).toHaveClass('overflow-x-auto');
  });

  it('surfaces the text of a node type it does not handle, rather than dropping it', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              // Not a real ADF type — stands in for "a node type this
              // renderer does not yet cover".
              type: 'someFutureAtlassianNodeType',
              content: [
                {
                  type: 'text',
                  text: 'text only reachable via the unknown node',
                },
              ],
            },
          ],
        }}
        fallback="text only reachable via the unknown node"
      />,
    );
    expect(
      screen.getByText('text only reachable via the unknown node'),
    ).toBeInTheDocument();
  });

  it('drops an unknown node with no text silently, without throwing', () => {
    const { container } = render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [{ type: 'someWeirdNode', attrs: { foo: 'bar' } }],
        }}
        fallback=""
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders a mention by its label text, not the raw account id', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'mention',
                  attrs: { id: 'abc123', text: '@Priya Raman' },
                },
              ],
            },
          ],
        }}
        fallback="@Priya Raman"
      />,
    );
    expect(screen.getByText('@Priya Raman')).toBeInTheDocument();
    expect(screen.queryByText('abc123')).not.toBeInTheDocument();
  });

  it('renders an image node as a labelled placeholder, not a broken <img>', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'mediaSingle',
              content: [
                {
                  type: 'media',
                  attrs: { type: 'file', alt: 'screenshot of the crash' },
                },
              ],
            },
          ],
        }}
        fallback="screenshot of the crash"
      />,
    );
    expect(document.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText(/screenshot of the crash/)).toBeInTheDocument();
  });

  it('renders an inline image with no alt text as a placeholder without throwing', () => {
    const { container } = render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'See ' },
                { type: 'mediaInline', attrs: { type: 'file' } },
              ],
            },
          ],
        }}
        fallback="See "
      />,
    );
    expect(container.textContent).toContain('open in Jira to view');
  });

  it('renders a panel with an icon and its content', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'panel',
              attrs: { panelType: 'error' },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Something is broken.' }],
                },
              ],
            },
          ],
        }}
        fallback="Something is broken."
      />,
    );
    expect(screen.getByText('Something is broken.')).toBeInTheDocument();
  });

  it('falls back to the info panel style for an unrecognized panelType', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'panel',
              attrs: { panelType: 'not-a-real-type' },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Mystery panel.' }],
                },
              ],
            },
          ],
        }}
        fallback="Mystery panel."
      />,
    );
    expect(screen.getByText('Mystery panel.')).toBeInTheDocument();
  });

  it('renders a hard break as a line break, not a literal backslash-n', () => {
    const { container } = render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'line one' },
                { type: 'hardBreak' },
                { type: 'text', text: 'line two' },
              ],
            },
          ],
        }}
        fallback="line one\nline two"
      />,
    );
    // Both halves are real text content, and a genuine <br> sits between
    // them rather than a literal "\n" character.
    expect(container.textContent).toBe('line oneline two');
    expect(document.querySelector('br')).not.toBeNull();
  });

  it('renders a rule as an <hr>', () => {
    render(
      <JiraRichText
        adf={{ type: 'doc', content: [{ type: 'rule' }] }}
        fallback=""
      />,
    );
    expect(document.querySelector('hr')).not.toBeNull();
  });

  it('renders a blockquote', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'blockquote',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Quoted words.' }],
                },
              ],
            },
          ],
        }}
        fallback="Quoted words."
      />,
    );
    expect(
      screen.getByText('Quoted words.').closest('blockquote'),
    ).not.toBeNull();
  });

  it('renders an inline status lozenge', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'status', attrs: { text: 'BLOCKED', color: 'red' } },
              ],
            },
          ],
        }}
        fallback="BLOCKED"
      />,
    );
    expect(screen.getByText('BLOCKED')).toBeInTheDocument();
  });

  it('renders an inline date attribute as a calendar day', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'date', attrs: { timestamp: '1700000000000' } },
              ],
            },
          ],
        }}
        fallback="2023-11-14"
      />,
    );
    expect(screen.getByText('2023-11-14')).toBeInTheDocument();
  });

  it('renders an inlineCard by its url as a link', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'inlineCard',
                  attrs: { url: 'https://example.atlassian.net/wiki/x' },
                },
              ],
            },
          ],
        }}
        fallback="https://example.atlassian.net/wiki/x"
      />,
    );
    expect(
      screen.getByRole('link', {
        name: 'https://example.atlassian.net/wiki/x',
      }),
    ).toHaveAttribute('href', 'https://example.atlassian.net/wiki/x');
  });

  it('accepts a className on the outer wrapper for both the rendered and fallback paths', () => {
    const { rerender, container } = render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
          ],
        }}
        fallback="x"
        className="my-class"
      />,
    );
    expect(container.firstElementChild).toHaveClass('my-class');
    rerender(<JiraRichText adf={null} fallback="x" className="my-class" />);
    expect(container.firstElementChild).toHaveClass('my-class');
  });

  // ROAD-27 / docs/qa/manual-test-cases.md's JIRA-155: a pasted stack trace,
  // a base64 blob, or a long URL with no spaces must wrap instead of forcing
  // the drawer to scroll sideways. jsdom does not lay out text, so this
  // cannot prove a long token actually wraps at any real width — it only
  // proves the class that makes wrapping possible (`break-words`, i.e.
  // `overflow-wrap: break-word`) is present on the root, on both the
  // rendered-ADF path and the plain-text fallback path, since a document
  // that fails to parse as ADF must not lose this either. This is a class
  // assertion, not a layout measurement.
  it('carries the overflow-wrap class on its root on both the rendered and fallback paths', () => {
    const { rerender, container } = render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
          ],
        }}
        fallback="x"
      />,
    );
    expect(container.firstElementChild).toHaveClass('break-words');
    rerender(<JiraRichText adf={null} fallback="x" />);
    expect(container.firstElementChild).toHaveClass('break-words');
  });

  // ROAD-27: the one exception to that same wrap rule. A code block must
  // never wrap — it would scramble a stack trace's or a diff's indentation —
  // it scrolls horizontally inside its own container instead, the same
  // pattern already proven above for `table`. Also a class assertion, not a
  // layout measurement, for the same jsdom reason.
  it('scrolls a code block horizontally inside its own container instead of wrapping', () => {
    render(
      <JiraRichText
        adf={{
          type: 'doc',
          content: [
            {
              type: 'codeBlock',
              attrs: { language: 'text' },
              content: [{ type: 'text', text: 'a'.repeat(300) }],
            },
          ],
        }}
        fallback={'a'.repeat(300)}
      />,
    );
    const code = screen.getByText('a'.repeat(300));
    const pre = code.closest('pre');
    expect(pre).not.toBeNull();
    expect(pre).toHaveClass('overflow-x-auto');
  });
});
