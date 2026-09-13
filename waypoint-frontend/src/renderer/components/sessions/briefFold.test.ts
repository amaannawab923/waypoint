import type { TranscriptTurn } from '@emdash/core/runtimes/acp/api/client' with {
  'resolution-mode': 'import',
};
import {
  FOLD_MIN_CHARS,
  foldBrief,
  foldTurn,
  foldPlaceholder,
} from './briefFold';

const long = `You are working on ROAD-43…\n${'x'.repeat(FOLD_MIN_CHARS)}\n## Your task`;

const turn = (seq: number, items: TranscriptTurn['items']): TranscriptTurn =>
  ({ id: `t${seq}`, seq, initiator: 'user', items }) as TranscriptTurn;
const user = (text: string) =>
  ({
    kind: 'message',
    id: 'm',
    seq: 1,
    role: 'user',
    text,
  }) as TranscriptTurn['items'][number];
const assistant = (text: string) =>
  ({
    kind: 'message',
    id: 'a',
    seq: 2,
    role: 'assistant',
    text,
  }) as TranscriptTurn['items'][number];

describe('foldBrief', () => {
  it('folds the earliest turn’s opening user message and hands the text back', () => {
    const { turns, brief, seq } = foldBrief(
      [
        turn(2, [user('follow-up'), assistant('ok')]),
        turn(1, [user(long), assistant('reply')]),
      ],
      'ROAD-43 · Investigate',
    );
    expect(seq).toBe(1);
    expect(brief).toBe(long);
    const folded = turns.find((t) => t.seq === 1)!;
    expect((folded.items[0] as { text: string }).text).toBe(
      foldPlaceholder(long, 'ROAD-43 · Investigate'),
    );
    expect((folded.items[0] as { text: string }).text).toContain('View brief');
    expect((folded.items[1] as { text: string }).text).toBe('reply');
    // The other turn is untouched, and the input is not mutated.
    expect(
      (turns.find((t) => t.seq === 2)!.items[0] as { text: string }).text,
    ).toBe('follow-up');
  });

  it('leaves a short first message alone, and an empty history', () => {
    const short = [turn(1, [user('hi'), assistant('hello')])];
    const { turns, brief } = foldBrief(short, 'x');
    expect(brief).toBeNull();
    expect(turns[0]).toBe(short[0]);
    expect(foldBrief([], 'x')).toEqual({ turns: [], brief: null, seq: null });
  });

  it('foldTurn folds only a user-opened turn', () => {
    const agentFirst = turn(1, [assistant(long)]);
    expect(foldTurn(agentFirst, 'x')).toBe(agentFirst);
  });
});
