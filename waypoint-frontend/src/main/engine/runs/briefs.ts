import type { RunIntent } from '../types';
import type { JiraWireComment, JiraWireTicket } from '../../jira/jiraTypes';
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

/**
 * The ticket as the brief needs it — the slice a native ticket
 * (`LedgerTicket`) and a Jira issue (jiraBriefTicket, below) both fill.
 * `priority` is whatever the system calls it: the ledger's word, or the
 * Jira site's own label.
 */
export type BriefTicket =
  | LedgerTicket
  | Pick<LedgerTicket, 'identifier' | 'title' | 'description' | 'priority'>;

/**
 * A comment as the brief reads it: the ledger's row (an author id the
 * members list names, an HTML body), or an already-named, already-flat one
 * — a Jira comment as main's mapper hands it over (the mapper strips
 * account ids; the name is the display name Jira showed).
 */
export type BriefComment =
  LedgerComment | { author: string; text: string; createdAt: string | null };

/** W5b: what the brief says about a Jira issue that a native ticket has no equivalent of. */
export interface JiraBriefFacts {
  /** `https://site/browse/ENG-4` — named so the agent can cite it. */
  url: string;
  issueType?: string | null;
  labels?: string[];
  assignee?: string | null;
  reporter?: string | null;
}

export interface BriefInput {
  ticket: BriefTicket;
  /** Oldest first, as the ledger lists them; the brief keeps the newest MAX_BRIEF_COMMENTS. */
  comments: BriefComment[];
  /** For naming authors; an unknown author is "a teammate". */
  members: LedgerMember[];
  /** The state's name, when known. */
  stateName: string | null;
  /** W5b: set when the ticket is a Jira issue; the brief says so and names the URL. */
  jira?: JiraBriefFacts | null;
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
  /** Writing sessions: verify the change in the isolated browser and bring back screenshots. */
  verifyInBrowser?: boolean;
  /**
   * Ultrafast browser tasks: the `waypoint-ultrafast` MCP server's
   * `browser_task` tool is registered for this session (registration is
   * gated on a saved TypeSafe key, `uv`, and a provisioned Python
   * environment — see runs/ultrafast/registration.ts). When true, and only
   * alongside `verifyInBrowser`, the brief tells the agent it may reach for
   * that tool for a multi-step walk instead of driving every step by hand.
   */
  ultrafastAvailable?: boolean;
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

/** One comment's author, time and flat text, whichever shape it came in. */
function commentLine(members: LedgerMember[], c: BriefComment): string {
  if ('bodyHtml' in c) {
    return `— ${authorName(members, c.authorId)}, ${when(c.createdAt)}:\n${clip(htmlToText(c.bodyHtml), MAX_COMMENT_CHARS)}`;
  }
  const at = c.createdAt ? when(c.createdAt) : 'undated';
  return `— ${c.author || 'a teammate'}, ${at}:\n${clip(c.text.trim(), MAX_COMMENT_CHARS)}`;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

// The closing-message contract, common to every verb — W5c: the report
// shape (report.ts reads it back). The Summary goes on the ticket, so it
// is written for the ticket's readers; the Details stay with the run.
function closingRule(
  noun: 'ticket' | 'issue',
  verdicts: string[],
  verify = false,
  ultrafastAvailable = false,
): string {
  return [
    `Waypoint reads only the final message of this turn, so end the turn with one message in exactly this shape, and nothing after it:`,
    `Verdict: <one of ${verdicts.join(' | ')}>`,
    `## Summary`,
    `Three to eight lines for the ${noun}'s readers — a product manager and a reviewer who has not seen the code: what you concluded, the one or two facts that support it, and what happens next. No file paths or commands here. Waypoint posts this section on the ${noun}, as a comment a person approves first.`,
    ...(verify
      ? [
          `## Verification`,
          `What you drove in the browser, step by step, and what each screenshot shows (first, second, … in the order you took them); then whether the behaviour now matches the ${noun}. Waypoint posts this section on the ${noun} too; the screenshots themselves are in the run's transcript. If you could not start the app or drive the steps, say exactly that here.`,
          ultrafastAvailable
            ? `End this section with one line that times the QA cycle, exactly in this shape: "Verification: <seconds> s via browser_task" (copy the wall time from the tool's Timing line, and add its Jev/Claude figures after it if you like) or "Verification: <n> tool calls via waypoint-browser" when you drove the page yourself. If the person later asks you to run the QA cycle again — in the browser, or through browser_task — do it and report the time again the same way, so the two can be compared.`
            : `End this section with one line that times the QA cycle, exactly in this shape: "Verification: <n> tool calls via waypoint-browser". If the person later asks you to run the QA cycle again, do it and report the count again the same way.`,
        ]
      : []),
    `## Details`,
    `Everything else — evidence with files and lines, what you tried, how you verified it, what you could not settle. This stays with the run in Waypoint and is not posted on the ${noun}.`,
    `Do not ask questions at the end; state what you found and what you would do next.`,
  ].join('\n');
}

/**
 * The verification paragraph a writing session gets with the switch on.
 * Names the server (sessionBrowser.ts registers it as `waypoint-browser`)
 * and its tools by name — a model given a bare "verify in the browser"
 * reaches for curl or a unit test; told which tools exist, it drives the
 * page. Screenshots are taken WITHOUT a filePath: the tool then returns
 * the image as content, the transcript keeps it on that tool call, and
 * the run's chat shows it at the moment it was taken (emdash fork,
 * 2026-09-20) — no folder, nothing to commit, nothing to copy.
 */
function verificationTask(
  noun: 'ticket' | 'issue',
  ultrafastAvailable = false,
): string {
  // With browser_task registered it is the way to walk the steps, not an
  // option beside the fine-grained tools: offered as "you may instead",
  // the first live session (2026-09-22) took the fine-grained path every
  // time and the founder never saw Jev run. The fine-grained tools stay
  // for what browser_task cannot drive.
  if (ultrafastAvailable) {
    return [
      `Then verify the change in a browser. Start the app from this worktree (the README or package scripts say how; use a free port).`,
      `Walk the ${noun}'s reproduction steps with browser_task: call it once with the app's URL and the steps in plain words (what to open, what to type where, what to press, what should appear). It drives the page in seconds and returns a screenshot per step and one of the final page, which land in your transcript where the ${noun}'s readers see them; its text starts with a Timing line. Its "done" is a claim, not proof — look at the screenshots and judge the outcome yourself before saying the behaviour matches.`,
      `Use the fine-grained waypoint-browser tools (navigate_page, take_snapshot, click, fill, take_screenshot with NO filePath) only for a single check, or for what browser_task cannot drive — content in a shadow root, an iframe or a canvas, a file upload, a pop-up window. If browser_task comes back blocked or failed, say so and finish the walk with them. Stop the app when you are done.`,
      `A change you could not verify this way is partial, not fixed — say what stopped you (the app would not start, a login was needed, the steps could not be driven) rather than claiming it works.`,
    ].join(' ');
  }
  return [
    `Then verify the change in a browser. Start the app from this worktree (the README or package scripts say how; use a free port), open it with the waypoint-browser tools — navigate_page, take_snapshot, click, fill, take_screenshot — and walk the ${noun}'s reproduction steps against your change.`,
    `Take a screenshot at each step that matters — before you act and after — with take_screenshot and NO filePath, so the image lands in your transcript where the ${noun}'s readers see it; say in your narration what each one shows. Stop the app when you are done.`,
    `A change you could not verify this way is partial, not fixed — say what stopped you (the app would not start, a login was needed, the steps could not be driven) rather than claiming it works.`,
  ].join(' ');
}

// `delivered`: the ticket's ask is already built and shipped — closes as
// done, unlike not-a-bug. Not a Fix verdict: a Fix implements, it does
// not judge scope.
const INVESTIGATE_VERDICTS = [
  'root-cause',
  'not-a-bug',
  'delivered',
  'needs-info',
];
const FIX_VERDICTS = [
  'fixed',
  'partial',
  'not-a-bug',
  'wont-fix',
  'needs-info',
];
const CUSTOM_VERDICTS = ['done', 'partial', 'needs-info'];

function taskSection(input: BriefInput): string {
  const noun = input.jira ? 'issue' : 'ticket';
  switch (input.intent) {
    case 'investigate':
      return [
        '## Your task — Investigate',
        `Find the root cause. Read the code and its history, run read-only commands as you need. Do not change any file: this session is in plan mode and the ${noun} owner decides what happens next.`,
        `Your verdict: root-cause when you found it (say what the fix would be); not-a-bug when the ${noun} describes intended behaviour or something already the case — Waypoint then proposes closing it; needs-info when you cannot settle it without a person.`,
        closingRule(noun, INVESTIGATE_VERDICTS),
      ].join('\n');
    case 'fix': {
      const note = (input.instructions ?? '').trim();
      return [
        '## Your task — Fix',
        ...(note ? [`Note from the ${noun} owner: ${note}`] : []),
        `Implement the fix on this branch. Commit as you go with clear messages. Do not touch anything outside this worktree.${input.approvedRca ? ' Start from the approved root cause above; if the code says otherwise, say so in your closing message.' : ''}`,
        `Waypoint pushes this branch and opens the pull request itself once you finish — you cannot push from this session and must not try, and your report must not say the branch was not pushed or that a PR is still to be opened; Waypoint adds those facts to the comment.`,
        ...(input.verifyInBrowser
          ? [verificationTask(noun, input.ultrafastAvailable)]
          : []),
        `Your verdict: fixed when the change is on the branch and verified; partial when it is on the branch but does not close the ${noun} (say what is left); not-a-bug or wont-fix when the ${noun} should be closed instead of fixed — then change nothing and say why; needs-info when a person must decide first. Waypoint proposes moving the ${noun} to review for fixed and partial, and closing it for not-a-bug and wont-fix.`,
        closingRule(
          noun,
          FIX_VERDICTS,
          input.verifyInBrowser === true,
          input.ultrafastAvailable === true,
        ),
      ].join('\n');
    }
    case 'custom': {
      const instructions = (input.instructions ?? '').trim();
      return [
        '## Your task',
        instructions || '(no instruction was given)',
        input.mayChangeFiles
          ? 'You may edit files on this branch; commit as you go. Do not touch anything outside this worktree. Waypoint pushes the branch and opens the pull request itself once you finish; you cannot push from this session.'
          : 'Do not change any file: this session is in plan mode. Read, run read-only commands, and report.',
        ...(input.mayChangeFiles && input.verifyInBrowser
          ? [verificationTask(noun, input.ultrafastAvailable)]
          : []),
        closingRule(
          noun,
          CUSTOM_VERDICTS,
          input.mayChangeFiles === true && input.verifyInBrowser === true,
          input.ultrafastAvailable === true,
        ),
      ].join('\n');
    }
  }
}

/**
 * The brief, as text. Table-tested in briefs.test.ts for every intent
 * and for the scrub.
 */
export function buildBrief(input: BriefInput): string {
  const { ticket, jira } = input;
  const parts: string[] = [];
  parts.push(
    jira
      ? `You are working on ${ticket.identifier}, a Jira issue (${jira.url}), in a fresh git worktree of the repository its code lives in. The issue and its discussion follow, as Jira has them now; your task is at the end.`
      : `You are working on ${ticket.identifier} for the Waypoint team, in a fresh git worktree of the project's repository. The ticket and its discussion follow; your task is at the end.`,
  );

  const facts: string[] = [];
  if (jira?.issueType) facts.push(`Type: ${jira.issueType}`);
  if (ticket.priority) facts.push(`Priority: ${ticket.priority}`);
  if (input.stateName) facts.push(`State: ${input.stateName}`);
  if (jira?.labels?.length) facts.push(`Labels: ${jira.labels.join(', ')}`);
  if (jira?.assignee) facts.push(`Assignee: ${jira.assignee}`);
  if (jira?.reporter) facts.push(`Reporter: ${jira.reporter}`);
  parts.push(
    [
      `## ${jira ? 'Issue' : 'Ticket'} ${ticket.identifier} — ${ticket.title}`,
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
    parts.push(
      [
        `## Acceptance (from the ${jira ? 'issue' : 'ticket'})`,
        acceptance,
      ].join('\n'),
    );
  }

  const newest = input.comments.slice(-MAX_BRIEF_COMMENTS);
  if (newest.length) {
    const omitted = input.comments.length - newest.length;
    parts.push(
      [
        `## Comments (${omitted > 0 ? `newest ${newest.length} of ${input.comments.length}, ` : ''}oldest first)`,
        ...newest.map((c) => commentLine(input.members, c)),
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

// --- W5b: a Jira issue, as main's own client reads it ----------------------

/**
 * The brief's view of a Jira issue, from the wire shape main's Jira client
 * hands the renderer (jira/jiraMap.ts's mapIssue: the description already
 * flattened from ADF, mentions rendered as names, account ids kept off).
 * The priority is the site's own label, the state Jira's status name.
 */
export function jiraBriefTicket(
  issue: JiraWireTicket,
  site: string,
): {
  ticket: BriefTicket;
  stateName: string;
  jira: JiraBriefFacts;
} {
  return {
    ticket: {
      identifier: issue.key,
      title: issue.title,
      description: issue.description?.trim() ? issue.description : null,
      priority: issue.priorityName === 'None' ? null : issue.priorityName,
    },
    stateName: issue.stateName,
    jira: {
      url: jiraIssueUrl(site, issue.key),
      labels: issue.labels,
      assignee:
        issue.assigneeName && issue.assigneeName !== 'Unassigned'
          ? issue.assigneeName
          : null,
      reporter: issue.reporterName || null,
    },
  };
}

/** The issue's comments as the brief reads them: named, flat, oldest first as the client lists them. */
export function jiraBriefComments(comments: JiraWireComment[]): BriefComment[] {
  return comments.map((c) => ({
    author: c.authorName,
    text: c.body,
    createdAt: c.createdAt,
  }));
}

/** `https://site/browse/ENG-4` — the same shape the backend's provider records on the ref. */
export function jiraIssueUrl(site: string, key: string): string {
  return `https://${site}/browse/${encodeURIComponent(key)}`;
}
