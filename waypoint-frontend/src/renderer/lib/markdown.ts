// Minimal markdown → HTML renderer. Originally purpose-built for previewing
// an agent's instructions file; now also used for Copilot chat replies (see
// CopilotPanel.tsx), which is why ordered lists were added — real Claude
// Code output leans on numbered steps far more than the agent-brief use
// case ever did. Tables were added for the same reason: once Copilot could
// answer questions grounded in real, tabular ticket data (issue #9's MCP
// tools), it started reaching for GFM pipe tables to present it — which
// previously rendered as literal `| a | b |` / `|---|---|` text, unreadable.
//
// ROAD-162 (comment rich-text): this is now ALSO the renderer behind the
// comment composer's live "Preview" tab (a markdown-source textarea, not a
// WYSIWYG editor — see the composer component), not just posted comments.
// That doubles the cost of any gap here: what a person sees while writing
// must be exactly what gets stored and displayed later, or the preview is a
// lie. That's why this pass adds blockquotes, strikethrough, horizontal
// rules, nested/task lists, images, h4–h6, autolinks, and hard line breaks
// on top of the original bold/italic/code/lists/tables/links — the toolbar
// and the "Markdown tips" affordance (see MARKDOWN_SYNTAX_HINTS below) both
// assume this function's vocabulary is now that complete.
//
// Still deliberately small rather than a full CommonMark implementation or
// a new dependency — no nested emphasis (`***bold italic***`), no spaced
// `- - -` horizontal rules, no link-reference definitions, no footnotes.
// Table alignment (`:---:` etc.) is intentionally not supported — parsed
// and ignored — matching that same "deliberately small" scope.
//
// The one property every feature below must preserve: escape-first. Raw
// input is run through escapeHtml() before any markdown syntax is ever
// looked for, so a typed `<script>` or `<img onerror=...>` can only ever
// become inert escaped text, never a live element — see the "comment
// rendering (markdown, XSS-safe)" suite in TicketDetailPage.test.tsx. Never
// interpolate un-escaped user text into the output.

// The one dependency this file has: a build-time-inlined constant (no
// runtime request, no side effect at import time — see httpClient.ts's own
// comment on it), needed below so the image allowlist can tell this app's
// own attachment host apart from anywhere else.
import { HTTP_API_BASE_URL } from '@/data/httpClient';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only these schemes are safe to hand to an <a href>: anything else
// (javascript:, data:, vbscript:, a bare quote/attribute breakout, etc.)
// renders as plain escaped text instead of a link, since the URL comes from
// LLM-generated chat content or a person's own comment, not a trusted
// source.
const SAFE_URL = /^(https?:|mailto:)/i;

// This app's own in-app route for a native ticket
// (/projects/:id/tickets/:identifier) — safe for the same reason SAFE_URL's
// schemes are: it can't be pointed at an external host. Allowlisted to the
// EXACT shape CopilotPanel.tsx's system prompt actually asks the model to
// emit, rather than a denylist of what to reject, on purpose (round-11
// review): a bare `startsWith('/') && !startsWith('//')` check still let
// `/\evil.example/x` through, since a browser's URL parser treats a
// backslash as a path separator for a standard scheme just like a forward
// slash — `\` collapses to `//`, an external host, the same redirect this
// guard exists to block. Denying `//` and `/\` one at a time invites a
// third variant next time; an allowlist of the two known-safe ids doesn't.
function isInAppPath(url: string): boolean {
  return /^\/projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,254}\/tickets\/[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(
    url,
  );
}

