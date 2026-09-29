/**
 * Pure text-manipulation helpers behind MarkdownEditor's toolbar. Every
 * function takes the textarea's current value and selection and returns
 * the next value plus where the selection should end up — deliberately
 * pure and DOM-free, so "does the caret land in the right place" is a
 * plain unit-test assertion instead of something only checkable by driving
 * a real textarea. MarkdownEditor.tsx is the only caller, and it's
 * responsible for the one DOM-touching step these can't do themselves:
 * calling `textarea.setSelectionRange(...)` AFTER the value commit lands,
 * not before.
 */

export interface TextSelection {
  start: number;
  end: number;
}

export interface EditOutcome {
  value: string;
  selection: TextSelection;
}

function lineBlockRange(text: string, sel: TextSelection): { lineStart: number; lineEnd: number } {
  const lineStart = text.lastIndexOf('\n', Math.max(sel.start - 1, 0)) + 1;
  const nextNewline = text.indexOf('\n', sel.end);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  return { lineStart, lineEnd };
}

/** Bold/italic/strikethrough/inline-code: wrap the selection in `marker` on
 * both sides. Toggles off (unwraps) when the selection is already wrapped
 * — either because the markers sit just outside it, or because the
 * selection itself was made including them. An empty selection inserts an
 * empty pair and parks the caret between the two markers, ready to type. */
export function toggleWrap(text: string, sel: TextSelection, marker: string): EditOutcome {
  const { start, end } = sel;
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);
  const m = marker.length;

  if (before.endsWith(marker) && after.startsWith(marker)) {
    const value = before.slice(0, before.length - m) + selected + after.slice(m);
    return { value, selection: { start: start - m, end: end - m } };
  }
  if (marker.length > 0 && selected.length >= m * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(m, selected.length - m);
    const value = before + inner + after;
    return { value, selection: { start, end: start + inner.length } };
  }

  const value = before + marker + selected + marker + after;
  return selected.length === 0
    ? { value, selection: { start: start + m, end: start + m } }
    : { value, selection: { start: start + m, end: end + m } };
}

/** Runs `transform` over every line the selection touches (from the start
 * of its first line to the end of its last), joins them back, and reports
 * a selection spanning the whole rewritten block — the natural "what did I
 * just do" result after a block-level toggle. */
function transformLines(
  text: string,
  sel: TextSelection,
  transform: (lines: string[]) => string[],
): EditOutcome {
  const { lineStart, lineEnd } = lineBlockRange(text, sel);
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const nextLines = transform(lines);
  const nextBlock = nextLines.join('\n');
  const value = text.slice(0, lineStart) + nextBlock + text.slice(lineEnd);
  return { value, selection: { start: lineStart, end: lineStart + nextBlock.length } };
}

function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

/** Shared engine for every fixed-prefix block toggle (heading, blockquote,
 * bullet list, task list): add `prefix` to every non-blank touched line, or
 * — if every non-blank touched line already starts with `stripPattern` —
 * remove it from all of them instead. A block of touched lines that's
 * entirely blank is left alone (nothing to prefix). */
function toggleFixedPrefix(
  text: string,
  sel: TextSelection,
  prefix: string,
  stripPattern: RegExp,
  // The "does this line already count as toggled on" check. Usually the
  // same as stripPattern, but heading needs these to differ: stripping has
  // to eat ANY heading level (so switching H2 -> H3 replaces rather than
  // stacking), while "already on" must mean exactly THIS level, or
  // switching levels would be misread as a toggle-off.
  testPattern: RegExp = stripPattern,
): EditOutcome {
  return transformLines(text, sel, (lines) => {
    const meaningful = lines.filter((l) => !isBlankLine(l));
    const alreadyAllPrefixed = meaningful.length > 0 && meaningful.every((l) => testPattern.test(l));
    return lines.map((line) => {
      if (isBlankLine(line)) return line;
      const stripped = line.replace(stripPattern, '');
      return alreadyAllPrefixed ? stripped : prefix + stripped;
    });
  });
}

export function toggleHeading(text: string, sel: TextSelection, level: 1 | 2 | 3 | 4 | 5 | 6): EditOutcome {
  const prefix = '#'.repeat(level) + ' ';
  const exactLevelPattern = new RegExp(`^#{${level}}\\s+`);
  return toggleFixedPrefix(text, sel, prefix, /^#{1,6}\s+/, exactLevelPattern);
}

export function toggleBlockquote(text: string, sel: TextSelection): EditOutcome {
  return toggleFixedPrefix(text, sel, '> ', /^>\s?/);
}

export function toggleBulletList(text: string, sel: TextSelection): EditOutcome {
  return toggleFixedPrefix(text, sel, '- ', /^[-*]\s+/);
}

export function toggleTaskList(text: string, sel: TextSelection): EditOutcome {
  return toggleFixedPrefix(text, sel, '- [ ] ', /^-\s+\[[ xX]\]\s+/);
}

/** Ordered lists renumber on every apply, since "renumber" is the one
 * behavior a fixed prefix can't express — 1., 2., 3.… over the touched,
 * non-blank lines, restarting at 1. Toggles off the same way the fixed
 * prefixes do: if every touched non-blank line already looks numbered, the
 * numbering is stripped instead of re-applied. */
export function toggleOrderedList(text: string, sel: TextSelection): EditOutcome {
  const ORDERED_RE = /^\d+\.\s+/;
  return transformLines(text, sel, (lines) => {
    const meaningful = lines.filter((l) => !isBlankLine(l));
    const alreadyAllOrdered = meaningful.length > 0 && meaningful.every((l) => ORDERED_RE.test(l));
    let n = 0;
    return lines.map((line) => {
      if (isBlankLine(line)) return line;
      const stripped = line.replace(ORDERED_RE, '');
      if (alreadyAllOrdered) return stripped;
      n += 1;
      return `${n}. ${stripped}`;
    });
  });
}

/** [selection](url), with the selection kept as the link text when there
 * was one; otherwise inserts placeholder link text. Either way the part
 * the person should edit next — the URL when there was a selection to
 * become the label, the placeholder text otherwise — ends up selected. */
export function insertLink(text: string, sel: TextSelection): EditOutcome {
  const { start, end } = sel;
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);

  if (selected.length > 0) {
    const urlPlaceholder = 'url';
    const value = `${before}[${selected}](${urlPlaceholder})${after}`;
    const urlStart = start + selected.length + 3; // "[" + selected + "]("
    return { value, selection: { start: urlStart, end: urlStart + urlPlaceholder.length } };
  }
  const textPlaceholder = 'text';
  const value = `${before}[${textPlaceholder}](url)${after}`;
  return { value, selection: { start: start + 1, end: start + 1 + textPlaceholder.length } };
}

