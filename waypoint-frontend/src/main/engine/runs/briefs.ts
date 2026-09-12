import type { RunIntent } from '../types';
import type { LedgerComment, LedgerMember, LedgerTicket } from './ledgerClient';

/**
 * The brief a dispatched session is given as its first prompt — W5a,
 * ROAD-119 (docs/design/w5a-investigate-fix.md §2.3).
 *
 * Pure: everything it says comes in as arguments (the ticket, its
 * comments, the folder and branch facts, the verb), and what it says is
 * exactly what the ledger stores on the run as its first message, so the
 * trail holds what the agent was told. Three rules it keeps:
 *
 *  - the ticket context first, Waypoint's instructions for the verb last,
 *    so the person editing the brief in the preview sees the facts before
 *    the ask;
 *  - nothing that is a credential, a URL carrying a token, or a raw
 *    tracker account id — the same rule `agent/systemPrompt.ts` follows.
 *    Scrubbed here, on the way out, whatever the ticket or a comment
 *    carried;
 *  - the closing-message contract spelled out: main reads only the last
 *    assistant message of the turn (finalize.ts), so the brief tells the
 *    agent what to put in it.
 */

export interface BriefInput {
  ticket: LedgerTicket;
  /** Oldest first, as the ledger lists them; the brief keeps the newest MAX_BRIEF_COMMENTS. */
  comments: LedgerComment[];
  /** For naming authors; an unknown author is "a teammate". */
  members: LedgerMember[];
  /** The state's name, when known. */
  stateName: string | null;
  /** The repository as the person sees it (`~/waypoint-electron`), never a path with a secret in it. */
  repoDisplayPath: string;
  /** The branch the worktree will be on. */
  branch: string;
  baseRef: string | null;
  intent: RunIntent;
  /** *Something else…*: the person's instruction. */
  instructions?: string | null;
  /** *Something else…*: whether the session may edit files. */
  mayChangeFiles?: boolean;
  /** Fix: the approved root-cause comment from the latest Investigate (§1.9). */
  approvedRca?: string | null;
  /** Fix: the branch of an earlier Fix on the same ticket, named so the agent knows it exists (§2.9). */
  priorFixBranch?: string | null;
}

/** The newest comments the brief carries. */
export const MAX_BRIEF_COMMENTS = 20;
/** The most of a comment body the brief carries. */
export const MAX_COMMENT_CHARS = 2_000;
/** The most of the description the brief carries. */
export const MAX_DESCRIPTION_CHARS = 12_000;

const INTENT_VERB: Record<RunIntent, string> = {
  investigate: 'Investigate',
  fix: 'Fix',
  custom: 'Session',
};

/** "ROAD-116 · Investigate" — the run's title. */
export function briefTitle(identifier: string, intent: RunIntent): string {
  return `${identifier} · ${INTENT_VERB[intent]}`;
}

// --- scrubbing -------------------------------------------------------------

// A Jira mention the mapper did not strip, as wiki markup renders it.
const ACCOUNT_ID_MENTION = /\[~accountid:[^\]]+\]/g;
// Well-known credential shapes: GitHub tokens, Anthropic keys, AWS access
// key ids, Slack tokens, and a bearer header value.
const CREDENTIAL_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];
// A URL whose query names a secret-shaped parameter, or that carries
// userinfo (`https://user:pass@host`).
const URL = /\bhttps?:\/\/[^\s<>"')\]]+/g;
const SECRET_PARAM =
  /[?&](token|access_token|api_key|apikey|key|secret|sig|signature|password|auth)=/i;
const USERINFO = /^https?:\/\/[^/@\s]+:[^/@\s]+@/i;

/** Text with credentials, secret-bearing URLs and raw account ids removed. */
export function scrubBriefText(text: string): string {
  let out = text.replace(ACCOUNT_ID_MENTION, '@a teammate');
  for (const shape of CREDENTIAL_SHAPES) out = out.replace(shape, '[redacted]');
  out = out.replace(URL, (url) =>
    SECRET_PARAM.test(url) || USERINFO.test(url) ? '[link removed]' : url,
  );
  return out;
}

// A typed comment is stored as HTML; the brief wants text. Block tags
// become line breaks, the rest is dropped, and the handful of entities the
// editor emits are decoded. Not a sanitizer — the result goes to a model,
// not a page.
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|blockquote|pre|tr)\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The description's "Acceptance" section, when it has one: a heading or a
 * line starting with "Acceptance", up to the next heading. Null when the
 * description carries none — the brief then says nothing about it rather
 * than inventing criteria.
 */
