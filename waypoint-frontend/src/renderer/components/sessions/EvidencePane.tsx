import { useEffect, useState } from 'react';
import {
  listRunEvidence,
  onRunChanged,
  readRunEvidence,
  type RunEvidenceItem,
} from '@/data/engineApi';
import { IconRefresh } from '@/components/icons';
import type { AgentRun } from '@/types/agentRuns';
import { statusView } from './sessionStatus';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** One screenshot: its bytes fetched on demand, once, as a data URL. */
function EvidenceImage({
  runId,
  item,
}: {
  runId: string;
  item: RunEvidenceItem;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    const read = async () => {
      try {
        const file = await readRunEvidence(runId, item.name);
        if (!cancelled) setSrc(file.dataUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    read().catch(() => {});
    return () => {
      cancelled = true;
    };
    // A file is re-read when its bytes change (same name, new mtime).
  }, [runId, item.name, item.modifiedAt]);

  return (
    <figure
      data-evidence-item={item.name}
      className="m-0 flex flex-col gap-1.5 rounded-[var(--radius)] border border-border bg-surface p-2"
    >
      <figcaption className="flex items-baseline justify-between gap-2 px-0.5">
        <span className="truncate font-mono text-[11px] text-text">
          {item.name}
        </span>
        <span className="shrink-0 text-[10px] text-text-muted">
          {formatBytes(item.bytes)}
        </span>
      </figcaption>
      {src ? (
        <img
          src={src}
          alt={item.name}
          className="max-h-[480px] w-full rounded-[var(--radius-sm)] border border-border object-contain object-top"
        />
      ) : (
        <div className="flex h-24 items-center justify-center text-[11px] text-text-muted">
          {failed ? 'Could not read this file.' : 'Loading…'}
        </div>
      )}
    </figure>
  );
}

/**
 * The Evidence tab: the screenshots a session saved while verifying its
 * change in the isolated browser (the "Verify in the browser" switch on
 * the brief). Read through runs:list-evidence, which copies whatever the
 * session has saved so far into Waypoint's keep before answering — so a
 * run still working shows its progress, and a merged run whose worktree
 * is gone still shows its proof. Re-read after every reported change to
 * the run, like the Diff tab.
 */
export function EvidencePane({
  run,
  onCount,
}: {
  run: AgentRun;
  onCount: (count: number | null) => void;
}) {
  const [items, setItems] = useState<RunEvidenceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listRunEvidence(run.id);
      setItems(result);
      onCount(result.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setItems(null);
    load().catch(() => {});
    const off = onRunChanged((change) => {
      if (change.runId === run.id) load().catch(() => {});
    });
    return off;
    // Per run; `load` reads the id from `run`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  const live = statusView(run.status).live || run.status === 'queued';
  let heading = '';
  if (items)
    heading = `${items.length} screenshot${items.length === 1 ? '' : 's'}`;
  else if (loading) heading = 'Reading…';

  return (
    <div className="thin-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-4 pt-2.5 pb-1.5 text-[10px] text-text-muted">
        <span className="font-mono">{heading}</span>
        <button
          type="button"
          aria-label="Refresh evidence"
          onClick={() => load().catch(() => {})}
          disabled={loading}
          className="flex size-5 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
        >
          <IconRefresh size={11} />
        </button>
      </div>
      {error && (
        <p className="px-4 pb-2 text-[11px] text-danger" data-evidence-error>
          {error}
        </p>
      )}
      {items && items.length === 0 && !error && (
        <p className="px-4 pb-4 text-xs text-text-secondary">
          {live
            ? 'No screenshots yet — a session asked to verify in the browser saves them here as it works.'
            : 'This run saved no screenshots. Sessions save them when the brief asks to verify in the browser.'}
        </p>
      )}
      {items && items.length > 0 && (
        <div className="grid grid-cols-1 gap-3 px-4 pb-4 xl:grid-cols-2">
          {items.map((item) => (
            <EvidenceImage key={item.name} runId={run.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
