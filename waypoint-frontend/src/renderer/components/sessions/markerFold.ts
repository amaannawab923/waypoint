import type { TranscriptTurn } from '@emdash/core/runtimes/acp/api/client' with {
  'resolution-mode': 'import',
};
import type { AgentRunEvent } from '@/types/agentRuns';

/**
 * Markers (never-lock, design §5): what Waypoint did to a run — filed
 * its report, continued its conversation — shown IN the transcript, at
 * the point in the conversation where it happened, as one italic line
 * (chat-ui's `role:'thought'` row). Never a turn of the conversation:
 * the daemon's history is untouched, the ledger's events are the only
 * source, and the overlay is re-applied on every history seed so it
 * survives commits and restarts by construction (useSessionTranscript).
 *
 * Pure, like briefFold.ts: events + a label in, turns with markers out.
 */

export interface Marker {
  /** Stable across seeds: the event's seq. */
  id: string;
  /** Event order; several markers on one anchor keep it. */
  seq: number;
  /** The turn the marker follows; null → the last turn there is. */
  afterTurnId: string | null;
  text: string;
}

const pick = (payload: Record<string, unknown>, key: string): unknown =>
  payload[key];
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * Markdown-escapes free text before it lands in a marker line chat-ui
 * renders as Markdown (found in review: a run's title, a verdict, a
 * publish-failure reason all ride in from `agent_run_events` payloads —
 * `finalized`/`session_resumed`/`note` are all in the backend's
 * CLIENT_EVENT_KINDS, so any workspace member can POST one with an
 * arbitrary payload; unescaped, `[label](url)`-shaped text becomes a
 * spoofed link, and `<...>` becomes raw HTML). Every CommonMark
 * punctuation character that starts INLINE syntax gets a backslash —
 * always a no-op for ordinary prose (a backslash-escaped ordinary
 * character still renders as itself), never a partial escape an
 * attacker can work around.
 *
 * Block syntax — a heading underline (`---`), a thematic break, a list
 * item (`- `, `+ `, `1. `), a blockquote — only ever starts at the start
 * of a line, and a marker is one line that always starts with
 * `Waypoint · `. So the block vector is a line break inside the text,
 * and that is what is removed (found in review, round 4: the escape set
 * above handled `#` but let `\n---\n` and `\n- [x] …` through). Every
 * kind of line break, collapsed to one space; the block characters
 * themselves stay unescaped so `ROAD-116` still reads as `ROAD-116`.
 */
function escapeMdText(text: string): string {
  return text
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\\`*_[\]()<>~|#]/g, (c) => `\\${c}`);
}

/**
 * A URL from the same untrusted payloads, used as a real link's href —
 * only ever a plain http(s) URL, or the link is not built at all (the
 * text-only fallback the caller already has for a missing url). Closes
 * the same gap as `escapeMdText` for the one place escaping alone isn't
 * enough: a scheme like `javascript:` in the href position runs on
 * click, no matter how the label text is escaped.
 */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? url
      : null;
  } catch {
    return null;
  }
}

/** The last path segment of a PR url, for "PR #42" — always safe: digits pulled by regex, nothing interpolated verbatim. */
function prLabel(url: string): string {
  const m = /\/(\d+)\/?$/.exec(url);
  return m ? `PR #${m[1]}` : 'PR';
}

/**
 * `[label](url)` when the url is safe to link to; the label alone
 * otherwise. `label` is always Waypoint's own text (`prLabel`'s output,
 * digits pulled by regex — never escaped, because it's never untrusted);
 * only `url` came from the payload, so only it needs validating.
 */
function prLink(label: string, url: string | null): string {
  const href = url === null ? null : safeHref(url);
  return href ? `[${label}](${href})` : label;
}

