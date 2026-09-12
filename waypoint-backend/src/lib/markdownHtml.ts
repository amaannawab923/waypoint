// The renderer's minimal markdown → HTML (waypoint-frontend/src/renderer/
// lib/markdown.ts), ported verbatim for the one place the backend turns
// model-authored markdown into stored HTML: a coding session's closing
// message, posted as a ticket comment when its proposal is approved
// (commentHtml.ts, origin agent_run). Keep the two in step — the Review
// card previews with the renderer's copy, the ticket shows this one.
// Everything is entity-escaped before any tag is added; links keep only
// http(s)/mailto.
export function renderMarkdownHtml(src: string): string {
  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // Only these schemes are safe to hand to an <a href>: anything else
  // (javascript:, data:, vbscript:, a bare quote/attribute breakout, etc.)
  // renders as plain escaped text instead of a link, since the URL comes
  // from LLM-generated chat content, not a trusted source.
  const SAFE_URL = /^(https?:|mailto:)/i;

  function inline(text: string): string {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) =>
      SAFE_URL.test(url)
        ? `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`
        : match,
    );
    return out;
  }

  // A GFM table's separator row: cells of only dashes (optionally with
  // leading/trailing colons for alignment, which is parsed but ignored —
  // see the file header comment) separated by pipes, e.g. `|---|:--:|---|`
  // or `--- | ---` without outer pipes. A bare `---` divider (no pipe at
  // all) is NOT a separator row — it's markdown's other, unrelated use of
  // dashes (a divider/hr-shaped line) — so a literal pipe character is
  // required, not just optional per the pattern below (which would
  // otherwise match zero-pipe input too, since every `\|` in it is
  // optional).
  const isSeparatorRow = (line: string) =>
    line.includes('|') &&
    line.includes('-') &&
    /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line.trim());

  const splitTableRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const lines = src.split('\n');
  const html: string[] = [];
  let inCode = false;
  // null when no list is open; otherwise which tag is currently open — a
  // bullet line while an <ol> is open (or vice versa) closes the old list
  // and opens the other, rather than nesting or misrendering.
  let listTag: 'ul' | 'ol' | null = null;

  function closeList() {
    if (listTag) {
      html.push(`</${listTag}>`);
      listTag = null;
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim().startsWith('```')) {
      if (inCode) {
        html.push('</code></pre>');
        inCode = false;
      } else {
        closeList();
        html.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html.push(escapeHtml(raw));
      continue;
    }

    // A table is a row containing a pipe immediately followed by a
    // separator row whose cell count matches the header's — that lookahead
    // (plus the cell-count check) is what distinguishes a real table header
    // from a paragraph that merely happens to contain a `|`, or from a
    // `---` divider that happens to follow one (a real GFM table's
    // separator row always has exactly as many cells as its header).
    const nextLine = lines[i + 1] ?? '';
    const isTableStart =
      raw.includes('|') &&
      isSeparatorRow(nextLine) &&
      splitTableRow(raw).length === splitTableRow(nextLine).length;
    if (isTableStart) {
      closeList();
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
      html.push('<table>');
      html.push(`<thead>${headerRow}</thead>`);
      html.push(`<tbody>${bodyRows.join('')}</tbody>`);
      html.push('</table>');
      i = j - 1; // the loop's own i += 1 lands on the first line after the table
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (heading) {
      closeList();
      const level = heading[1].length + 1; // start at h2, matching Docs' preview scale
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bulletItem = /^[-*]\s+(.*)$/.exec(raw);
    const orderedItem = /^(\d+)[.)]\s+(.*)$/.exec(raw);
    if (bulletItem || orderedItem) {
      const tag = bulletItem ? 'ul' : 'ol';
      if (listTag !== tag) {
        closeList();
        // start=N when a *newly opened* <ol> doesn't begin at 1 — most
        // often a numbered list a fenced code block or other content
        // splits into two separate <ol> elements in the output (a code
        // block always closes the list, see above); without this, "step 2"
        // rendered right after such a block visibly restarts at "1",
        // undercounting the real step count for the reader.
        const start =
          orderedItem && orderedItem[1] !== '1'
            ? ` start="${orderedItem[1]}"`
            : '';
        html.push(`<${tag}${start}>`);
        listTag = tag;
      }
      const content = bulletItem
        ? bulletItem[1]
        : (orderedItem as RegExpExecArray)[2];
      html.push(`<li>${inline(content)}</li>`);
      continue;
    }
    closeList();

    if (raw.trim() === '') continue;
    html.push(`<p>${inline(raw)}</p>`);
  }
  closeList();
  if (inCode) html.push('</code></pre>');

  return html.join('\n');
}
