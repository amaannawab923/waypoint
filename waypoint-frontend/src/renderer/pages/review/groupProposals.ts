import type { ProposalView } from '@/types/entities';
import type { RunVerdict } from '@/types/agentRuns';
import { verdictLabel } from '@/lib/runVerdict';

/**
 * How the Review queue is shaped for reading (customer feedback round 1,
 * Fix 1): the comment and the state change one closing message filed are
 * ONE card, comment first; several writing runs proposing to move the
 * same ticket out of the same state are one cluster, since approving one
 * of them decides the ticket. Pure: proposals in (the queue's order),
 * clusters out, first-seen order kept. The rows stay independent records
 * underneath — this is presentation.
 */

export interface ReviewGroup {
  /** Stable across reloads: the group id, else the proposal's own id. */
  key: string;
  /** The comment when the group has one, else the lone proposal. */
  primary: ProposalView;
  /** The state change filed with `primary`, when there is one. */
  companion: ProposalView | null;
}

export interface TicketCluster {
  key: string;
  ticketId: string | null;
  identifier: string | null;
  title: string | null;
  groups: ReviewGroup[];
  /**
   * Two or more runs each proposing to move this ticket out of the same
   * state — approving one supersedes the rest (the backend does it; the
   * banner says so before the click).
   */
  competingRuns: number;
}

function stateChangeOf(group: ReviewGroup): ProposalView | null {
  if (group.companion?.kind === 'state_change') return group.companion;
  return group.primary.kind === 'state_change' ? group.primary : null;
}

/**
 * Proposals filed before group ids existed: a run with exactly one open
 * comment and exactly one open state change is the same pair finalize
 * would have grouped, so it is paired here; anything more ambiguous
 * stays as it is.
 */
function legacyPairs(
  proposals: readonly ProposalView[],
): Map<string, ProposalView> {
  const byRun = new Map<
    string,
    { comments: ProposalView[]; changes: ProposalView[] }
  >();
  proposals.forEach((p) => {
    if (p.groupId || p.origin !== 'agent_run' || !p.agentRunId) return;
    if (p.status !== 'proposed') return;
    const entry = byRun.get(p.agentRunId) ?? { comments: [], changes: [] };
    if (p.kind === 'comment') entry.comments.push(p);
    else if (p.kind === 'state_change') entry.changes.push(p);
    byRun.set(p.agentRunId, entry);
  });
  const pairs = new Map<string, ProposalView>();
  byRun.forEach(({ comments, changes }) => {
    if (comments.length === 1 && changes.length === 1)
      pairs.set(comments[0].id, changes[0]);
  });
  return pairs;
}

export function groupProposals(
  proposals: readonly ProposalView[],
): ReviewGroup[] {
  const groups: ReviewGroup[] = [];
  const byGroupId = new Map<string, ReviewGroup>();
  const legacy = legacyPairs(proposals);
  const legacyCompanions = new Set([...legacy.values()].map((p) => p.id));
  proposals.forEach((p) => {
    if (!p.groupId) {
      if (legacyCompanions.has(p.id)) return;
      const companion = legacy.get(p.id) ?? null;
      groups.push({
        key: companion ? `${p.id}+${companion.id}` : p.id,
        primary: p,
        companion,
      });
      return;
    }
    const existing = byGroupId.get(p.groupId);
    if (!existing) {
      const group = { key: p.groupId, primary: p, companion: null };
      byGroupId.set(p.groupId, group);
      groups.push(group);
      return;
    }
    // Comment first, whatever the rows' own order.
    if (p.kind === 'comment' && existing.primary.kind !== 'comment') {
      existing.companion = existing.primary;
      existing.primary = p;
    } else if (!existing.companion) {
      existing.companion = p;
    } else {
      // A third row in one group is not a shape finalize produces; keep it
      // visible on its own rather than lose it.
      groups.push({ key: p.id, primary: p, companion: null });
    }
  });
  return groups;
}

