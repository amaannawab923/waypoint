import { useEffect, useSyncExternalStore } from 'react';
import { getTicket } from '@/data/api';

/**
 * "ROAD-61 · Session list" for a ticket id — the label a dispatched run is
 * named by in the sessions panel (W3). A tiny module cache so a list of
 * twenty rows on the same ticket asks the backend once, and a row that
 * re-renders never re-asks; a ticket that could not be read (deleted, the
 * backend down) is remembered as `null` so the row falls back to its
 * branch rather than retrying on every render.
 */
export interface TicketSummary {
  identifier: string;
  title: string;
  /** "ROAD-61 · Session list" */
  label: string;
}

type Entry = { summary: TicketSummary | null } | undefined;

const labels = new Map<string, Entry>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function load(ticketId: string): Promise<void> {
  const inFlight = pending.get(ticketId);
  if (inFlight) return inFlight;
  const p = getTicket(ticketId)
    .then((ticket) => {
      labels.set(ticketId, {
        summary: ticket
          ? {
              identifier: ticket.identifier,
              title: ticket.title,
              label: `${ticket.identifier} · ${ticket.title}`,
            }
          : null,
      });
    })
    .catch(() => {
      labels.set(ticketId, { summary: null });
    })
    .finally(() => {
      pending.delete(ticketId);
      notify();
    });
  pending.set(ticketId, p);
  return p;
}

/** Test-only. */
export function resetTicketLabelsForTests(): void {
  labels.clear();
  pending.clear();
  notify();
}

/** `undefined` while unknown, `null` when there is no ticket or it could not be read, else its summary. */
export function useTicketSummary(
  ticketId: string | null | undefined,
): TicketSummary | null | undefined {
  const entry = useSyncExternalStore(
    subscribe,
    () => (ticketId ? labels.get(ticketId) : undefined),
    () => (ticketId ? labels.get(ticketId) : undefined),
  );
  useEffect(() => {
    if (ticketId && !labels.has(ticketId)) load(ticketId).catch(() => {});
  }, [ticketId]);
  if (!ticketId) return null;
  return entry?.summary;
}

/** The label alone — what a row is named by. */
export function useTicketLabel(
  ticketId: string | null | undefined,
): string | null | undefined {
  const summary = useTicketSummary(ticketId);
  return summary === undefined ? undefined : (summary?.label ?? null);
}
