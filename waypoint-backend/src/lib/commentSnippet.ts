/**
 * A comment's markdown source reduced to the plain words a notification row
 * quotes: formatting marks removed, code and images summarized, whitespace
 * collapsed, capped. Pure, and bounded: it runs inside the comment's write
 * transaction, so the input is cut to a few times the output cap BEFORE any
 * pattern runs — several of them re-scan from an unclosed opener, which on a
 * full 32 KB comment of "[[[[" or " _b _b" cost hundreds of milliseconds.
 */
export const SNIPPET_MAX = 240;
const INPUT_WINDOW = 4;

export function commentSnippet(markdown: string, max = SNIPPET_MAX): string {
  const text = markdown
    .slice(0, max * INPUT_WINDOW)
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
    // Emphasis and strikethrough marks — only at word edges, so snake_case
    // names and arithmetic like 2*3*4 keep their characters.
    .replace(/(?<![\p{L}\p{N}_*~])(\*\*|__|~~|\*|_)(?=\S)([^\n]*?\S)\1(?![\p{L}\p{N}_*~])/gu, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
