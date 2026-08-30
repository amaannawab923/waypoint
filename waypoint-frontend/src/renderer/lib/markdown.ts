// Minimal markdown → HTML renderer. Originally purpose-built for previewing
// an agent's instructions file; now also used for Copilot chat replies (see
// CopilotPanel.tsx), which is why ordered lists were added — real Claude
// Code output leans on numbered steps far more than the agent-brief use
// case ever did. Deliberately small rather than a full CommonMark
// implementation or a new dependency: headings, bold/italic, inline code,
// fenced code blocks, bullet/numbered lists, links, and paragraphs cover
// both use cases without pulling in a markdown parser.
export function renderMarkdown(src: string): string {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function inline(text: string): string {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    out = out.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );
    return out;
  }

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

  for (const raw of lines) {
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
      html.push(`${escapeHtml(raw)}\n`);
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
