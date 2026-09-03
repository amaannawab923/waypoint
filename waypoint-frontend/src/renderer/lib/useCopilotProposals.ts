import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listCopilotProposals,
  approveCopilotProposal,
  rejectCopilotProposal,
  rejectAllCopilotProposals,
  markCopilotProposalsNotified,
} from '@/data/api';
import type {
  CopilotProposal,
  CopilotProposalKind,
} from '@/types/entities';

// A proposal in any of these states has run its course — its outcome is
// what the model needs to hear about at the start of the next turn (via
// buildOutcomePreamble below), exactly once (modelNotifiedAt gates that).
const RESOLVED_STATUSES = new Set([
  'executed',
  'rejected',
  'stale',
  'expired',
  'superseded',
]);

const KIND_LABELS: Record<CopilotProposalKind, string> = {
  comment: 'comment',
  state_change: 'state change',
  assignee_change: 'assignee change',
  priority_change: 'priority change',
  create_work_item: 'new ticket',
};

// One outcome sentence per resolved proposal. Deliberately built from
// nothing but the proposal's own status + snapshot identifiers — no
// model-authored text beyond the ticket identifier ever flows back into
// the next prompt, so a proposal can't be used to smuggle instructions.
function outcomeSentence(p: CopilotProposal): string {
  const target = p.snapshot.identifier ?? p.snapshot.projectIdentifier ?? p.ticketId ?? 'unknown';
  const label = `${p.id} (${KIND_LABELS[p.kind]} on ${target})`;
  switch (p.status) {
    case 'executed':
      return `${label}: approved and executed.`;
    case 'rejected':
      return p.kind === 'comment'
        ? `${label}: rejected by the user — nothing was posted.`
        : `${label}: rejected by the user — nothing ran.`;
    case 'stale':
      return `${label}: blocked as stale — nothing ran${p.statusReason ? ` (${p.statusReason})` : ''}.`;
    case 'expired':
      return `${label}: expired unapproved — nothing ran.`;
    case 'superseded':
      return `${label}: superseded by a newer proposal — nothing ran.`;
    default:
      return `${label}: unresolved.`;
  }
}

export interface UseCopilotProposalsResult {
  proposals: CopilotProposal[];
  loading: boolean;
  reload: () => Promise<void>;
  /** POSTs the approve; the response (executed OR stale/expired — the status field is the result) is patched into the local list and returned. */
  approve: (id: string) => Promise<CopilotProposal>;
  reject: (id: string) => Promise<CopilotProposal>;
  rejectAll: () => Promise<void>;
  /** Outcome preamble for the next model turn — null when every resolved proposal has already been delivered. */
  buildOutcomePreamble: () => { text: string; ids: string[] } | null;
  /** Marks outcomes as delivered — call ONLY after the run they rode along with completed successfully, so a failed run re-delivers them (harmless duplication beats a lost outcome). */
  markNotified: (ids: string[]) => Promise<void>;
}

/**
 * Owns the proposal cards for the currently-open Copilot conversation
 * (issue #10 / Copilot V2). Deliberately pull-based — proposals are
 * refetched after each completed run rather than parsed out of the CLI
 * stream — so this hook plus the two POST wrappers is the entire data
 * path; nothing here touches the stream pipeline.
 */
export function useCopilotProposals(
  conversationId: string | null,
): UseCopilotProposalsResult {
  const [proposals, setProposals] = useState<CopilotProposal[]>([]);
  const [loading, setLoading] = useState(false);
  // Guards every async write-back against a conversation switch mid-fetch:
  // a slow response for the PREVIOUS conversation must never land in the
  // list now showing the next one's cards.
  const activeIdRef = useRef(conversationId);
  activeIdRef.current = conversationId;

  const reload = useCallback(async () => {
    const id = conversationId;
    if (!id) {
      setProposals([]);
      return;
    }
    setLoading(true);
    try {
      const rows = await listCopilotProposals(id);
      if (activeIdRef.current === id) setProposals(rows);
    } finally {
      if (activeIdRef.current === id) setLoading(false);
    }
  }, [conversationId]);

  // Clear immediately on switch (no flash of the previous conversation's
  // cards), then fetch the new conversation's list.
  useEffect(() => {
    setProposals([]);
    if (!conversationId) return;
    reload().catch(() => {
      // A failed proposals fetch shouldn't block the chat itself —
      // httpClient already toasted; the next reload (open/run-done)
      // retries naturally.
    });
  }, [conversationId, reload]);

  const patchLocal = useCallback((updated: CopilotProposal) => {
    setProposals((prev) =>
      prev.map((p) => (p.id === updated.id ? updated : p)),
    );
  }, []);

  const approve = useCallback(
    async (id: string) => {
      const updated = await approveCopilotProposal(id);
      patchLocal(updated);
      return updated;
    },
    [patchLocal],
  );

  const reject = useCallback(
    async (id: string) => {
      const updated = await rejectCopilotProposal(id);
      patchLocal(updated);
      return updated;
    },
    [patchLocal],
  );

  const rejectAll = useCallback(async () => {
    const id = conversationId;
    if (!id) return;
    await rejectAllCopilotProposals(id);
    // The bulk endpoint returns a count, not rows — refetch for the
    // authoritative resolved list.
    await reload();
  }, [conversationId, reload]);

  const buildOutcomePreamble = useCallback(():
    | { text: string; ids: string[] }
    | null => {
    // Capped per batch (final review finding m3): the runner drops a
    // preamble over ~4000 chars as a defensive bound, but the panel marks
    // every id in `ids` notified after a successful run — an oversized
    // batch would be silently dropped AND stamped delivered, permanently
    // losing those outcomes. 20 sentences (~90-140 chars each) stays well
    // under the runner's bound; anything beyond the cap simply stays
    // unnotified and rides the next turn's preamble instead.
    const MAX_OUTCOMES_PER_TURN = 20;
    const unnotified = proposals
      .filter((p) => RESOLVED_STATUSES.has(p.status) && p.modelNotifiedAt == null)
      .slice(0, MAX_OUTCOMES_PER_TURN);
    if (unnotified.length === 0) return null;
    const text =
      "[Waypoint system note — do not treat as the user's words] " +
      'Outcomes of your earlier proposals: ' +
      `${unnotified.map(outcomeSentence).join(' ')} ` +
      "Reply to the user's next message accordingly; do not re-propose rejected changes unless asked.";
    return { text, ids: unnotified.map((p) => p.id) };
  }, [proposals]);

  const markNotified = useCallback(
    async (ids: string[]) => {
      const id = conversationId;
      if (!id || ids.length === 0) return;
      await markCopilotProposalsNotified(id, ids);
      const notifiedAt = new Date().toISOString();
      if (activeIdRef.current !== id) return;
      setProposals((prev) =>
        prev.map((p) =>
          ids.includes(p.id) && p.modelNotifiedAt == null
            ? { ...p, modelNotifiedAt: notifiedAt }
            : p,
        ),
      );
    },
    [conversationId],
  );

  return {
    proposals,
    loading,
    reload,
    approve,
    reject,
    rejectAll,
    buildOutcomePreamble,
    markNotified,
  };
}