// Images get a *stricter* allowlist than links, deliberately: clicking a
// link is a deliberate action the reader chooses to take, but an <img> in
// a rendered comment loads automatically, with no click required. Letting
// `![x](https://anywhere)` through the same way a link does would turn
// every comment box into a tracking-pixel / IP-logging vector — paste an
// image tag pointed at your own server and you learn who opened the
// ticket and when, with no interaction from them at all. So unlike SAFE_URL
// above, a bare https?: scheme is NOT sufficient on its own for an image:
// the URL must resolve to THIS app's own attachment endpoint, either the
// relative form (`/attachments/<id>`, the shape the composer's own image
// upload produces) or that same path served from this app's configured API
// origin (`${HTTP_API_BASE_URL}/attachments/<id>` — see data/api.ts's
// attachmentUrl()). A foreign host that merely copies the `/attachments/x`
// path shape (e.g. `http://evil.example/attachments/x`) is still rejected —
// checking the path shape alone, without also pinning the origin, would
// only look disciplined while doing nothing to stop that. Anything else
// (including a plain external https image, and always `data:`) renders as
// escaped literal text, exactly like a rejected link does today.
const ATTACHMENT_PATH = /^\/attachments\/[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;

function isAllowedImageUrl(url: string): boolean {
  if (ATTACHMENT_PATH.test(url)) return true;
  if (url.startsWith(HTTP_API_BASE_URL)) {
    return ATTACHMENT_PATH.test(url.slice(HTTP_API_BASE_URL.length));
  }
  return false;
}

// One combined alternation, matched in a single left-to-right pass, rather
// than several separate `.replace()` passes chained together. That's not
// just tidier — it's what makes escape-first and "don't reformat inside
// code" both hold at once. If code spans were their own separate pass,
// whichever of {code, bold, links, autolink} ran first would plant real
// `<...>` tags into the string, and every later pass would then see those
// tags as plain characters and risk matching *inside* them (e.g. a bare
// `https://` typed inside `` `backticks` `` would get autolinked, or a URL
// captured for a link would get re-wrapped if it also looked like bold).
// With one pass, each character position is claimed by at most one
// alternative — whichever is listed first that matches at that position —
// so a code span always "wins" its own span before bold/italic/link/
// autolink ever see its contents, without needing separate lookaround
// guards to fake the same effect. Order matters: code and image before
// link (`![x](y)` must not be read as a link with an empty label after a
// stray `!`), bold before italic (so `**x**`'s own stars aren't first
// read as two single-star italics), autolink last (it's the fallback for
// any bare `https://…` the earlier, more specific alternatives didn't
// already consume as part of a `[label](url)` or `![alt](url)`).
const INLINE_RE =
  /`(?<code>[^`]+)`|!\[(?<imgAlt>[^\]]*)\]\((?<imgUrl>[^)]+)\)|\[(?<linkLabel>[^\]]+)\]\((?<linkUrl>[^)]+)\)|\*\*(?<bold>[^*]+)\*\*|~~(?<strike>[^~]+)~~|\*(?<italic>[^*]+)\*|(?<autolink>https?:\/\/[^\s<]+)/g;

function renderLinkOrFallback(
  label: string,
  url: string,
  fallback: string,
): string {
  if (SAFE_URL.test(url)) {
    return `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`;
  }
  if (isInAppPath(url)) {
    return `<a href="${url}">${label}</a>`;
  }
  return fallback;
}

function inline(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(INLINE_RE, (match, ...rest) => {
    // The last argument to a replacer callback for a regex with named
    // groups is the groups object (after the numbered captures, offset,
    // and whole string) — see MDN's String.prototype.replace.
    const groups = rest[rest.length - 1] as Record<string, string | undefined>;
    if (groups.code !== undefined) return `<code>${groups.code}</code>`;
    if (groups.imgUrl !== undefined) {
      return isAllowedImageUrl(groups.imgUrl)
        ? `<img src="${groups.imgUrl}" alt="${groups.imgAlt ?? ''}">`
        : match;
    }
    if (groups.linkUrl !== undefined) {
      return renderLinkOrFallback(
        groups.linkLabel ?? '',
        groups.linkUrl,
        match,
      );
    }
    if (groups.bold !== undefined) return `<strong>${groups.bold}</strong>`;
    if (groups.strike !== undefined) return `<del>${groups.strike}</del>`;
    if (groups.italic !== undefined) return `<em>${groups.italic}</em>`;
    if (groups.autolink !== undefined) {
      return renderLinkOrFallback(groups.autolink, groups.autolink, match);
    }
    return match;
  });
}

// A GFM table's separator row: cells of only dashes (optionally with
// leading/trailing colons for alignment, which is parsed but ignored — see
// the file header comment) separated by pipes, e.g. `|---|:--:|---|` or
// `--- | ---` without outer pipes. A bare `---` divider (no pipe at all) is
// NOT a separator row — since horizontal rules were added, it's parsed as
// one instead (see HR_RE below) — so a literal pipe character is required
// here, not just optional per the pattern below (which would otherwise
// match zero-pipe input too, since every `\|` in it is optional).
function isSeparatorRow(line: string): boolean {
  return (
    line.includes('|') &&
    line.includes('-') &&
    /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line.trim())
  );
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableStart(lines: string[], i: number): boolean {
  const raw = lines[i];
  const nextLine = lines[i + 1] ?? '';
  // A table is a row containing a pipe immediately followed by a separator
  // row whose cell count matches the header's — that lookahead (plus the
  // cell-count check) is what distinguishes a real table header from a
  // paragraph that merely happens to contain a `|`.
  return (
    raw.includes('|') &&
    isSeparatorRow(nextLine) &&
    splitTableRow(raw).length === splitTableRow(nextLine).length
  );
}

// A horizontal rule: three or more of the same divider character, alone on
// its line (only trailing/leading spaces allowed). Deliberately NOT
// supporting CommonMark's spaced variant (`- - -`) — that would collide
// with "a bullet list item whose text happens to be a couple of dashes",
// and disambiguating the two isn't worth it for how rarely anyone types a
// spaced-out divider by hand. Checked strictly after isTableStart() above,
// and the character class itself excludes `|`, so a real table's fenceless
// separator row (`--- | ---`) is never at risk of being misread as an hr.
const HR_RE = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/;

// Headings start one level below the source (`#` → h2, matching Docs'
// preview scale — this predates ROAD-162), extended here from a cap of
// `###`/h4 up through `######`. HTML has no h7, so a source level of 5 or
// 6 both collapse to h6 rather than the offset continuing past the top of
// the scale — a small, deliberate clamp, not a bug: nobody's mental model
// of "h4 through h6" needs a 6th distinct visual size that doesn't exist.
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

