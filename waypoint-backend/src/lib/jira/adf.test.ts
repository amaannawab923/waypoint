import { describe, it, expect } from 'vitest';
import { adfToPlainText, buildCopilotJiraCommentAdf } from './adf.js';
import { COPILOT_DISCLOSURE, SESSION_DISCLOSURE } from '../commentHtml.js';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (value: string) => ({ type: 'text', text: value });

describe('adfToPlainText', () => {
  it('flattens a simple document', () => {
    expect(adfToPlainText(doc(para(text('Repro on staging only'))))).toBe('Repro on staging only');
  });

  it('separates block nodes so paragraphs do not run together', () => {
    // The failure this prevents is a content change, not a formatting one:
    // "onlyThe" is a sentence nobody wrote.
    const result = adfToPlainText(doc(para(text('Repro on staging only')), para(text('The API returns 500'))));
    expect(result).toBe('Repro on staging only\nThe API returns 500');
  });

  it('renders a mention by its label and never its accountId', () => {
    const mention = { type: 'mention', attrs: { id: '5b10a2844c20165700ede21g', text: '@Priya Raman' } };
    const result = adfToPlainText(doc(para(text('cc '), mention)));
    expect(result).toBe('cc @Priya Raman');
    expect(result).not.toContain('5b10a2844c20165700ede21g');
  });

  it('renders a pasted link, which Jira stores as an inlineCard', () => {
    // A description that is one pasted link is entirely this node — the
    // generic path would render it empty.
    const card = { type: 'inlineCard', attrs: { url: 'https://example.atlassian.net/wiki/x' } };
    expect(adfToPlainText(doc(para(card)))).toBe('https://example.atlassian.net/wiki/x');
  });

  it('reads a card that carries data instead of url', () => {
    const card = { type: 'blockCard', attrs: { data: { url: 'https://example.com/spec' } } };
    expect(adfToPlainText(doc(card))).toBe('https://example.com/spec');
  });

  it("renders an image's alt text, since a screenshot-only bug is otherwise blank", () => {
    const media = { type: 'media', attrs: { type: 'file', alt: 'error toast' } };
    const group = { type: 'mediaGroup', content: [media, { type: 'media', attrs: { alt: 'network tab' } }] };
    expect(adfToPlainText(doc(group))).toBe('error toast\nnetwork tab');
  });

  it('renders a status lozenge, which carries a word the reader needs', () => {
    expect(adfToPlainText(doc(para({ type: 'status', attrs: { text: 'BLOCKED' } })))).toBe('BLOCKED');
  });

  it("keeps an expand's title, which is the heading its content sits under", () => {
    const expand = {
      type: 'expand',
      attrs: { title: 'Acceptance criteria' },
      content: [para(text('Login works'))],
    };
    expect(adfToPlainText(doc(expand))).toBe('Acceptance criteria\nLogin works');
  });

  it('flattens list items onto their own lines', () => {
    const item = (value: string) => ({ type: 'listItem', content: [para(text(value))] });
    const list = { type: 'bulletList', content: [item('first'), item('second')] };
    expect(adfToPlainText(doc(list))).toBe('first\nsecond');
  });

  it('collapses ragged blank lines and trims', () => {
    expect(adfToPlainText(doc(para(text('a')), para(), para(), para(text('b'))))).toBe('a\n\nb');
  });

  it('returns a plain string unchanged', () => {
    // Older API versions and intermediaries can still hand back a string.
    expect(adfToPlainText('already plain')).toBe('already plain');
  });

  it('returns empty for null, undefined and non-node values', () => {
    expect(adfToPlainText(null)).toBe('');
    expect(adfToPlainText(undefined)).toBe('');
    expect(adfToPlainText(42)).toBe('');
    expect(adfToPlainText({ type: 'unknownFutureNode' })).toBe('');
  });

  it('degrades instead of throwing on a pathologically nested document', () => {
    // ADF is user-authored and arrives over the network, so its depth is not
    // this code's to trust. Unbounded recursion here would turn one unusual
    // comment into a RangeError that fails an entire read — a failure a
    // caller cannot degrade from, unlike a truncated description.
    let node: unknown = text('deep');
    for (let i = 0; i < 20_000; i += 1) node = para(node);
    expect(() => adfToPlainText(doc(node))).not.toThrow();
  });

  it('stops descending past the depth bound rather than returning partial garbage', () => {
    let node: unknown = text('buried');
    for (let i = 0; i < 500; i += 1) node = para(node);
    // Beyond the bound the text is simply not reached — an honest omission,
    // and the surrounding content still renders.
    const result = adfToPlainText(doc(para(text('visible')), node));
    expect(result).toContain('visible');
    expect(result).not.toContain('buried');
  });
});

