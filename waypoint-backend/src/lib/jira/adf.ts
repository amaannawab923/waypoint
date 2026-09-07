import { COPILOT_DISCLOSURE } from '../commentHtml.js';

/**
 * Atlassian Document Format ↔ this process.
 *
 * Two directions, deliberately in one file: reading (flattening an issue's
 * description or a comment body to plain text for the model) and writing
 * (building the ADF for a comment Copilot proposes). They share a format and
 * nothing else, but keeping them together is what makes it checkable that
 * the disclosure prefix this file writes is the one adfToPlainText would read
 * back.
 *
 * --- read: ADF → plain text ---------------------------------------------
 *
 * Jira's v3 REST API returns descriptions and comment bodies as ADF: a
 * nested node tree, not a string. Something has to flatten it, and plain text
 * is the right target here specifically because the consumer is a language
 * model — it reads prose, gains nothing from markup, and pays context for
 * every tag.
 *
 * waypoint-frontend/src/main/jira/jiraMap.ts solves the same problem for the
 * desktop app's renderer and is not importable from this process (different
 * npm project, no shared package). Its node-type coverage is the useful part
 * to have learned from, and this is a fresh implementation of the same idea
 * with a narrower job — no legacy wiki-markup fallback, no rendered-HTML
 * path — plus one thing that one lacks and needs: a depth bound.
 *
 * THE CONTRACT: this function degrades, it never throws. A malformed node
 * costs its own text and nothing else. It sits between an external system's
 * output and a tool result, so the alternative to degrading is one unusual
 * comment failing an entire read.
 */

/**
 * Nodes whose content is a block, and therefore ends a line.
 *
 * Without this, a description's paragraphs run together into one wall of
 * text — "Repro on staging onlyThe API returns 500" — which is a content
 * change, not a formatting one: it invents a sentence that was never written.
 */
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'taskItem',
  'panel',
  'rule',
  'tableRow',
  'tableHeader',
  'tableCell',
  'mediaSingle',
  'mediaGroup',
]);

/**
 * How deep the walk will go before it stops descending.
 *
 * ADF is user-authored and arrives over the network, so its depth is an
 * attacker-or-accident-controlled input to a recursive function — an
 * unbounded walk turns a pathologically nested body into a RangeError, which
 * (unlike a truncated description) is not something a caller can degrade
 * from. 100 is far past anything a human produces: deeply nested real content
 * is a list inside a table inside a panel, perhaps ten levels.
 */
const MAX_DEPTH = 100;

function attr(node: Record<string, unknown>, key: string): string {
  const attrs = node.attrs as Record<string, unknown> | undefined;
  const value = attrs?.[key];
  return typeof value === 'string' ? value : '';
}

/**
 * A card node's visible text. Jira auto-converts a pasted Jira/Confluence
 * link into an inlineCard, so a description consisting of one pasted link is
 * entirely represented by this node — falling through to the generic branch
 * would render it as an empty string.
 *
 * `data` or `url`, never both, per Atlassian's own wording.
 */
function cardText(node: Record<string, unknown>): string {
  const url = attr(node, 'url');
  if (url) return url;
  const data = (node.attrs as Record<string, unknown> | undefined)?.data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of ['url', 'title', 'name']) {
      if (typeof record[key] === 'string' && record[key]) return record[key] as string;
    }
  }
  return '';
}

function walk(node: unknown, depth: number): string {
  if (node == null || depth > MAX_DEPTH) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((child) => walk(child, depth + 1)).join('');
  if (typeof node !== 'object') return '';

  const record = node as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';

  if (type === 'text' && typeof record.text === 'string') return record.text;
  if (type === 'hardBreak') return '\n';
  // A mention's rendered label ("@Priya Raman"). The accountId in attrs is
  // deliberately not surfaced: it is an opaque identifier that means nothing
  // to a reader and is a small piece of directory data to leak into a
  // model's context for no benefit.
  if (type === 'mention') return attr(record, 'text');
  if (type === 'emoji') return attr(record, 'text') || attr(record, 'shortName');
  if (type === 'status') return attr(record, 'text');
  if (type === 'inlineCard') return cardText(record);
  if (type === 'blockCard' || type === 'embedCard') {
    const text = cardText(record);
    // Its own newline: a block card returns before the block set below is
    // consulted, so without this the URL glues to the next paragraph.
    return text ? `${text}\n` : '';
  }
  // An image contributes exactly one thing to plain text: its alt. A bug
  // filed as a single screenshot renders blank otherwise, which is content
  // loss rather than the formatting loss this whole conversion accepts.
  if (type === 'media' || type === 'mediaInline') {
    const alt = attr(record, 'alt');
    if (!alt) return '';
    return type === 'mediaInline' ? alt : `${alt}\n`;
  }
  if (type === 'expand' || type === 'nestedExpand') {
    // The title lives in attrs, so the generic path drops it — and it is
    // usually the heading its content sits under ("Acceptance criteria"),
    // which is a label, not decoration.
    const title = attr(record, 'title');
    const inner = walk(record.content, depth + 1);
    const body = title ? `${title}\n${inner}` : inner;
    return body.endsWith('\n') || !body ? body : `${body}\n`;
  }

  const inner = walk(record.content, depth + 1);
  if (!BLOCK_TYPES.has(type)) return inner;
  // Only add the line break if the content did not already end one. Blocks
  // nest — a listItem's child is a paragraph, a tableCell's child is a
  // paragraph — so appending unconditionally puts a blank line between every
  // pair of list items and inside every table cell. Tidy() collapses runs of
  // three or more, so this was not visible in a long document and was very
  // visible in a two-item bullet list.
  return inner.endsWith('\n') ? inner : `${inner}\n`;
}