// A quoted line: up to 3 leading spaces (CommonMark's own tolerance), then
// `>`. Multi-line and nested quotes are both handled by recursion in
// renderLines() below, not by any extra state here — see the block-quote
// branch's comment for why.
const BLOCKQUOTE_RE = /^ {0,3}>/;
const BLOCKQUOTE_STRIP_RE = /^ {0,3}>[ ]?/;

interface ListMarker {
  indent: number;
  kind: 'ul' | 'ol' | 'task';
  /** The literal number typed, e.g. "1" or "5" — only meaningful for 'ol'. */
  number: string;
  /** Only meaningful for 'task'. */
  checked: boolean;
  content: string;
}

// Indentation is capped generously (not the tiny 0-6 the file used before
// nested lists existed) because indentation now carries real meaning: it's
// how a nested item says which parent it belongs to, not just cosmetic
// whitespace in front of a flat item. A few levels of "  " per nesting
// depth easily exceeds 6 columns three levels deep.
const BULLET_RE = /^( {0,40})[-*]\s+(.*)$/;
const ORDERED_RE = /^( {0,40})(\d+)[.)]\s+(.*)$/;
// `- [ ] ` / `- [x] ` / `- [X] ` — a bullet item whose text starts with a
// checkbox marker is a task item, not a literal "[ ]" the reader typed.
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

function parseListMarker(raw: string): ListMarker | null {
  const bullet = BULLET_RE.exec(raw);
  if (bullet) {
    const indent = bullet[1].length;
    const rest = bullet[2];
    const task = TASK_RE.exec(rest);
    if (task) {
      return {
        indent,
        kind: 'task',
        number: '',
        checked: task[1].toLowerCase() === 'x',
        content: task[2],
      };
    }
    return { indent, kind: 'ul', number: '', checked: false, content: rest };
  }
  const ordered = ORDERED_RE.exec(raw);
  if (ordered) {
    return {
      indent: ordered[1].length,
      kind: 'ol',
      number: ordered[2],
      checked: false,
      content: ordered[3],
    };
  }
  return null;
}

// True for any line that starts a new block (fence, table, hr, heading,
// blockquote, or list item). Shared by renderLines()'s own dispatch and by
// the plain-paragraph accumulator below, so the two can never disagree
// about where a paragraph has to stop — see the hard-line-break comment on
// why that agreement matters.
function isBlockStart(lines: string[], i: number): boolean {
  const raw = lines[i];
  return (
    raw.trim().startsWith('```') ||
    isTableStart(lines, i) ||
    HR_RE.test(raw) ||
    HEADING_RE.test(raw) ||
    BLOCKQUOTE_RE.test(raw) ||
    parseListMarker(raw) !== null
  );
}

