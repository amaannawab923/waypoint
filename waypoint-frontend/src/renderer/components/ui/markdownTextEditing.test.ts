import {
  continueList,
  insertCodeBlock,
  insertHorizontalRule,
  insertLink,
  insertMention,
  insertTable,
  toggleBlockquote,
  toggleBulletList,
  toggleHeading,
  toggleOrderedList,
  toggleTaskList,
  toggleWrap,
  type TextSelection,
} from './markdownTextEditing';

function apply(outcome: { value: string; selection: TextSelection }) {
  return { text: outcome.value, sel: outcome.selection, at: outcome.value.slice(outcome.selection.start, outcome.selection.end) };
}

describe('toggleWrap', () => {
  it('wraps a selection', () => {
    const { text, at } = apply(toggleWrap('hello world', { start: 0, end: 5 }, '**'));
    expect(text).toBe('**hello** world');
    expect(at).toBe('hello');
  });

  it('unwraps when the markers sit just outside the selection', () => {
    const { text, sel } = apply(toggleWrap('**hello** world', { start: 2, end: 7 }, '**'));
    expect(text).toBe('hello world');
    expect(sel).toEqual({ start: 0, end: 5 });
  });

  it('unwraps when the selection includes the markers', () => {
    const { text } = apply(toggleWrap('**hello** world', { start: 0, end: 9 }, '**'));
    expect(text).toBe('hello world');
  });

  it('inserts an empty pair and parks the caret between them for an empty selection', () => {
    const { text, sel } = apply(toggleWrap('hello ', { start: 6, end: 6 }, '**'));
    expect(text).toBe('hello ****');
    expect(sel).toEqual({ start: 8, end: 8 });
  });

  it('does not double-wrap: applying twice to the same selection round-trips', () => {
    let sel: TextSelection = { start: 0, end: 5 };
    let text = 'hello';
    let out = toggleWrap(text, sel, '`');
    ({ value: text, selection: sel } = out);
    expect(text).toBe('`hello`');
    out = toggleWrap(text, sel, '`');
    ({ value: text, selection: sel } = out);
    expect(text).toBe('hello');
  });
});

describe('toggleHeading', () => {
  it('adds a heading prefix to the touched line', () => {
    const { text } = apply(toggleHeading('Title\nbody', { start: 0, end: 0 }, 2));
    expect(text).toBe('## Title\nbody');
  });

  it('toggles off when already at that level', () => {
    const { text } = apply(toggleHeading('## Title\nbody', { start: 0, end: 0 }, 2));
    expect(text).toBe('Title\nbody');
  });

  it('switches level rather than stacking', () => {
    const { text } = apply(toggleHeading('## Title', { start: 0, end: 0 }, 3));
    expect(text).toBe('### Title');
  });

  it('applies to every line the selection touches', () => {
    const { text } = apply(toggleHeading('one\ntwo\nthree', { start: 1, end: 6 }, 1));
    expect(text).toBe('# one\n# two\nthree');
  });
});

describe('toggleBlockquote', () => {
  it('adds and removes the quote prefix', () => {
    const wrapped = apply(toggleBlockquote('hello', { start: 0, end: 0 }));
    expect(wrapped.text).toBe('> hello');
    const unwrapped = apply(toggleBlockquote(wrapped.text, wrapped.sel));
    expect(unwrapped.text).toBe('hello');
  });
});

describe('toggleBulletList', () => {
  it('adds a bullet to every touched line and leaves blank lines alone', () => {
    const { text } = apply(toggleBulletList('a\n\nb', { start: 0, end: 4 }));
    expect(text).toBe('- a\n\n- b');
  });

  it('toggles off when every non-blank line already has a bullet', () => {
    const { text } = apply(toggleBulletList('- a\n- b', { start: 0, end: 7 }));
    expect(text).toBe('a\nb');
  });
});

