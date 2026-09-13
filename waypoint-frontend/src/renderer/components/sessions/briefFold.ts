import type { TranscriptTurn } from '@emdash/core/runtimes/acp/api/client' with {
  'resolution-mode': 'import',
};

/**
 * A dispatched run's first prompt is the brief — the ticket, its
 * comments and Waypoint's instructions, a few hundred lines. Shown in
 * full as the transcript's first message it drowns the conversation
 * (founder, 2026-09-13: "keep it very brief, like Claude Code's view
 * transcript"). So the transcript folds it: the message's text becomes
 * one line pointing at the Brief bar above the transcript, which holds
 * the full text behind "View brief". Pure, applied to seeded history and
 * to the live active turn alike; only the first turn's first user
 * message is touched, and only when its text is longer than a line.
 */

/** The turn that carries the brief: the earliest, by seq. */
export function briefTurnSeq(turns: readonly TranscriptTurn[]): number | null {
  let min: number | null = null;
  for (const turn of turns) {
    if (min === null || turn.seq < min) min = turn.seq;
  }
  return min;
}

/** The brief's text in a turn, if the turn opens with a user message. */
export function briefTextOf(
  turn: TranscriptTurn | null | undefined,
): string | null {
  if (!turn) return null;
  const first = turn.items.find((item) => item.kind === 'message');
  if (!first || first.kind !== 'message' || first.role !== 'user') return null;
  const text = first.text.trim();
  return text.length > 0 ? text : null;
}

export const FOLD_MIN_CHARS = 240;

export function foldPlaceholder(text: string, label: string): string {
  const lines = text.split('\n').length;
  return `Brief for ${label} — ${lines} lines. Open “View brief” above the transcript to read it.`;
}

/** The turn with its brief folded to the placeholder; the same turn when there is nothing to fold. */
export function foldTurn(turn: TranscriptTurn, label: string): TranscriptTurn {
  const text = briefTextOf(turn);
  if (!text || text.length < FOLD_MIN_CHARS) return turn;
  let replaced = false;
  return {
    ...turn,
    items: turn.items.map((item) => {
      if (replaced || item.kind !== 'message' || item.role !== 'user')
        return item;
      replaced = true;
      return { ...item, text: foldPlaceholder(text, label) };
    }),
  };
}

/**
 * History with the brief folded: the earliest turn's opening user
 * message replaced, the brief returned beside it for the bar.
 */
export function foldBrief(
  turns: readonly TranscriptTurn[],
  label: string,
): { turns: TranscriptTurn[]; brief: string | null; seq: number | null } {
  const seq = briefTurnSeq(turns);
  if (seq === null) return { turns: [...turns], brief: null, seq: null };
  let brief: string | null = null;
  const folded = turns.map((turn) => {
    if (turn.seq !== seq) return turn;
    brief = briefTextOf(turn);
    return foldTurn(turn, label);
  });
  return {
    turns: folded,
    brief: brief && (brief as string).length >= FOLD_MIN_CHARS ? brief : null,
    seq,
  };
}