export function acceptanceSection(description: string): string | null {
  const lines = description.split('\n');
  const start = lines.findIndex((l) =>
    /^\s*(#{1,6}\s*|\*\*)?acceptance\b/i.test(l),
  );
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*#{1,6}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const text = body.join('\n').trim();
  return text.length ? text : null;
}

function authorName(members: LedgerMember[], authorId: string): string {
  const m = members.find((x) => x.id === authorId);
  return m ? m.displayName || m.fullName : 'a teammate';
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

// The closing-message contract, common to every verb.
const CLOSING_RULE =
  "Waypoint reads only the final message of this turn — it files that message as a comment proposal on the ticket for a person to review — so put everything the ticket's readers need in it, written for them, not for Waypoint. Do not ask questions at the end; state what you found and what you would do next.";

function taskSection(input: BriefInput): string {
  switch (input.intent) {
    case 'investigate':
      return [
        '## Your task — Investigate',
        'Find the root cause. Read the code and its history, run read-only commands as you need. Do not change any file: this session is in plan mode and the ticket owner decides what happens next.',
        'End with one message: the root cause, the evidence (files and lines), the fix you would make, and anything you could not settle.',
        CLOSING_RULE,
      ].join('\n');
    case 'fix':
      return [
        '## Your task — Fix',
        `Implement the fix on this branch. Commit as you go with clear messages. Do not push, open a pull request, or touch anything outside this worktree; the branch is reviewed from Waypoint.${input.approvedRca ? ' Start from the approved root cause above; if the code says otherwise, say so in your closing message.' : ''}`,
        'End with one message: what you changed and why, the files touched, how you verified it, and anything left open. Waypoint files it as a comment and proposes moving the ticket to review.',
        CLOSING_RULE,
      ].join('\n');
    case 'custom': {
      const instructions = (input.instructions ?? '').trim();
      return [
        '## Your task',
        instructions || '(no instruction was given)',
        input.mayChangeFiles
          ? 'You may edit files on this branch; commit as you go. Do not push, open a pull request, or touch anything outside this worktree.'
          : 'Do not change any file: this session is in plan mode. Read, run read-only commands, and report.',
        'End with one message summarising the outcome.',
        CLOSING_RULE,
      ].join('\n');
    }
  }
}

/**
 * The brief, as text. Table-tested in briefs.test.ts for every intent
 * and for the scrub.
 */
export function buildBrief(input: BriefInput): string {
  const { ticket } = input;
  const parts: string[] = [];
  parts.push(
    `You are working on ${ticket.identifier} for the Waypoint team, in a fresh git worktree of the project's repository. The ticket and its discussion follow; your task is at the end.`,
  );

  const facts: string[] = [];
  if (ticket.priority) facts.push(`Priority: ${ticket.priority}`);
  if (input.stateName) facts.push(`State: ${input.stateName}`);
  parts.push(
    [
      `## Ticket ${ticket.identifier} — ${ticket.title}`,
      ...(facts.length ? [facts.join(' · ')] : []),
      clip(
        ticket.description?.trim() || '(no description)',
        MAX_DESCRIPTION_CHARS,
      ),
    ].join('\n'),
  );

  const acceptance = ticket.description
    ? acceptanceSection(ticket.description)
    : null;
  if (acceptance) {
    parts.push(['## Acceptance (from the ticket)', acceptance].join('\n'));
  }

  const newest = input.comments.slice(-MAX_BRIEF_COMMENTS);
  if (newest.length) {
    const omitted = input.comments.length - newest.length;
    parts.push(
      [
        `## Comments (${omitted > 0 ? `newest ${newest.length} of ${input.comments.length}, ` : ''}oldest first)`,
        ...newest.map(
          (c) =>
            `— ${authorName(input.members, c.authorId)}, ${when(c.createdAt)}:\n${clip(htmlToText(c.bodyHtml), MAX_COMMENT_CHARS)}`,
        ),
      ].join('\n'),
    );
  }

  if (input.intent === 'fix' && input.approvedRca) {
    parts.push(
      ['## Root cause, as approved', input.approvedRca.trim()].join('\n'),
    );
  }

  parts.push(
    [
      '## Where you are',
      `Repository: ${input.repoDisplayPath} (this session runs in a fresh worktree of it)`,
      `Branch: ${input.branch}${input.baseRef ? `, from ${input.baseRef}` : ''}`,
      ...(input.priorFixBranch
        ? [
            `An earlier Fix on this ticket left the branch ${input.priorFixBranch}; this worktree does not include it. Mention it in your closing message if it matters.`,
          ]
        : []),
      'A fresh worktree has no installed dependencies (no node_modules); install them if you need to build or run anything.',
    ].join('\n'),
  );

  parts.push(taskSection(input));
  return scrubBriefText(parts.join('\n\n'));
}