export function insertHorizontalRule(text: string, sel: TextSelection): EditOutcome {
  const { start, end } = sel;
  const needsLeadingBreak = start > 0 && text[start - 1] !== '\n';
  const insert = `${needsLeadingBreak ? '\n\n' : ''}---\n\n`;
  const value = text.slice(0, start) + insert + text.slice(end);
  const caret = start + insert.length;
  return { value, selection: { start: caret, end: caret } };
}

/** Wraps the selection in a fenced code block, or (no selection) inserts an
 * empty one with the caret parked on the blank line inside it. */
export function insertCodeBlock(text: string, sel: TextSelection): EditOutcome {
  const { start, end } = sel;
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);
  const leadIn = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  const body = selected.length > 0 ? selected : '';
  const insert = `${leadIn}\`\`\`\n${body}\n\`\`\`\n`;
  const value = before + insert + after;
  const caretStart = start + leadIn.length + 4; // past the fence + newline
  const caretEnd = caretStart + body.length;
  return { value, selection: { start: caretStart, end: caretEnd } };
}

/** A 2x2 starter table with the caret on the first header cell — the one
 * piece of it that's actually worth previewing before typing over it. */
export function insertTable(text: string, sel: TextSelection): EditOutcome {
  const { start, end } = sel;
  const before = text.slice(0, start);
  const leadIn = before.length > 0 && !before.endsWith('\n') ? '\n\n' : '';
  const header = 'Header 1';
  const skeleton =
    `${leadIn}| ${header} | Header 2 |\n` + `| --- | --- |\n` + `| Cell | Cell |\n\n`;
  const value = before + skeleton + text.slice(end);
  const headerStart = start + leadIn.length + 2; // past "| "
  return { value, selection: { start: headerStart, end: headerStart + header.length } };
}

export function insertText(text: string, sel: TextSelection, insert: string): EditOutcome {
  const value = text.slice(0, sel.start) + insert + text.slice(sel.end);
  const caret = sel.start + insert.length;
  return { value, selection: { start: caret, end: caret } };
}

/** Replaces the `[from, to)` range (the "@query" the mention popup is
 * anchored on) with plain "@Name " text. */
export function insertMention(text: string, from: number, to: number, name: string): EditOutcome {
  const insert = `@${name} `;
  const value = text.slice(0, from) + insert + text.slice(to);
  const caret = from + insert.length;
  return { value, selection: { start: caret, end: caret } };
}

const BULLET_LINE_RE = /^(\s*)([-*])\s+(.*)$/;
const ORDERED_LINE_RE = /^(\s*)(\d+)([.)])\s+(.*)$/;
const TASK_LINE_RE = /^(\s*)([-*])\s+\[[ xX]\]\s+(.*)$/;

/**
 * Enter-key list continuation: called with the value/selection as they are
 * the instant Enter is pressed (before the browser's own newline lands).
 * Returns null when the current line isn't a list item and the default
 * newline should just happen normally.
 *
 *  - Enter on a non-empty list item continues the list: same marker (an
 *    ordered item's number incremented) on the new line.
 *  - Enter on an EMPTY list item (just typed "- " or "1. " and hit Enter
 *    with nothing after it) exits the list instead of continuing it
 *    forever — the line's marker is removed rather than repeated.
 */
export function continueList(text: string, sel: TextSelection): EditOutcome | null {
  if (sel.start !== sel.end) return null; // list continuation only applies to a plain caret
  const { lineStart } = lineBlockRange(text, sel);
  const line = text.slice(lineStart, sel.start);

  const task = TASK_LINE_RE.exec(line);
  if (task) {
    const [, indent, , content] = task;
    if (content.trim() === '') {
      const value = text.slice(0, lineStart) + text.slice(sel.start);
      return { value, selection: { start: lineStart, end: lineStart } };
    }
    const insert = `\n${indent}- [ ] `;
    return insertText(text, sel, insert);
  }

  const bullet = BULLET_LINE_RE.exec(line);
  if (bullet) {
    const [, indent, marker, content] = bullet;
    if (content.trim() === '') {
      const value = text.slice(0, lineStart) + text.slice(sel.start);
      return { value, selection: { start: lineStart, end: lineStart } };
    }
    const insert = `\n${indent}${marker} `;
    return insertText(text, sel, insert);
  }

  const ordered = ORDERED_LINE_RE.exec(line);
  if (ordered) {
    const [, indent, num, delim, content] = ordered;
    if (content.trim() === '') {
      const value = text.slice(0, lineStart) + text.slice(sel.start);
      return { value, selection: { start: lineStart, end: lineStart } };
    }
    const insert = `\n${indent}${Number(num) + 1}${delim} `;
    return insertText(text, sel, insert);
  }

  return null;
}