describe('toggleTaskList', () => {
  it('adds an unchecked task prefix', () => {
    const { text } = apply(toggleTaskList('buy milk', { start: 0, end: 0 }));
    expect(text).toBe('- [ ] buy milk');
  });

  it('toggles off a checked or unchecked task line', () => {
    expect(apply(toggleTaskList('- [x] done', { start: 0, end: 0 })).text).toBe('done');
    expect(apply(toggleTaskList('- [ ] todo', { start: 0, end: 0 })).text).toBe('todo');
  });
});

describe('toggleOrderedList', () => {
  it('numbers every touched line starting at 1', () => {
    const { text } = apply(toggleOrderedList('a\nb\nc', { start: 0, end: 5 }));
    expect(text).toBe('1. a\n2. b\n3. c');
  });

  it('renumbers even if the source already has numbers, and toggles off on a second apply', () => {
    const first = apply(toggleOrderedList('5. a\n5. b', { start: 0, end: 9 }));
    expect(first.text).toBe('a\nb');
  });
});

describe('insertLink', () => {
  it('wraps a selection as link text and selects the url placeholder', () => {
    const { text, at } = apply(insertLink('see docs', { start: 4, end: 8 }));
    expect(text).toBe('see [docs](url)');
    expect(at).toBe('url');
  });

  it('inserts placeholder text and selects it when there is no selection', () => {
    const { text, at } = apply(insertLink('', { start: 0, end: 0 }));
    expect(text).toBe('[text](url)');
    expect(at).toBe('text');
  });
});

describe('insertHorizontalRule', () => {
  it('inserts a rule with surrounding blank lines', () => {
    const { text } = apply(insertHorizontalRule('above', { start: 5, end: 5 }));
    expect(text).toBe('above\n\n---\n\n');
  });
});

describe('insertCodeBlock', () => {
  it('wraps a selection in a fence', () => {
    const { text } = apply(insertCodeBlock('const x = 1;', { start: 0, end: 12 }));
    expect(text).toBe('```\nconst x = 1;\n```\n');
  });

  it('inserts an empty fenced block with the caret inside it when nothing is selected', () => {
    const { text, sel } = apply(insertCodeBlock('', { start: 0, end: 0 }));
    expect(text).toBe('```\n\n```\n');
    expect(sel).toEqual({ start: 4, end: 4 });
  });
});

describe('insertTable', () => {
  it('inserts a starter table with the first header cell selected', () => {
    const { text, at } = apply(insertTable('', { start: 0, end: 0 }));
    expect(text).toContain('| Header 1 | Header 2 |');
    expect(text).toContain('| --- | --- |');
    expect(at).toBe('Header 1');
  });
});

describe('insertMention', () => {
  it('replaces the @query range with plain "@Name "', () => {
    const text = 'hey @al';
    const { value, selection } = insertMention(text, 4, 7, 'Alice');
    expect(value).toBe('hey @Alice ');
    expect(selection).toEqual({ start: value.length, end: value.length });
  });
});

describe('continueList', () => {
  it('continues a bullet item onto the next line', () => {
    const text = '- one';
    const out = continueList(text, { start: text.length, end: text.length });
    expect(out).not.toBeNull();
    expect(out!.value).toBe('- one\n- ');
  });

  it('exits the list on Enter at an empty bullet item', () => {
    const text = '- one\n- ';
    const out = continueList(text, { start: text.length, end: text.length });
    expect(out).not.toBeNull();
    expect(out!.value).toBe('- one\n');
  });

  it('increments the number for an ordered item', () => {
    const text = '1. one';
    const out = continueList(text, { start: text.length, end: text.length });
    expect(out!.value).toBe('1. one\n2. ');
  });

  it('continues a task item with a fresh unchecked box', () => {
    const text = '- [x] done';
    const out = continueList(text, { start: text.length, end: text.length });
    expect(out!.value).toBe('- [x] done\n- [ ] ');
  });

  it('returns null on a plain (non-list) line', () => {
    expect(continueList('just text', { start: 9, end: 9 })).toBeNull();
  });

  it('returns null when there is a range selection, not a plain caret', () => {
    expect(continueList('- one', { start: 0, end: 3 })).toBeNull();
  });
});
