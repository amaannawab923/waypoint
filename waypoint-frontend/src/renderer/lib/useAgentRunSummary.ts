import { useEffect, useSyncExternalStore } from 'react';
import { getAgentRun } from '@/data/api';

/**
 * "ROAD-116 · Investigate" for a run id — what a run-filed proposal's
 * "from run … ↗" line shows in Review (W5a §1.7). The same tiny module
 * cache useTicketLabel.ts keeps, for the same reason: a queue of twenty
 * cards on one run asks the backend once, and a run that could not be
 * read is remembered as `null` rather than retried on every render.
 */
export interface AgentRunSummary {
  id: string;
  title: string;
  intent: 'investigate' | 'fix' | 'custom' | null;
  status: string;
}

type Entry = { summary: AgentRunSummary | null } | undefined;

const summaries = new Map<string, Entry>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function load(runId: string): Promise<void> {
  const inFlight = pending.get(runId);
  if (inFlight) return inFlight;
  const p = getAgentRun(runId)
    .then((run) => {
      summaries.set(runId, {
        summary: run
          ? {
              id: run.id,
              title: run.title ?? run.branch ?? run.id,
              intent: run.intent,
              status: run.status,
            }
          : null,
      });
    })
    .catch(() => {
      summaries.set(runId, { summary: null });
    })
    .finally(() => {
      pending.delete(runId);
      notify();
    });
  pending.set(runId, p);
  return p;
}

/** Test-only. */
export function resetAgentRunSummariesForTests(): void {
  summaries.clear();
  pending.clear();
  notify();
}

/** undefined while loading; null when the run could not be read. */
export function useAgentRunSummary(
  runId: string | null | undefined,
): AgentRunSummary | null | undefined {
  const entry = useSyncExternalStore(
    subscribe,
    () => (runId ? summaries.get(runId) : undefined),
    () => (runId ? summaries.get(runId) : undefined),
  );
  useEffect(() => {
    if (runId && !summaries.has(runId)) load(runId).catch(() => {});
  }, [runId]);
  if (!runId) return null;
  return entry === undefined ? undefined : entry.summary;
}
