/**
 * A comment's markdown source reduced to the plain words a notification row
 * quotes: formatting marks removed, code and images summarized, whitespace
 * collapsed, capped. Pure and linear-time — it runs inside the comment's
 * write transaction.
 */
export const SNIPPET_MAX = 240;

export function commentSnippet(markdown: string, max = SNIPPET_MAX): string {
  const text = markdown
    // Fenced code blocks: the contents aren't prose.
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    // Images: ![alt](url) — the alt text if any.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? ` ${alt} ` : ' [image] '))
    // Links: [label](url) → label.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Inline code keeps its text.
    .replace(/`([^`]*)`/g, '$1')
    // Line-leading markers: headings, quotes, list bullets, task boxes.
    .replace(/^[ \t]*(#{1,6}[ \t]+|>+[ \t]?|[-*+][ \t]+(\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gm, '')
    // Emphasis and strikethrough marks.
    .replace(/(\*\*|__|~~|\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
