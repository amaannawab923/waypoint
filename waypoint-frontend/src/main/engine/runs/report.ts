/**
 * A session's closing message, read as a report — W5c (the PM review of
 * the Jira walkthrough: what lands on a board must be board-shaped, and
 * the verdict the agent actually reached must drive what Waypoint
 * proposes).
 *
 * The brief (briefs.ts) asks every session to end its turn in one shape:
 *
 *   Verdict: <one word from the verb's list>
 *   ## Summary
 *   <a few lines for the ticket's readers>
 *   ## Details
 *   <everything else>
 *
 * This module reads that shape back — leniently, since a model does not
 * always comply: a missing verdict is null (the caller treats it as the
 * verb's default), a missing Summary heading means the first paragraphs
 * up to a Details heading or a rule, else the first few lines, bounded.
 * Pure; table-tested.
 */

/** What the session concluded, in Waypoint's vocabulary. */
export type Verdict =
  /** Investigate: the cause is found; a Fix can follow. */
  | 'root-cause'
  /** Fix: the change is on the branch. */
  | 'fixed'
  /** Fix: on the branch, but not the whole ticket. */
  | 'partial'
  /** Either: the ticket is not a defect / already the case; close it. */
  | 'not-a-bug'
  /** Either: should not be done as asked; close it. */
  | 'wont-fix'
  /**
   * Investigate: what the ticket asks for is already built and shipped;
   * close it as done, never as cancelled (customer feedback round 1: a
   * delivered feature was proposed Cancelled under not-a-bug).
   */
  | 'delivered'
  /** Either: the session could not settle it without a person. */
  | 'needs-info';

export const VERDICTS: readonly Verdict[] = [
  'root-cause',
  'fixed',
  'partial',
  'not-a-bug',
  'wont-fix',
  'delivered',
  'needs-info',
];

export interface Report {
  verdict: Verdict | null;
  /**
   * The message carried a real `## Summary` heading — the one signal that
   * this turn was a report and not conversation that happened to mention
   * a verdict (customer feedback round 1: a reply quoting the earlier
   * `Verdict:` line was filed as a follow-up). A first report is filed
   * either way (the brief's default verdict applies); a follow-up needs it.
   */
  hasSummaryHeading: boolean;
  /** The board-shaped part: what a ticket's readers need. */
  summary: string;
  /**
   * The `## Verification` section a session asked to verify in the
   * browser writes (briefs.ts verificationTask): what it drove and what
   * each screenshot shows. Posted on the ticket beside the summary; null
   * when the message has no such section. Lifted OUT of `details`.
   */
  verification: string | null;
  /** The rest, kept with the run; null when the message was all summary. */
  details: string | null;
}

/** The most of a Verification section that goes on a ticket. */
export const MAX_VERIFICATION_CHARS = 2_000;

/** The most of a summary that goes on a ticket when the session gave no Summary heading. */
export const MAX_FALLBACK_SUMMARY_CHARS = 1_400;
export const MAX_FALLBACK_SUMMARY_LINES = 14;

