import { describe, it, expect } from 'vitest';
import { adfToPlainText } from './adf.js';

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
