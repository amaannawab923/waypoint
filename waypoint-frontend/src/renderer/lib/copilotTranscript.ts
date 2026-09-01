import type { CopilotProposal } from '@/types/entities';

// The minimal message shape interleaving needs. `seq` is optional because
// optimistically-appended local messages (CopilotPanel's handleSend) don't
// have one until the next real fetch — they sort after every seq-bearing
// message, which is exactly where a just-typed message belongs anyway.
export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  seq?: number;
}

export type TranscriptItem<M extends TranscriptMessage> =
  | { type: 'message'; message: M }
  | { type: 'proposal'; proposal: CopilotProposal };

/**
 * Pure positioning logic for proposal cards in the Copilot transcript —
 * kept out of CopilotPanel.tsx so it's unit-testable without rendering.
 *
 * A proposal's anchorSeq is max(message seq) in the conversation at propose
 * time — i.e. the user message of the turn that proposed it. The card
 * belongs after that turn's ASSISTANT reply (the first assistant message
 * with seq > anchorSeq), matching how the model narrates then proposes.
 * Until that reply is persisted (mid-run, or the run failed after
 * proposing), it falls back to right after the anchor message itself — the
 * transcript tail at propose time — so a card never renders before the
 * message that caused it, and never disappears just because the reply
 * didn't land. Same-anchor proposals keep createdAt order.
 */
export function interleaveProposals<M extends TranscriptMessage>(
  messages: M[],
  proposals: CopilotProposal[],
): TranscriptItem<M>[] {
  // Message order is taken AS GIVEN, not re-sorted by seq: the panel's
  // cache is already chronological (backend fetches come seq-ascending;
  // optimistic appends land at the end, where a just-typed message
  // belongs), while a seq-based sort would shove every seq-less optimistic
  // message BEHIND its own later-persisted reply. Only proposals are
  // sorted, since their fetch order isn't load-bearing.
  const sortedProposals = [...proposals].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

  const afterMessage = new Map<string, CopilotProposal[]>();
  const tail: CopilotProposal[] = [];
  for (const proposal of sortedProposals) {
    const anchor =
      messages.find(
        (m) => m.role === 'assistant' && typeof m.seq === 'number' && m.seq > proposal.anchorSeq,
      ) ?? messages.find((m) => m.seq === proposal.anchorSeq);
    if (!anchor) {
      tail.push(proposal);
      continue;
    }
    afterMessage.set(anchor.id, [...(afterMessage.get(anchor.id) ?? []), proposal]);
  }

  const items: TranscriptItem<M>[] = [];
  for (const message of messages) {
    items.push({ type: 'message', message });
    for (const proposal of afterMessage.get(message.id) ?? []) {
      items.push({ type: 'proposal', proposal });
    }
  }
  for (const proposal of tail) {
    items.push({ type: 'proposal', proposal });
  }
  return items;
}