/**
 * Flattens an ADF document (or a plain string, which older API versions and
 * intermediaries can still hand back) to tidied plain text.
 */
export function adfToPlainText(node: unknown): string {
  try {
    return tidy(walk(node, 0));
  } catch {
    // The contract above. Nothing in walk() is expected to throw, which is
    // exactly why this is here: an unexpected throw from a malformed body
    // must cost that body's text, not the whole tool call.
    return '';
  }
}

/** Collapses the ragged blank lines block flattening leaves behind. */
function tidy(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// -----------------------------------------------------------------------
// The other direction: building an ADF document to POST.
// -----------------------------------------------------------------------

/**
 * The minimum ADF this file emits. Deliberately not a general ADF type — the
 * only document this process ever builds is a Copilot comment, which is
 * paragraphs of plain text plus one italic disclosure run. Typing exactly
 * that keeps it obvious that nothing here can construct a mention, a link, or
 * anything else that would carry model-authored structure into Jira.
 */
export interface JiraAdfTextNode {
  type: 'text';
  text: string;
  marks?: { type: 'em' }[];
}

export interface JiraAdfParagraph {
  type: 'paragraph';
  content: JiraAdfTextNode[];
}

export interface JiraAdfDoc {
  type: 'doc';
  version: 1;
  content: JiraAdfParagraph[];
}

/**
 * The ADF body for a Copilot-authored Jira comment.
 *
 * The exact counterpart of lib/commentHtml.ts's buildCopilotCommentHtml, and
 * it borrows that function's whole discipline rather than re-deciding it:
 *
 *  - It runs at EXECUTE time, from the real acting account's display name.
 *    The model's propose_comment schema takes a plain-text `body` only, so
 *    the model can neither omit the self-disclosure nor spoof a different
 *    name into it.
 *  - It shares the SAME exported COPILOT_DISCLOSURE constant. A Jira comment
 *    and a Waypoint comment made by the same agent must say the same thing;
 *    two copies of that sentence is exactly how they would stop.
 *
 * What differs is escaping, and only because the target does. The HTML
 * builder has to entity-escape both the body and the display name because
 * they end up inside tags. ADF has no such hazard: text lives in a `text`
 * node's JSON string and is never parsed as markup, so escaping here would
 * put literal `&amp;` into a real Jira comment. The safety property is
 * structural instead — this function only ever emits `paragraph` and `text`,
 * so no input can become a node type it did not choose.
 *
 * One paragraph per non-empty line, matching what the desktop app's own
 * composer does (waypoint-frontend's buildCommentAdf): ADF has no bare
 * newline, so a `\n` that survives at all has to be a paragraph break.
 */
export function buildCopilotJiraCommentAdf(displayName: string, body: string): JiraAdfDoc {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const [first, ...rest] = lines;
  // The disclosure is its own text node inside the FIRST paragraph, italic,
  // running inline into the body — the same reading the HTML builder
  // produces, so the two renderings of one agent's comment look alike.
  //
  // When the body is empty or whitespace-only there is no first line to run
  // into, and the disclosure stands alone. The empty text node that a naive
  // `text: first ?? ''` would emit is not merely ugly: ADF forbids an empty
  // text node, and Jira rejects the whole comment with a 400.
  const firstParagraph: JiraAdfParagraph = {
    type: 'paragraph',
    content: [
      { type: 'text', text: COPILOT_DISCLOSURE(displayName), marks: [{ type: 'em' }] },
      ...(first ? [{ type: 'text' as const, text: first }] : []),
    ],
  };

  return {
    type: 'doc',
    version: 1,
    content: [
      firstParagraph,
      ...rest.map((line): JiraAdfParagraph => ({
        type: 'paragraph',
        content: [{ type: 'text', text: line }],
      })),
    ],
  };
}