function finalizedText(
  payload: Record<string, unknown>,
  label: string,
): string {
  const sequence = num(pick(payload, 'sequence')) ?? 1;
  const verdict = str(pick(payload, 'verdict'));
  const proposals = Array.isArray(pick(payload, 'proposals'))
    ? (pick(payload, 'proposals') as unknown[]).length
    : 0;
  const pr = (pick(payload, 'pr') ?? {}) as Record<string, unknown>;
  const escapedLabel = escapeMdText(label);
  const parts: string[] = [
    sequence > 1
      ? `Follow-up ${sequence} filed for ${escapedLabel}`
      : `Completed ${escapedLabel}`,
  ];
  if (verdict) parts.push(`verdict ${escapeMdText(verdict)}`);
  const action = str(pick(pr, 'action'));
  const url = str(pick(pr, 'url'));
  const reason = str(pick(pr, 'reason'));
  if (action === 'opened' && url) {
    parts.push(prLink(`${prLabel(url)} opened`, url));
  } else if (action === 'updated' && url) {
    parts.push(prLink(`${prLabel(url)} updated`, url));
  } else if (action === 'failed') {
    parts.push(`not published: ${escapeMdText(reason ?? 'the push failed')}`);
  } else if (action === 'skipped' && reason) {
    parts.push(`not published: ${escapeMdText(reason)}`);
  }
  if (proposals > 0)
    parts.push(
      `${proposals} proposal${proposals === 1 ? '' : 's'} filed for review`,
    );
  return `Waypoint · ${parts.join(' · ')}`;
}

/**
 * Only when a resume was NOT the ordinary, expected case — the whole
 * point of never-lock is that continuing a finished run feels seamless,
 * so a "Continued from done · conversation restored" line on literally
 * every message defeats that (founder, 2026-09-20: repeating on every
 * message pollutes the chat history). `null` for the routine case: the
 * reply arriving IS the confirmation. A genuinely noteworthy outcome —
 * the agent's memory of the prior turns is gone, or the worktree had to
 * be rebuilt from disk — still gets a line, since either one is
 * information a person could not infer just by reading the reply.
 */
function resumedText(payload: Record<string, unknown>): string | null {
  const from = str(pick(payload, 'from')) as string;
  const outcome = str(pick(payload, 'outcome'));
  const worktreeRecreated = pick(payload, 'worktreeRecreated') === true;
  if (outcome !== 'replaced-by-new' && !worktreeRecreated) return null;
  const parts: string[] = [`Continued from ${escapeMdText(from)}`];
  if (outcome === 'replaced-by-new')
    parts.push('fresh session in the same worktree');
  if (worktreeRecreated) {
    parts.push(
      pick(payload, 'branchReused') === false
        ? 'worktree recreated on a fresh branch'
        : 'worktree recreated, branch reused',
    );
  }
  return `Waypoint · ${parts.join(' · ')}`;
}

/** One marker per event that means something in the conversation; nothing for the rest. */
export function deriveMarkers(
  events: readonly AgentRunEvent[],
  label: string,
): Marker[] {
  const markers = events.flatMap((event): Marker[] => {
    const { payload } = event;
    const afterTurnId = str(pick(payload, 'afterTurnId'));
    let text: string | null = null;
    if (event.kind === 'finalized') {
      text = finalizedText(payload, label);
    } else if (event.kind === 'session_resumed' && str(pick(payload, 'from'))) {
      // Only a resume that continued the conversation (startRun.ts's
      // resumeRunCore writes `from`). Boot reconcile writes the same kind
      // for a daemon session it found live and re-attached (`at:'boot'`)
      // — bookkeeping, one per launch, found live as a wall of
      // "Continued" lines on a run Waypoint had merely restarted under.
      text = resumedText(payload);
    } else if (event.kind === 'note') {
      const commits = num(pick(payload, 'unpublishedCommits'));
      if (pick(payload, 'stage') === 'finalize' && commits && commits > 0) {
        text = `Waypoint · ${commits} new commit${commits === 1 ? '' : 's'} on the branch, not published — ask the agent to summarize its changes to publish`;
      } else if (pick(payload, 'suppressed') === 'verdict-without-summary') {
        text =
          'Waypoint · Verdict line found without a Summary — treated as conversation, nothing filed';
      } else if (pick(payload, 'publish') === 'pr-superseded') {
        const previous = str(pick(payload, 'previousUrl'));
        const named = previous
          ? prLink(`the earlier ${prLabel(previous)}`, previous)
          : 'the earlier PR';
        text = `Waypoint · the branch was recreated; ${named} is superseded — the next report opens a new one`;
      }
    }
    if (text === null) return [];
    return [{ id: `marker:${event.seq}`, seq: event.seq, afterTurnId, text }];
  });
  return markers.sort((a, b) => a.seq - b.seq);
}

type Item = TranscriptTurn['items'][number];

function markerItem(marker: Marker, seq: number): Item {
  // chat-ui renders `role:'thought'` (its own ChatRole) as the italic
  // muted row; the core transcript type only names user|assistant, so
  // the widening is done here, once.
  return {
    kind: 'message',
    id: marker.id,
    seq,
    role: 'thought',
    text: marker.text,
  } as unknown as Item;
}

