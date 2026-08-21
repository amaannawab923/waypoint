// Minimal markdown → HTML renderer, purpose-built for previewing an agent's
// instructions file. Deliberately small rather than a full CommonMark
// implementation or a new dependency: headings, bold/italic, inline code,
// fenced code blocks, bullet lists, links, and paragraphs cover what an
// agent operating brief actually needs.
export function renderMarkdown(src: string): string {
  const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function inline(text: string): string {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return out;
  }

  const lines = src.split('\n');
  const html: string[] = [];
  let inCode = false;
  let listOpen = false;

  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      if (inCode) {
        html.push('</code></pre>');
        inCode = false;
      } else {
        if (listOpen) {
          html.push('</ul>');
          listOpen = false;
        }
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
      if (listOpen) {
        html.push('</ul>');
        listOpen = false;
      }
      const level = heading[1].length + 1; // start at h2, matching Pages' preview scale
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const listItem = /^[-*]\s+(.*)$/.exec(raw);
    if (listItem) {
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${inline(listItem[1])}</li>`);
      continue;
    }
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }

    if (raw.trim() === '') continue;
    html.push(`<p>${inline(raw)}</p>`);
  }
  if (listOpen) html.push('</ul>');
  if (inCode) html.push('</code></pre>');

  return html.join('\n');
}