// Renders one contiguous run of list items at exactly `indent`, recursing
// into consumeList() itself whenever the *next* item is indented deeper
// than the current one — which is what lets a nested list end up genuinely
// nested inside its parent's <li>...</li> (not just visually indented by
// coincidence), the same way a real markdown renderer's list nesting works.
// A run can contain a run of bullets, then switch to numbers, then to task
// items, etc: each kind change flushes the currently-open <ul>/<ol> and
// opens a fresh one, exactly like the pre-nesting version of this file did
// at the top level (see the "closes and reopens..." test) — nesting adds a
// dimension to that, it doesn't replace it.
function consumeList(
  lines: string[],
  start: number,
  indent: number,
): { html: string; next: number } {
  const groups: string[] = [];
  let currentKind: ListMarker['kind'] | null = null;
  let items: string[] = [];
  let firstNumber = '';
  let i = start;

  function flush() {
    if (currentKind === 'ul') {
      groups.push(`<ul>\n${items.join('\n')}\n</ul>`);
    } else if (currentKind === 'ol') {
      // start="N" only when a *newly opened* <ol> doesn't begin at 1 — most
      // often because a fenced code block or other content split one
      // numbered list into two separate <ol> elements (a code fence always
      // ends the run, see isBlockStart above); without this, "step 2"
      // rendered right after such a block would visibly restart at "1",
      // undercounting the real step count for the reader.
      const startAttr =
        firstNumber && firstNumber !== '1' ? ` start="${firstNumber}"` : '';
      groups.push(`<ol${startAttr}>\n${items.join('\n')}\n</ol>`);
    } else if (currentKind === 'task') {
      groups.push(`<ul class="task-list">\n${items.join('\n')}\n</ul>`);
    }
    items = [];
    currentKind = null;
  }

  while (i < lines.length) {
    const marker = parseListMarker(lines[i]);
    if (!marker || marker.indent !== indent) break;
    if (currentKind !== marker.kind) {
      flush();
      currentKind = marker.kind;
      firstNumber = marker.number;
    }
    i += 1;

    // If the very next line is a deeper-indented item, it's a nested list
    // that belongs INSIDE the <li> we're about to close, not a sibling of
    // it — recurse before closing the tag.
    let nested = '';
    const peek = i < lines.length ? parseListMarker(lines[i]) : null;
    if (peek && peek.indent > indent) {
      const res = consumeList(lines, i, peek.indent);
      nested = res.html;
      i = res.next;
    }

    if (marker.kind === 'task') {
      items.push(
        `<li><input type="checkbox" disabled${marker.checked ? ' checked' : ''}> ${inline(marker.content)}</li>${nested ? `\n${nested}` : ''}`,
      );
    } else {
      items.push(`<li>${inline(marker.content)}${nested}</li>`);
    }
  }
  flush();
  return { html: groups.join('\n'), next: i };
}

