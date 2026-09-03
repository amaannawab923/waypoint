import { useSyncExternalStore } from 'react';
import { approveCopilotProposal, rejectCopilotProposal } from '@/data/api';
import type { ProposalView } from '@/types/entities';

// A minimal, scoped client cache for proposals (architecture §1.8) — NOT a
// general react-query replacement (the doc is explicit: that's a 27k-line
// refactor nobody asked for). One proposal can be visible on several
// mounted surfaces at once — the Copilot panel transcript today, a future
// Review screen (W4.3) and ticket drawer (W4.4) tomorrow — and this module
// is what makes "approve here, gone everywhere" true (the mockup's central
// promise) without any surface refetching. Every reader shares the same
// underlying Map; every writer broadcasts to everyone subscribed. Same
// subscribe/notify pub-sub shape as lib/toast.ts, just holding a keyed
// collection instead of a stream of one-shot messages.
//
// What this module deliberately does NOT do: fetch. It has no idea how a
// row got here — a conversation-scoped GET, a workspace-scoped review-queue
// page, a single approve response — it only holds what it's given and
// mutates it in place. Fetching stays owned by whichever hook/page needs a
// particular scope (useCopilotProposals today; a useReviewQueue-shaped hook
// later).

type Listener = () => void;

const byId = new Map<string, ProposalView>();
const listeners = new Set<Listener>();

// Bumped on every mutation. getAllSnapshot only rebuilds its cached array
// when this has moved since the array was last built, so a component
// subscribed via useSyncExternalStore doesn't see a new array reference
// (and re-render) on every read when nothing in the store actually changed.
let version = 0;
let allSnapshot: ProposalView[] = [];
let allSnapshotVersion = -1;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Subscribe to any change in the store (a fetch feeding rows in, an
 * approve/reject resolving one). Returns an unsubscribe function — same
 * shape as lib/toast.ts's subscribeToasts. Prefer the `useAllProposals`
 * hook below in React components; this is the lower-level primitive it's
 * built on.
 */
export function subscribeProposals(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Feed rows into the store from whatever fetch produced them — the Copilot
 * panel's conversation-scoped list today, a future Review-queue page fetch
 * tomorrow. Upserts by id, so two surfaces fetching overlapping proposals
 * converge on one shared row instead of fighting; a fetch that raced an
 * approve on another surface simply gets overwritten by upsert order like
 * any last-write-wins cache (the approve response upsert already races the
 * same way, and is no worse off here).
 */
export function upsertProposals(rows: ProposalView[]): void {
  if (rows.length === 0) return;
  for (const row of rows) byId.set(row.id, row);
  notify();
}

/**
 * Apply a row-by-row transform to whichever of `ids` the store currently
 * holds — e.g. patching a `modelNotifiedAt` timestamp onto a set of
 * proposals without a server round trip that returns full rows (the
 * mark-notified endpoint only returns a count). `updater` returning the
 * SAME reference for a row it decided not to touch keeps that row (and the
 * eventual notify) a no-op, matching the conditional patch
 * useCopilotProposals used to do inline.
 */
export function updateProposals(
  ids: string[],
  updater: (proposal: ProposalView) => ProposalView,
): void {
  let changed = false;
  for (const id of ids) {
    const existing = byId.get(id);
    if (!existing) continue;
    const next = updater(existing);
    if (next !== existing) {
      byId.set(id, next);
      changed = true;
    }
  }
  if (changed) notify();
}

export function getProposal(id: string): ProposalView | undefined {
  return byId.get(id);
}

/**
 * Test-only escape hatch. This module is a singleton whose Map outlives any
 * single `it()` block within a test FILE (Jest only sandboxes the module
 * registry per file, not per test) — and fixture ids are commonly reused
 * across tests (e.g. a counter reset to 1 in `beforeEach`), so a proposal
 * left over from a previous test can otherwise leak into the next one under
 * the same id. Call this from a top-level `beforeEach` in any test that
 * exercises the store (directly, or through useCopilotProposals).
 */
export function resetProposalStoreForTests(): void {
  byId.clear();
  notify();
}

function getAllSnapshot(): ProposalView[] {
  if (allSnapshotVersion !== version) {
    allSnapshot = Array.from(byId.values());
    allSnapshotVersion = version;
  }
  return allSnapshot;
}

/**
 * Approve/reject POST through the exact same wrappers the Copilot panel
 * always called (data/api.ts's approveCopilotProposal/rejectCopilotProposal
 * — the backend's claim-based state machine doesn't change, and approving a
 * proposal is approving a proposal regardless of which surface it's
 * rendered on). What changes is where the result lands: upserted into the
 * shared map and broadcast, so every subscribed surface sees the resolved
 * row immediately — not just the caller's own local state, and with no
 * refetch anywhere.
 */
export async function approveProposal(id: string): Promise<ProposalView> {
  const updated = await approveCopilotProposal(id);
  upsertProposals([updated]);
  return updated;
}

export async function rejectProposal(id: string): Promise<ProposalView> {
  const updated = await rejectCopilotProposal(id);
  upsertProposals([updated]);
  return updated;
}

/**
 * React binding: every proposal currently held by the store, live. Consumers
 * scope it locally (e.g. `.filter((p) => p.conversationId === id)` — see
 * useCopilotProposals.ts) — the store itself doesn't know about
 * conversations, tickets, projects, or any other surface-specific scope,
 * only ids. `getAllSnapshot` is referentially stable across renders where
 * nothing changed, so a plain filter downstream stays cheap and doesn't
 * defeat useSyncExternalStore's bail-out.
 *
 * This is the mechanism behind the accept criterion for W4.1: two
 * independently-mounted components both calling this hook (or a selector
 * built on it) read the same Map, so an approve fired from one is visible
 * in the other's next render with no refetch, because notify() runs once
 * for every subscriber, not once per caller.
 */
export function useAllProposals(): ProposalView[] {
  return useSyncExternalStore(
    subscribeProposals,
    getAllSnapshot,
    getAllSnapshot,
  );
}
