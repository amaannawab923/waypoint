// Minimal markdown → HTML renderer. Originally purpose-built for previewing
// an agent's instructions file; now also used for Copilot chat replies (see
// CopilotPanel.tsx), which is why ordered lists were added — real Claude
// Code output leans on numbered steps far more than the agent-brief use
// case ever did. Tables were added for the same reason: once Copilot could
// answer questions grounded in real, tabular ticket data (issue #9's MCP
// tools), it started reaching for GFM pipe tables to present it — which
// previously rendered as literal `| a | b |` / `|---|---|` text, unreadable.
// Deliberately small rather than a full CommonMark implementation or a new
// dependency: headings, bold/italic, inline code, fenced code blocks,
// bullet/numbered lists, tables, links, and paragraphs cover both use cases
// without pulling in a markdown parser. Table alignment (`:---:` etc.) is
// intentionally not supported — parsed and ignored — matching that same
// "deliberately small" scope.
export function renderMarkdown(src: string): string {
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
  // or `--- | ---` without outer pipes.
  const isSeparatorRow = (line: string) =>
    /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line.trim()) &&
    line.includes('-');

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
    // separator row — that lookahead is what distinguishes a real table
    // header from a paragraph that merely happens to contain a `|`.
    if (raw.includes('|') && isSeparatorRow(lines[i + 1] ?? '')) {
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
      const level = heading[1].length + 1; // start at h2, matching Pages' preview scale
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