// The core block-level loop. Pulled out as its own function (rather than
// inlined in renderMarkdown, as the pre-ROAD-162 version of this file did)
// because blockquotes need to recurse into it: a `> quoted` line's content,
// once the leading `> ` is stripped off, is just markdown again — headings,
// lists, nested quotes, and all — and re-running the exact same block
// parser on that stripped content is what makes an `>> ` inside a `> `
// come out as a blockquote nested inside a blockquote, with no separate
// nesting-depth bookkeeping required.
function renderLines(lines: string[]): string {
  const out: string[] = [];
  let inCode = false;
  let i = 0;

  // One if/else-if chain per line, rather than the more typical shape for
  // a hand-rolled block parser (an early `if (x) { ...; continue; }` per
  // case) — this codebase's lint config disallows `continue`. Every branch
  // is responsible for pushing its own output and advancing `i`; none of
  // them fall through to another, so the exclusivity a `continue`-per-case
  // structure would give for free is instead just the ordinary semantics
  // of `else if`.
  while (i < lines.length) {
    const raw = lines[i];
    const fence = /^```(.*)$/.exec(raw.trim());
    const heading = HEADING_RE.exec(raw);
    const marker = parseListMarker(raw);

    if (fence) {
      if (inCode) {
        out.push('</code></pre>');
        inCode = false;
      } else {
        const lang = fence[1].trim();
        out.push(
          `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>`,
        );
        inCode = true;
      }
      i += 1;
    } else if (inCode) {
      out.push(escapeHtml(raw));
      i += 1;
    } else if (raw.trim() === '') {
      i += 1;
    } else if (isTableStart(lines, i)) {
      const headerRow = `<tr>${splitTableRow(raw)
        .map((cell) => `<th>${inline(cell)}</th>`)
        .join('')}</tr>`;
      const bodyRows: string[] = [];
      let j = i + 2; // skip the header row and the separator row
      while (
        j < lines.length &&
        lines[j].trim() !== '' &&
        lines[j].includes('|')
      ) {
        const cells = splitTableRow(lines[j])
          .map((cell) => `<td>${inline(cell)}</td>`)
          .join('');
        bodyRows.push(`<tr>${cells}</tr>`);
        j += 1;
      }
      out.push('<table>');
      out.push(`<thead>${headerRow}</thead>`);
      out.push(`<tbody>${bodyRows.join('')}</tbody>`);
      out.push('</table>');
      i = j;
    } else if (HR_RE.test(raw)) {
      out.push('<hr>');
      i += 1;
    } else if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
    } else if (BLOCKQUOTE_RE.test(raw)) {
      let j = i;
      const inner: string[] = [];
      while (j < lines.length && BLOCKQUOTE_RE.test(lines[j])) {
        inner.push(lines[j].replace(BLOCKQUOTE_STRIP_RE, ''));
        j += 1;
      }
      out.push(`<blockquote>\n${renderLines(inner)}\n</blockquote>`);
      i = j;
    } else if (marker) {
      const { html, next } = consumeList(lines, i, marker.indent);
      out.push(html);
      i = next;
    } else {
      // Plain paragraph text. Consecutive non-blank lines that aren't any
      // of the block types above are joined into ONE <p>, with a <br>
      // between each source line, rather than each line becoming its own
      // separate <p> (which is what this file did before ROAD-162). That
      // distinction matters once this function also drives the composer's
      // live preview: pressing Enter without a blank line in between is a
      // soft line break to the person typing, and rendering it as a whole
      // separate paragraph (with a paragraph's worth of vertical spacing)
      // visually contradicts what they just did. CommonMark distinguishes
      // a "hard" break (two trailing spaces) from a "soft" one (a bare
      // newline, meant to just become a space) — this renderer doesn't
      // make that distinction and treats both the same, as a <br>: a bare
      // newline inside a paragraph is far more often someone's intentional
      // line break (this is a comment box, not prose being hard-wrapped at
      // 80 columns) than text that's meant to visually run together, so
      // collapsing it to a space would silently lose the break the person
      // typed.
      const paraLines: string[] = [];
      let j = i;
      while (
        j < lines.length &&
        lines[j].trim() !== '' &&
        !isBlockStart(lines, j)
      ) {
        paraLines.push(lines[j].replace(/[ \t]+$/, ''));
        j += 1;
      }
      out.push(`<p>${paraLines.map(inline).join('<br>')}</p>`);
      i = j;
    }
  }

  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

export function renderMarkdown(src: string): string {
  return renderLines(src.split('\n'));
}

/**
 * A machine-readable description of the markdown syntax renderMarkdown()
 * actually understands, for the comment composer's "Markdown tips"
 * affordance. Generated by hand alongside every feature added above rather
 * than derived automatically, but the discipline is the same either way:
 * this list exists so the UI never advertises syntax the renderer would
 * just show back as literal text. Add an entry here in the same change
 * that adds support for it above — don't let the two drift apart.
 */
export interface MarkdownSyntaxHint {
  label: string;
  syntax: string;
}

export const MARKDOWN_SYNTAX_HINTS: readonly MarkdownSyntaxHint[] = [
  { label: 'Bold', syntax: '**bold**' },
  { label: 'Italic', syntax: '*italic*' },
  { label: 'Strikethrough', syntax: '~~strikethrough~~' },
  { label: 'Inline code', syntax: '`code`' },
  { label: 'Code block', syntax: '```\ncode\n```' },
  { label: 'Heading (h1–h6)', syntax: '# Heading' },
  { label: 'Link', syntax: '[label](https://example.com)' },
  { label: 'Autolink', syntax: 'https://example.com' },
  // A literal example rather than the placeholder-ish "![alt](url)": an
  // arbitrary `url` wouldn't actually pass the image allowlist (see
  // isAllowedImageUrl above), and every entry in this list is meant to be
  // something renderMarkdown will genuinely turn into the described markup
  // if fed straight to it — not just a shape that resembles the syntax.
  { label: 'Image', syntax: '![alt](/attachments/abc123)' },
  { label: 'Blockquote', syntax: '> quoted text' },
  { label: 'Bullet list', syntax: '- item' },
  { label: 'Numbered list', syntax: '1. item' },
  { label: 'Task list', syntax: '- [ ] to do' },
  { label: 'Table', syntax: '| A | B |\n|---|---|\n| 1 | 2 |' },
  { label: 'Horizontal rule', syntax: '---' },
  // Two lines with no blank line between them, not a single-line
  // instruction — this is the actual input that demonstrates the behavior
  // (see the "hard line breaks" comment on renderLines), so it's what a
  // "tips" UI can literally preview.
  { label: 'Line break (press Enter)', syntax: 'line one\nline two' },
];