// No `>` in the prefix: a blockquoted verdict line is a quotation of an
// earlier report, never this turn's own declaration.
const VERDICT_LINE =
  /^\s*(?:[*_#\-\s]*)verdict\s*[:—–-]\s*\**\s*([a-z][a-z' -]*[a-z])\**/i;
const QUOTED = /^\s*>/;

const VERDICT_WORDS: Array<[RegExp, Verdict]> = [
  [/^(root[- ]?cause|found|cause[- ]found|rca)$/i, 'root-cause'],
  [/^(fixed|fix|done|implemented|resolved)$/i, 'fixed'],
  [/^(partial|partially[- ]fixed|incomplete)$/i, 'partial'],
  [
    /^(not[- ]a[- ]bug|not[- ]bug|works[- ]as[- ]intended|no[- ]defect|invalid)$/i,
    'not-a-bug',
  ],
  [/^(won'?t[- ]?(fix|do)|wontfix|declined|out[- ]of[- ]scope)$/i, 'wont-fix'],
  [
    /^(delivered|already[- ](delivered|done|built|shipped|implemented)|shipped)$/i,
    'delivered',
  ],
  [
    /^(needs[- ]info|need[- ]info|cannot[- ]reproduce|can'?t[- ]reproduce|blocked|unclear|needs[- ]decision)$/i,
    'needs-info',
  ],
];

/** The verdict a line names, or null. */
export function parseVerdictWord(word: string): Verdict | null {
  const w = word.trim().toLowerCase();
  return VERDICT_WORDS.find(([re]) => re.test(w))?.[1] ?? null;
}

function stripVerdictLine(lines: string[]): {
  verdict: Verdict | null;
  rest: string[];
} {
  // The verdict line is expected first; tolerate it anywhere in the first
  // few lines (a model may open with a heading).
  for (let i = 0; i < Math.min(lines.length, 6); i += 1) {
    if (QUOTED.test(lines[i])) continue;
    const m = VERDICT_LINE.exec(lines[i]);
    if (m) {
      const verdict = parseVerdictWord(m[1]);
      return { verdict, rest: [...lines.slice(0, i), ...lines.slice(i + 1)] };
    }
  }
  return { verdict: null, rest: lines };
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;

function isSummaryHeading(line: string): boolean {
  const m = HEADING.exec(line);
  return !!m && /^(summary|tl;?dr|bottom line|outcome|result)\b/i.test(m[1]);
}

function isVerificationHeading(line: string): boolean {
  const m = HEADING.exec(line);
  // Not "how i verified": that is a Details cue (isDetailsHeading) the
  // fallback split relies on, and the brief names this exact heading.
  return !!m && /^(verification|verified)\b/i.test(m[1]);
}

/**
 * Lifts the Verification section out of `lines`: the heading and its
 * body up to the next heading or rule. Its own pass, before the summary
 * split, so the section never lands in the details or the fallback
 * summary — and so a heading in the details' own vocabulary ("how i
 * verified") is read as verification first.
 */
function liftVerification(lines: string[]): {
  verification: string | null;
  rest: string[];
} {
  const at = lines.findIndex(isVerificationHeading);
  if (at === -1) return { verification: null, rest: lines };
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (HEADING.test(lines[i]) || RULE.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(at + 1, end)
    .join('\n')
    .trim();
  return {
    verification: body.length ? body : null,
    rest: [...lines.slice(0, at), ...lines.slice(end)],
  };
}

function isDetailsHeading(line: string): boolean {
  const m = HEADING.exec(line);
  return (
    !!m &&
    /^(details?|evidence|full report|appendix|notes?( for reviewers)?|how i verified|what i could not settle|left open)\b/i.test(
      m[1],
    )
  );
}

function clip(
  text: string,
  maxChars: number,
  maxLines: number,
): { text: string; clipped: boolean } {
  const lines = text.split('\n');
  let out = lines.slice(0, maxLines).join('\n');
  let clipped = lines.length > maxLines;
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars - 1)}…`;
    clipped = true;
  }
  return { text: out.trim(), clipped };
}

/** The closing message read as a report. */
export function parseReport(closing: string): Report {
  const raw = closing.replace(/\r\n/g, '\n').trim();
  if (!raw)
    return {
      verdict: null,
      hasSummaryHeading: false,
      summary: '',
      verification: null,
      details: null,
    };
  const { verdict, rest: afterVerdict } = stripVerdictLine(raw.split('\n'));
  const { verification, rest } = liftVerification(afterVerdict);

  // A Summary heading: its section is the summary, everything else is
  // the details (what came before it included — a title line, say).
  const summaryAt = rest.findIndex(isSummaryHeading);
  if (summaryAt !== -1) {
    let end = rest.length;
    for (let i = summaryAt + 1; i < rest.length; i += 1) {
      if (HEADING.test(rest[i]) || RULE.test(rest[i])) {
        end = i;
        break;
      }
    }
    const summary = rest
      .slice(summaryAt + 1, end)
      .join('\n')
      .trim();
    const before = rest.slice(0, summaryAt);
    const after = rest.slice(end);
    const details = [...before, ...after].join('\n').trim();
    return {
      verdict,
      hasSummaryHeading: true,
      summary,
      verification,
      details: details.length ? details : null,
    };
  }

  // No Summary heading: up to the first Details-like heading or rule.
  const cut = rest.findIndex(
    (l, i) => i > 0 && (isDetailsHeading(l) || RULE.test(l)),
  );
  if (cut !== -1) {
    const summary = clip(
      rest.slice(0, cut).join('\n'),
      MAX_FALLBACK_SUMMARY_CHARS,
      MAX_FALLBACK_SUMMARY_LINES,
    );
    const details = rest.slice(cut).join('\n').trim();
    return {
      verdict,
      hasSummaryHeading: false,
      summary: summary.text,
      verification,
      details: details.length ? details : null,
    };
  }

  // Neither: the first lines, bounded; the rest is the details.
  const nonEmpty = rest
    .map((l) => l)
    .join('\n')
    .trim();
  const { text, clipped } = clip(
    nonEmpty,
    MAX_FALLBACK_SUMMARY_CHARS,
    MAX_FALLBACK_SUMMARY_LINES,
  );
  return {
    verdict,
    hasSummaryHeading: false,
    summary: text,
    verification,
    details: clipped ? nonEmpty : null,
  };
}

/** The verdict a session reports when it names none, by verb. */
export function defaultVerdict(
  intent: 'investigate' | 'fix' | 'custom' | null,
): Verdict | null {
  if (intent === 'investigate') return 'root-cause';
  if (intent === 'fix') return 'fixed';
  return null;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  'root-cause': 'root cause found',
  fixed: 'fixed',
  partial: 'partly fixed',
  'not-a-bug': 'not a bug',
  'wont-fix': "won't fix",
  delivered: 'already delivered',
  'needs-info': 'needs a decision',
};

/** "not a bug" — the verdict as a person reads it. */
export function verdictLabel(verdict: Verdict): string {
  return VERDICT_LABEL[verdict];
}

/**
 * Verdicts that close the ticket rather than move it forward — nothing
 * to publish, a closing (or, for `delivered`, a done) state proposed.
 */
export function isClosingVerdict(verdict: Verdict | null): boolean {
  return (
    verdict === 'not-a-bug' || verdict === 'wont-fix' || verdict === 'delivered'
  );
}

/**
 * The QA-cycle time the brief asks the session to end its Verification
 * section with (founder, 2026-09-22: "how did Jev perform"):
 * `Verification: 6.8 s via browser_task` or `Verification: 14 tool calls
 * via waypoint-browser`. Parsed leniently from anywhere in the section
 * (the model may add the tool's Jev/Claude figures after it); null when
 * the section has no such line. Rides on the `finalized` event so the
 * marker row can say "verified in 6.8 s via browser_task".
 */
export interface VerificationTiming {
  seconds: number | null;
  toolCalls: number | null;
  via: 'browser_task' | 'waypoint-browser' | null;
}

// F14 (tech-lead review, 2026-09-22): `\s*s(?:ec(?:ond)?s?)?` had no word
// boundary after the bare `s` branch, and "steps"/"screenshots" — the two
// nouns the brief's own Verification section uses most, right next to a
// step or screenshot count — both start with `s`. "Verification: 5 steps
// via browser_task" matched the bare `s` off "steps" and was read as
// `{seconds: 5}`; "3 screenshots taken" the same way. `\b` after the
// alternation closes that: "steps"/"screenshots" no longer satisfy it (the
// `s` is followed by another word character, not a boundary), while
// "6.8 s", "12 seconds" and "3 secs" still do.
const VERIFICATION_TIMING =
  /verification\**\s*[:—–-]\s*\**\s*(?:(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b|(\d+)\s*tool calls?)(?:\s*(?:via|with|through)\s*`?(browser_task|waypoint-browser)`?)?/i;

export function parseVerificationTiming(
  verification: string | null,
): VerificationTiming | null {
  if (!verification) return null;
  const m = VERIFICATION_TIMING.exec(verification);
  if (!m) return null;
  const via =
    m[3] === 'browser_task' || m[3] === 'waypoint-browser' ? m[3] : null;
  return {
    seconds: m[1] !== undefined ? Number(m[1]) : null,
    toolCalls: m[2] !== undefined ? Number(m[2]) : null,
    via,
  };
}
