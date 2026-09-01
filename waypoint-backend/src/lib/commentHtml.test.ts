import { describe, it, expect } from 'vitest';
import { buildCopilotCommentHtml, COPILOT_DISCLOSURE, escapeHtml } from './commentHtml.js';

describe('escapeHtml', () => {
  it('escapes all five characters the frontend renderer escapes, ampersand first', () => {
    // Ampersand-first matters: escaping & after < would double-escape the
    // &lt; entities this function itself just produced.
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes an already-encoded entity rather than passing it through', () => {
    expect(escapeHtml('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
  });
});

describe('buildCopilotCommentHtml', () => {
  it('prefixes the escaped disclosure (with the display name) inline into the first paragraph', () => {
    const html = buildCopilotCommentHtml('Amaan', 'Fixed the nav bug.');
    expect(html).toBe(
      '<p><em>Hi, this is Copilot — Amaan’s agent — commenting on their behalf: </em>Fixed the nav bug.</p>',
    );
  });

  it('entity-escapes model-authored body content — a <script> tag cannot reach the stored html', () => {
    const html = buildCopilotCommentHtml('Amaan', '<script>alert(1)</script> done');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; done');
    expect(html).not.toContain('<script>');
  });

  it("escapes the display name too — a user named with < or ' can't break out of the <em> wrapper", () => {
    const html = buildCopilotCommentHtml(`<img src=x onerror=1> O'Brien`, 'hello');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=1&gt; O&#39;Brien');
  });

  it('splits the body on blank lines into <p> paragraphs, matching the seed data convention', () => {
    const html = buildCopilotCommentHtml('Amaan', 'First para.\n\nSecond para.\n\n\nThird.');
    expect(html).toBe(
      '<p><em>Hi, this is Copilot — Amaan’s agent — commenting on their behalf: </em>First para.</p>' +
        '<p>Second para.</p><p>Third.</p>',
    );
  });

  it('keeps single newlines inside one paragraph (only blank lines split)', () => {
    const html = buildCopilotCommentHtml('Amaan', 'line one\nline two');
    expect(html).toBe(
      '<p><em>Hi, this is Copilot — Amaan’s agent — commenting on their behalf: </em>line one\nline two</p>',
    );
  });

  it('still emits the disclosure paragraph for a whitespace-only body', () => {
    // The zod layer already blocks empty bodies; this is just the function's
    // own degenerate-input contract — never zero paragraphs of output.
    const html = buildCopilotCommentHtml('Amaan', '   ');
    expect(html).toBe(
      '<p><em>Hi, this is Copilot — Amaan’s agent — commenting on their behalf: </em></p>',
    );
  });
});

describe('COPILOT_DISCLOSURE', () => {
  it("interpolates the display name into Waypoint's standard disclosure line", () => {
    expect(COPILOT_DISCLOSURE('Priya')).toBe(
      'Hi, this is Copilot — Priya’s agent — commenting on their behalf: ',
    );
  });
});
