import type { DaemonRunsApi, DaemonTranscriptTurn } from './daemonApi';
import type { LedgerClient } from './ledgerClient';

/**
 * The transcript, kept — ROAD-124, found on the first W5a live pass: the
 * daemon holds a session's history in memory only, so an app restart (the
 * daemon restarts with it) or the kill that ends a finalized run emptied
 * the pane of a run whose proposals were still in Review.
 *
 * Main snapshots the committed turns into the ledger at every point it
 * knows the history changed or is about to go: after every turn end (the
 * follower's idle fact, every run of ours), before finalize kills the
 * session, before Stop kills it, and when a session closes on its own if
 * the daemon still answers. A snapshot that says nothing new (same turn
 * count, same last turn) is skipped; one that would exceed the ledger's
 * cap drops its oldest turns first — the end of a transcript is the part
 * a reviewer reads.
 */
export interface TranscriptKeeperDeps {
  ledger: Pick<LedgerClient, 'saveTranscript' | 'getTranscript'>;
  daemon: () => Pick<DaemonRunsApi, 'getHistory'> | null;
  logger: {
    info: (m: string, meta?: Record<string, unknown>) => void;
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
}

/** The most turns read back per snapshot; a run past this keeps its newest. */
export const TRANSCRIPT_TURNS = 500;
/** Under the backend's 4 MiB schema cap, with room for the envelope. */
export const MAX_TRANSCRIPT_BYTES = 3_800_000;

export interface TranscriptKeeper {
  /**
   * Snapshot the run's history — the turns given, else read from the
   * daemon. Never throws: a failure is a warning, and the next turn end
   * tries again.
   */
  capture(runId: string, turns?: DaemonTranscriptTurn[]): Promise<void>;
}

/**
 * A tool item's images (screenshots, base64 — the transcript's one heavy
 * field since the emdash fork carries them) removed, everything else
 * kept. Recursive: a group's children are tool items too.
 */
function withoutImages(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item;
  const rest = { ...(item as Record<string, unknown>) };
  delete rest.images;
  return {
    ...rest,
    ...(Array.isArray(rest.children)
      ? { children: rest.children.map(withoutImages) }
      : {}),
  };
}

function stripImages(turn: DaemonTranscriptTurn): DaemonTranscriptTurn {
  return {
    ...turn,
    items: turn.items.map(withoutImages) as DaemonTranscriptTurn['items'],
  };
}

/**
 * The newest turns that fit the cap. Oldest turns go first; then, before
 * the last turn would go, its images — the text of a run's final report
 * outranks its screenshots, and a single verification turn's screenshots
 * can exceed the cap on their own (found in review: the loop below used
 * to shrink to one turn and then return NOTHING, emptying the run's saved
 * history exactly when it held the most evidence).
 */
export function fitTurns(
  turns: DaemonTranscriptTurn[],
  maxBytes = MAX_TRANSCRIPT_BYTES,
): DaemonTranscriptTurn[] {
  const size = (t: DaemonTranscriptTurn[]) => JSON.stringify(t).length;
  let kept = turns;
  while (kept.length > 1 && size(kept) > maxBytes) {
    kept = kept.slice(Math.max(1, Math.ceil(kept.length / 10)));
  }
  if (kept.length === 0 || size(kept) <= maxBytes) return kept;
  // Down to what the cap cannot fit whole: images go, oldest turn first.
  kept = [...kept];
  for (let i = 0; i < kept.length && size(kept) > maxBytes; i += 1) {
    kept[i] = stripImages(kept[i]);
  }
  return size(kept) <= maxBytes ? kept : [];
}

function fingerprint(turns: DaemonTranscriptTurn[]): string {
  const last = turns[turns.length - 1];
  return `${turns.length}:${last?.seq ?? ''}:${last?.outcome?.kind ?? ''}:${last?.items.length ?? 0}`;
}

/**
 * Never-lock (design §5.4): a session the provider could not restore
 * (`replaced-by-new`) starts its history afresh, so the daemon's page no
 * longer holds the turns before the resume — but the ledger's snapshot
 * does. The kept transcript is the snapshot's turns the page lacks (by
 * id, in their order) followed by the page, so a continued conversation
 * reads whole. A turn the page does have wins (it is the daemon's
 * current rendering of it).
 */
export function mergeTurns(
  snapshot: DaemonTranscriptTurn[],
  page: DaemonTranscriptTurn[],
): DaemonTranscriptTurn[] {
  const inPage = new Set(page.map((t) => t.id));
  const kept = snapshot.filter((t) => !inPage.has(t.id));
  return kept.length ? [...kept, ...page] : page;
}

export function createTranscriptKeeper(
  deps: TranscriptKeeperDeps,
): TranscriptKeeper {
  const lastSaved = new Map<string, string>();
  const inFlight = new Map<string, Promise<void>>();
  const prior = new Map<string, DaemonTranscriptTurn[]>();
  const priorLoaded = new Set<string>();

  const snapshot = async (
    runId: string,
    given?: DaemonTranscriptTurn[],
  ): Promise<void> => {
    let turns = given;
    if (!turns) {
      const daemon = deps.daemon();
      if (!daemon) return;
      try {
        turns = await daemon.getHistory(runId, TRANSCRIPT_TURNS);
      } catch (error) {
        // A session the daemon no longer has: nothing to snapshot; what
        // was saved at its last turn end stands.
        deps.logger.info('engine: transcript not readable', {
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (turns.length === 0) return;
    // The snapshot's own earlier turns, read once per run per process —
    // what a fresh session's page no longer carries (mergeTurns).
    if (!priorLoaded.has(runId)) {
      priorLoaded.add(runId);
      try {
        const kept = await deps.ledger.getTranscript(runId);
        prior.set(runId, (kept?.turns ?? []) as DaemonTranscriptTurn[]);
      } catch {
        prior.set(runId, []);
      }
    }
    const merged = mergeTurns(prior.get(runId) ?? [], turns);
    const key = fingerprint(merged);
    if (lastSaved.get(runId) === key) return;
    try {
      const { turnCount } = await deps.ledger.saveTranscript(
        runId,
        fitTurns(merged),
      );
      prior.set(runId, merged);
      lastSaved.set(runId, key);
      deps.logger.info('engine: transcript kept', { runId, turns: turnCount });
    } catch (error) {
      deps.logger.warn('engine: transcript not kept', {
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    async capture(runId, turns) {
      // One snapshot per run at a time; a second request while one is in
      // flight waits for it and then takes its own.
      const previous = inFlight.get(runId) ?? Promise.resolve();
      const next = previous.then(() => snapshot(runId, turns));
      inFlight.set(runId, next);
      try {
        await next;
      } finally {
        if (inFlight.get(runId) === next) inFlight.delete(runId);
      }
    },
  };
}
