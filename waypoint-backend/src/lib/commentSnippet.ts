/**
 * A comment's markdown source reduced to the plain words a notification row
 * quotes: formatting marks removed, code and images summarized, whitespace
 * collapsed, capped.
 *
 * It runs inside the comment's write transaction, so every step is bounded:
 * fenced code is handled by one linear pass over the lines (so the prose
 * AFTER a pasted log or stack trace survives), and every pattern that could
 * otherwise re-scan from an unclosed opener carries an explicit length cap.
 * Unbounded, a 32 KB comment of "[[[[" or " _b _b" cost hundreds of ms.
 */
export const SNIPPET_MAX = 240;
/** The most of a comment ever looked at: the body limit is 32 KB. */
const INPUT_MAX = 16_000;

/** Fenced code blocks become " [code] ", in one pass over the lines. */
function stripFences(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (!inFence) out.push(' [code] ');
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}

// Word characters for the emphasis rule: a _ or * touching one of these is
// part of a name (my_var, 2*3), not formatting.
const W = '\\p{L}\\p{N}_*~';
const EMPHASIS = new RegExp(
  `(?<![${W}])(\\*\\*|__|~~|\\*|_)(?=\\S)([^\\n]{0,300}?\\S)\\1(?![${W}]|\\.[\\p{L}\\p{N}])`,
  'gu',
);

export function commentSnippet(markdown: string, max = SNIPPET_MAX): string {
  const text = stripFences(markdown.slice(0, INPUT_MAX))
    // Images: ![alt](url) — the alt text if any.
    .replace(/!\[([^\]\n]{0,200})\]\([^)\s]{0,2048}\)/g, (_m, alt: string) => (alt ? ` ${alt} ` : ' [image] '))
    // Links: [label](url) → label.
    .replace(/\[([^\]\n]{1,200})\]\([^)\s]{0,2048}\)/g, '$1')
    // Inline code keeps its text.
    .replace(/`([^`\n]{0,500})`/g, '$1')
    // Line-leading markers: headings, quotes, list bullets, task boxes.
    .replace(/^[ \t]*(#{1,6}[ \t]+|>+[ \t]?|[-*+][ \t]+(\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gm, '')
    // Emphasis and strikethrough marks — only at word edges, so snake_case,
    // __init__.py and arithmetic like 2*3*4 keep their characters.
    .replace(EMPHASIS, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