describe('buildCopilotJiraCommentAdf', () => {
  it('runs the shared self-disclosure inline into the first line, italic', () => {
    const built = buildCopilotJiraCommentAdf('Max Chen', 'Reproduced on staging.');

    expect(built).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: COPILOT_DISCLOSURE('Max Chen'), marks: [{ type: 'em' }] },
            { type: 'text', text: 'Reproduced on staging.' },
          ],
        },
      ],
    });
  });

  // The SAME constant the Waypoint-comment path uses. One agent saying two
  // different things depending on which system it posted to is exactly what
  // sharing the constant prevents.
  it('says the same sentence the native comment path says', () => {
    const [first] = buildCopilotJiraCommentAdf('Max Chen', 'x').content;

    expect(first.content[0].text).toBe(COPILOT_DISCLOSURE('Max Chen'));
  });

  it('gives each further line its own paragraph — ADF has no bare newline', () => {
    const built = buildCopilotJiraCommentAdf('Max Chen', 'First.\nSecond.\n\nThird.');

    expect(built.content).toHaveLength(3);
    expect(built.content[1]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Second.' }],
    });
    expect(built.content[2].content[0].text).toBe('Third.');
  });

  // An empty text node is invalid ADF and Jira 400s the whole comment, so a
  // whitespace-only body has to leave the disclosure standing alone rather
  // than emit `{ type: 'text', text: '' }` beside it.
  it('emits no empty text node when there is no body to run into', () => {
    const built = buildCopilotJiraCommentAdf('Max Chen', '   \n\n  ');

    expect(built.content).toHaveLength(1);
    expect(built.content[0].content).toHaveLength(1);
  });

  // ADF text is JSON, never markup: escaping here would put a literal
  // "&amp;" into a real Jira comment, which is the bug this pins against.
  it('does not entity-escape — that is the HTML path’s problem, not this one', () => {
    const built = buildCopilotJiraCommentAdf('O’Brien & Co <ops>', 'a < b && c > d');

    expect(built.content[0].content[1].text).toBe('a < b && c > d');
    expect(built.content[0].content[0].text).toContain('O’Brien & Co <ops>');
  });

  it('round-trips through the reader in this same file', () => {
    const built = buildCopilotJiraCommentAdf('Max Chen', 'First.\n\nSecond.');

    expect(adfToPlainText(built)).toBe(`${COPILOT_DISCLOSURE('Max Chen')}First.\nSecond.`);
  });
});

// W5b (ROAD-126): a run's report on a Jira issue — the session's disclosure
// and the markdown-lite rendering, so the comment reads on the issue as it
// reads on the Review card, never as a wall of `##` lines.
describe('buildCopilotJiraCommentAdf for a session (origin agent_run)', () => {
  it('opens with the session disclosure on its own line, the same constant the HTML path uses', () => {
    const built = buildCopilotJiraCommentAdf('Amaan', 'The retry path.', 'agent_run');

    expect(built.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: SESSION_DISCLOSURE('Amaan'), marks: [{ type: 'em' }] }],
    });
    expect(built.content[1]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'The retry path.' }],
    });
  });

  it('renders headings, lists, fenced code and rules as their ADF nodes', () => {
    const body = [
      '## Root cause',
      'The retry loop in `api/retry.ts` never resets **attempts**.',
      '',
      '- `retry.ts:41` — the counter',
      '- `retry.ts:58` — the reset that never runs',
      '  continued on the next line',
      '',
      '1. Reproduce with the test',
      '2. Fix',
      '',
      '```ts',
      'attempts = 0;',
      '```',
      '',
      '---',
      'Done.',
    ].join('\n');

    const [, heading, para, bullets, numbers, code, rule, last] = buildCopilotJiraCommentAdf(
      'Amaan',
      body,
      'agent_run',
    ).content;

    expect(heading).toEqual({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Root cause' }],
    });
    expect(para).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'The retry loop in ' },
        { type: 'text', text: 'api/retry.ts', marks: [{ type: 'code' }] },
        { type: 'text', text: ' never resets ' },
        { type: 'text', text: 'attempts', marks: [{ type: 'strong' }] },
        { type: 'text', text: '.' },
      ],
    });
    expect(bullets.type).toBe('bulletList');
    expect((bullets as { content: unknown[] }).content).toHaveLength(2);
    type Item = { content: { content: { text: string }[] }[] };
    const second = (bullets as { content: Item[] }).content[1].content[0].content;
    expect(second.map((n) => n.text).join('')).toBe(
      'retry.ts:58 — the reset that never runs continued on the next line',
    );
    expect(numbers.type).toBe('orderedList');
    expect(code).toEqual({
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [{ type: 'text', text: 'attempts = 0;' }],
    });
    expect(rule).toEqual({ type: 'rule' });
    expect(last).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Done.' }] });
  });

  // Jira rejects a document carrying an empty text node; blank lines,
  // empty headings and an empty fence must not produce one.
  it('never emits an empty text node', () => {
    const built = buildCopilotJiraCommentAdf('Amaan', '\n\n#  \n\n```\n```\n\n- \n', 'agent_run');
    const texts: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (record.type === 'text') texts.push(String(record.text));
      walk(record.content);
    };
    walk(built.content);
    expect(texts.every((t) => t.length > 0)).toBe(true);
    // A lone `#` or `-` is literal text, not an empty heading or item; the
    // blank lines and the empty fence produced nothing.
    expect(texts).toEqual([SESSION_DISCLOSURE('Amaan'), '#', '-']);
    expect(built.content.some((b) => b.type === 'codeBlock')).toBe(false);
  });

  it('keeps Copilot’s own comments exactly as before — inline disclosure, a paragraph per line', () => {
    const built = buildCopilotJiraCommentAdf('Max Chen', '## Not a heading\nSecond.');

    expect(built.content).toHaveLength(2);
    expect(built.content[0].type).toBe('paragraph');
    expect((built.content[0] as { content: { text: string }[] }).content.map((n) => n.text)).toEqual([
      COPILOT_DISCLOSURE('Max Chen'),
      '## Not a heading',
    ]);
  });

  it('round-trips through the reader in this same file', () => {
    const built = buildCopilotJiraCommentAdf('Amaan', '## Root cause\n- one\n- two', 'agent_run');

    expect(adfToPlainText(built)).toBe(`${SESSION_DISCLOSURE('Amaan')}\nRoot cause\none\ntwo`);
  });
});