/**
 * The notes Waypoint hands the agent as hidden context on a resume
 * (startRun.ts: the branch-state note from `resumeOpening`, the
 * continuation note from `continuationNote`). They travel as a second
 * text block of the person's prompt — never as a transcript message of
 * their own — but the agent's own replayed history on a later resume
 * flattens a prompt's blocks into one string, and the daemon's history
 * then hands that back as the person's message: `line oneThis run's last
 * report was already filed…` (customer feedback round 1: all three
 * personas). Matched by their fixed openings, which only Waypoint writes.
 */
const HIDDEN_NOTE_OPENINGS = [
  "This run's last report was already filed on ",
  'Waypoint resumed this run',
] as const;

function hiddenNoteStart(text: string): number {
  let at = -1;
  HIDDEN_NOTE_OPENINGS.forEach((opening) => {
    const i = text.indexOf(opening);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  });
  return at;
}

/** One line for the marker: the note's first sentence, the branch state summarised rather than pasted. */
function hiddenNoteLine(note: string): string {
  const firstParagraph = note.split(/\n\s*\n/)[0] ?? note;
  const rest = note.slice(firstParagraph.length).trim();
  const summary = rest
    ? `${firstParagraph} (branch state given to the agent)`
    : firstParagraph;
  return `Waypoint · ${escapeMdText(summary)}`;
}

/**
 * The turns with any hidden note cut out of the person's own messages
 * and shown as the italic marker row it always should have been, placed
 * just above that message. The same note rides on every message sent
 * after a finalize, so it is shown the first time only — a line on
 * literally every message defeats never-lock's "feels seamless" (the
 * same rule `resumedText` follows); later copies are cut out silently.
 * A message with no note is returned as is.
 */
export function foldHiddenNotes(
  turns: readonly TranscriptTurn[],
): TranscriptTurn[] {
  const shown = new Set<string>();
  return turns.map((turn) => {
    if (!Array.isArray(turn.items)) return turn;
    let changed = false;
    const items: Item[] = [];
    turn.items.forEach((item) => {
      if (item.kind !== 'message' || item.role !== 'user') {
        items.push(item);
        return;
      }
      const at = hiddenNoteStart(item.text);
      if (at < 0) {
        items.push(item);
        return;
      }
      changed = true;
      const own = item.text.slice(0, at).trim();
      const note = item.text.slice(at).trim();
      const line = hiddenNoteLine(note);
      if (!shown.has(line)) {
        shown.add(line);
        items.push(
          markerItem(
            {
              id: `note:${turn.id}:${item.id}`,
              seq: item.seq,
              afterTurnId: turn.id,
              text: line,
            },
            item.seq,
          ),
        );
      }
      if (own) items.push({ ...item, text: own });
    });
    return changed ? { ...turn, items } : turn;
  });
}

/**
 * The turns with each marker appended to its anchoring turn's items —
 * by turn id; a marker whose turn is gone (or was never named) follows
 * the last turn. With no turns at all the markers make a turn of their
 * own at the end, so a run that produced nothing before Waypoint acted
 * on it still shows what happened.
 */
export function overlayMarkers(
  turns: readonly TranscriptTurn[],
  markers: readonly Marker[],
): TranscriptTurn[] {
  if (markers.length === 0) return [...turns];
  const byTurn = new Map<string, Marker[]>();
  const lastId = turns.length > 0 ? turns[turns.length - 1].id : null;
  const orphans: Marker[] = [];
  markers.forEach((marker) => {
    const target =
      marker.afterTurnId !== null &&
      turns.some((t) => t.id === marker.afterTurnId)
        ? marker.afterTurnId
        : lastId;
    if (target === null) {
      orphans.push(marker);
      return;
    }
    const list = byTurn.get(target) ?? [];
    list.push(marker);
    byTurn.set(target, list);
  });
  const out = turns.map((turn) => {
    const mine = byTurn.get(turn.id);
    if (!mine) return turn;
    let seq = turn.items.reduce((max, item) => Math.max(max, item.seq), 0);
    return {
      ...turn,
      items: [
        ...turn.items,
        ...mine.map((marker) => {
          seq += 1;
          return markerItem(marker, seq);
        }),
      ],
    };
  });
  if (orphans.length > 0) {
    out.push({
      id: 'markers',
      seq: turns.reduce((max, t) => Math.max(max, t.seq), 0) + 1,
      initiator: 'agent',
      items: orphans.map((marker, i) => markerItem(marker, i + 1)),
    } as TranscriptTurn);
  }
  return out;
}