export function clusterProposals(
  proposals: readonly ProposalView[],
): TicketCluster[] {
  const clusters: TicketCluster[] = [];
  const byTicket = new Map<string, TicketCluster>();
  groupProposals(proposals).forEach((group) => {
    const { primary } = group;
    // Only a run's proposals cluster: two people's own Copilot comments on
    // one ticket are not a conflict Waypoint should resolve for them.
    const ticketKey =
      primary.origin === 'agent_run' && primary.ticketId
        ? primary.ticketId
        : `single:${group.key}`;
    let cluster = byTicket.get(ticketKey);
    if (!cluster) {
      cluster = {
        key: ticketKey,
        ticketId: primary.ticketId,
        identifier: primary.snapshot.identifier ?? null,
        title: primary.snapshot.title ?? null,
        groups: [],
        competingRuns: 0,
      };
      byTicket.set(ticketKey, cluster);
      clusters.push(cluster);
    }
    cluster.groups.push(group);
  });
  clusters.forEach((cluster) => {
    const runsByFromState = new Map<string, Set<string>>();
    cluster.groups.forEach((group) => {
      const change = stateChangeOf(group);
      if (!change || change.status !== 'proposed' || !change.agentRunId) return;
      const from = change.snapshot.fromStateId;
      if (typeof from !== 'string') return;
      const runs = runsByFromState.get(from) ?? new Set<string>();
      runs.add(change.agentRunId);
      runsByFromState.set(from, runs);
    });
    // eslint-disable-next-line no-param-reassign
    cluster.competingRuns = Math.max(
      0,
      ...[...runsByFromState.values()].map((runs) => runs.size),
    );
    if (cluster.competingRuns < 2) cluster.competingRuns = 0; // eslint-disable-line no-param-reassign
  });
  return clusters;
}

const MAX_JUSTIFICATION_CHARS = 140;

/**
 * The one sentence from a run's comment that justifies its state change,
 * shown beside the transition arrow: the first sentence of the summary,
 * after the "Follow-up N" and "Verdict:" lines the comment opens with,
 * with inline markdown marks dropped.
 */
export function justificationOf(
  commentBody: string | undefined,
): string | null {
  if (!commentBody) return null;
  const lines = commentBody
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^\*{0,2}follow-up\s+\d+\*{0,2}$/i.test(l))
    .filter((l) => !/^[*_#>\s-]*verdict\s*[:—–-]/i.test(l))
    .filter((l) => !/^#{1,6}\s/.test(l));
  const first = lines[0];
  if (!first) return null;
  const plain = first
    .replace(/[*_`~]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const sentence = plain.split(/(?<=[.!?])\s+/)[0] ?? plain;
  return sentence.length > MAX_JUSTIFICATION_CHARS
    ? `${sentence.slice(0, MAX_JUSTIFICATION_CHARS - 1)}…`
    : sentence;
}

/**
 * A `Verdict:` line's own word, anchored to that line's start — never a
 * bare scan for the substring "verdict" anywhere in a summary (S1, PR
 * #88 review). The line filter `justificationOf` already applies above
 * (`^[*_#>\s-]*verdict\s*[:—–-]`) is reused here as the anchor, so the
 * two never disagree about what counts as a verdict line.
 */
function verdictWordFromBody(commentBody: string | undefined): string | null {
  if (!commentBody) return null;
  const lines = commentBody.replace(/\r\n/g, '\n').split('\n');
  for (const raw of lines) {
    const match =
      /^[*_#>\s-]*verdict\s*[:—–-]\s*\**\s*([a-z][a-z' -]*[a-z])/i.exec(
        raw.trim(),
      );
    if (match) return match[1].trim().toLowerCase();
  }
  return null;
}

/**
 * Why a card is in the queue at all, in the reviewer's terms.
 *
 * S1 (PR #88 review): this used to read the verdict word out of the
 * comment BODY with an unanchored regex — `126a2dc` removed the verdict
 * tag `buildRunComment` (runComment.ts) used to put there for most
 * comments (S5 in this same review round put a narrower one back, only
 * when there is no paired state change), so the regex mostly matched
 * nothing — except when a summary sentence happened to contain the word
 * "verdict" on its own, e.g. "the verdict is that the API was already
 * correct" rendered as "— verdict is that the api was already correct".
 * `runVerdict` — the run's own column, read via `useAgentRunSummary` at
 * the call site — is the authoritative source now; the body is only a
 * fallback for the moment that summary has not loaded yet (or the run
 * could not be read at all), and even then anchored to a literal
 * `Verdict:` line's own start.
 */
export function whyItExists(
  primary: ProposalView,
  runVerdict?: RunVerdict | null,
): string {
  if (primary.origin === 'agent_run') {
    const followUp = /^\*{0,2}follow-up\s+(\d+)/i.exec(
      primary.payload.body ?? '',
    );
    const what = followUp
      ? `follow-up ${followUp[1]} of this run's report`
      : "this run's closing report";
    const verdict = runVerdict
      ? verdictLabel(runVerdict)
      : verdictWordFromBody(primary.payload.body);
    return verdict ? `${what} — verdict ${verdict}` : what;
  }
  return 'Copilot proposed it in your conversation';
}
