import { interleaveProposals } from './copilotTranscript';
import type { CopilotProposal } from '@/types/entities';

function msg(
  id: string,
  role: 'user' | 'assistant',
  seq?: number,
): { id: string; role: 'user' | 'assistant'; content: string; createdAt: string; seq?: number } {
  return { id, role, content: `content-${id}`, createdAt: '2026-01-01T00:00:00.000Z', seq };
}

function proposal(id: string, anchorSeq: number, createdAt: string): CopilotProposal {
  return {
    id,
    conversationId: 'conv-1',
    kind: 'comment',
    ticketId: 'wi-1',
    payload: { body: 'hi' },
    snapshot: { identifier: 'WI-1', title: 'T' },
    anchorSeq,
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    disclosureText: 'disclosure ',
    expiresAt: '2026-01-02T00:00:00.000Z',
    modelNotifiedAt: null,
    resolvedAt: null,
    createdAt,
  };
}

function shape(items: ReturnType<typeof interleaveProposals>) {
  return items.map((i) => (i.type === 'message' ? `m:${i.message.id}` : `p:${i.proposal.id}`));
}

describe('interleaveProposals', () => {
  it('places a proposal after the first assistant message with seq greater than its anchorSeq', () => {
    // anchorSeq 1 = the user message of the proposing turn; the card
    // belongs after that turn's assistant reply (seq 2), before the next
    // exchange.
    const messages = [
      msg('u1', 'user', 1),
      msg('a1', 'assistant', 2),
      msg('u2', 'user', 3),
      msg('a2', 'assistant', 4),
    ];
    const items = interleaveProposals(messages, [proposal('p1', 1, '2026-01-01T00:01:00.000Z')]);

    expect(shape(items)).toEqual(['m:u1', 'm:a1', 'p:p1', 'm:u2', 'm:a2']);
  });

  it('falls back to right after the anchor message itself when no later assistant reply exists yet', () => {
    // Mid-run (or the run died after proposing): the assistant reply for
    // this turn is not persisted, so the card sits at the transcript tail —
    // after the user message that triggered it — instead of vanishing.
    const messages = [msg('u1', 'user', 1), msg('a1', 'assistant', 2), msg('u2', 'user', 3)];
    const items = interleaveProposals(messages, [proposal('p1', 3, '2026-01-01T00:01:00.000Z')]);

    expect(shape(items)).toEqual(['m:u1', 'm:a1', 'm:u2', 'p:p1']);
  });

  it('keeps same-anchor proposals in createdAt order', () => {
    const messages = [msg('u1', 'user', 1), msg('a1', 'assistant', 2)];
    const items = interleaveProposals(messages, [
      proposal('p-later', 1, '2026-01-01T00:02:00.000Z'),
      proposal('p-earlier', 1, '2026-01-01T00:01:00.000Z'),
    ]);

    expect(shape(items)).toEqual(['m:u1', 'm:a1', 'p:p-earlier', 'p:p-later']);
  });

  it('produces the same layout after a reload as it did live — proposal fetch order never matters', () => {
    // Live: proposals arrive appended after each run; reload: everything
    // comes back in one createdAt-ordered fetch. The transcript must not
    // shift between the two (messages are chronological either way — see
    // the helper's own comment on why THEIR order is trusted as given).
    const messages = [
      msg('u1', 'user', 1),
      msg('a1', 'assistant', 2),
      msg('u2', 'user', 3),
      msg('a2', 'assistant', 4),
    ];
    const proposals = [
      proposal('p1', 1, '2026-01-01T00:01:00.000Z'),
      proposal('p2', 3, '2026-01-01T00:03:00.000Z'),
    ];

    const live = interleaveProposals(messages, proposals);
    const reloaded = interleaveProposals(messages, [...proposals].reverse());

    expect(shape(reloaded)).toEqual(shape(live));
    expect(shape(live)).toEqual(['m:u1', 'm:a1', 'p:p1', 'm:u2', 'm:a2', 'p:p2']);
  });

  it('appends a proposal to the very end when nothing matches its anchor (empty transcript)', () => {
    const items = interleaveProposals([], [proposal('p1', 0, '2026-01-01T00:01:00.000Z')]);
    expect(shape(items)).toEqual(['p:p1']);
  });

  it('keeps a seq-less optimistic message exactly where the cache put it — never reordered behind its own reply', () => {
    // The live-send shape: fetched history, then the optimistic (seq-less)
    // user message, then the persisted reply appended after it. A seq sort
    // would push the seq-less message to the end, rendering the user's
    // message BELOW the reply it caused.
    const optimistic = msg('local1', 'user');
    const items = interleaveProposals(
      [msg('u1', 'user', 1), msg('a1', 'assistant', 2), optimistic, msg('a2', 'assistant', 4)],
      [],
    );
    expect(shape(items)).toEqual(['m:u1', 'm:a1', 'm:local1', 'm:a2']);
  });
});
