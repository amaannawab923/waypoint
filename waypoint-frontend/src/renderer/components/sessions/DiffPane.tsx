import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { getRunDiff } from '@/data/engineApi';
import { IconRefresh } from '@/components/icons';
import type { AgentRun, RunDiff, RunDiffFile } from '@/types/agentRuns';
import { statusView } from './sessionStatus';

const GLYPH: Record<
  RunDiffFile['status'],
  { letter: string; className: string }
> = {
  added: { letter: 'A', className: 'bg-success-bg text-success' },
  untracked: { letter: 'A', className: 'bg-success-bg text-success' },
  modified: { letter: 'M', className: 'bg-info-bg text-info' },
  renamed: { letter: 'R', className: 'bg-info-bg text-info' },
  deleted: { letter: 'D', className: 'bg-danger-bg text-danger' },
};

/**
 * Splits one unified patch into per-file hunks, keyed by the new path —
 * `diff --git a/x b/x` headers are what git emits for tracked files, and
 * `--no-index` emits the same shape for the untracked ones runsIpc.ts
 * folds in.
 */
export function splitPatch(patch: string): Map<string, string> {
  const files = new Map<string, string>();
  const parts = patch.split(/^(?=diff --git )/m);
  for (const part of parts) {
    if (!part.startsWith('diff --git ')) continue;
    const header = part.slice(0, part.indexOf('\n'));
    // `diff --git a/<old> b/<new>` — the new path is what the list shows.
    const match = / b\/(.+)$/.exec(header);
    if (match) files.set(match[1], part);
  }
  return files;
}

type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

function lineKind(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('similarity') ||
    line.startsWith('rename ')
  )
    return 'meta';
  return 'ctx';
}

const LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-success-bg text-success',
  del: 'bg-danger-bg text-danger',
  hunk: 'bg-bg-inset text-text-muted',
  meta: 'text-text-muted',
  ctx: 'text-text-secondary',
};

interface NumberedLine {
  text: string;
  kind: DiffLineKind;
  /** New-file line number for context and added lines; old-file for deleted. */
  no: number | null;
}

/** Walks the hunks so every line carries the number a person would look for in the file. */
export function numberLines(text: string): NumberedLine[] {
  const out: NumberedLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const kind = lineKind(line);
    if (kind === 'hunk') {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      out.push({ text: line, kind, no: null });
    } else if (kind === 'add') {
      out.push({ text: line, kind, no: newNo });
      newNo += 1;
    } else if (kind === 'del') {
      out.push({ text: line, kind, no: oldNo });
      oldNo += 1;
    } else if (kind === 'ctx') {
      out.push({ text: line, kind, no: newNo });
      oldNo += 1;
      newNo += 1;
    } else {
      out.push({ text: line, kind, no: null });
    }
  }
  return out;
}

function FileDiff({ text }: { text: string }) {
  const lines = useMemo(() => numberLines(text), [text]);
  return (
    <pre className="m-0 font-mono text-[11px] leading-[1.7]">
      {lines.map((line, i) => (
        // Lines have no identity of their own; the index is the row.
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className={clsx('flex', LINE_CLASS[line.kind])}>
          <span className="w-9 shrink-0 pr-2 text-right opacity-70 select-none">
            {line.no ?? ''}
          </span>
          <span className="flex-1 pr-3 whitespace-pre">{line.text}</span>
        </div>
      ))}
    </pre>
  );
}

/**
 * The Diff tab (W3, ROAD-64): the run's changes against its base ref —
 * file list with status glyph, path and +/−, and the unified diff of the
 * selected file — read through runs:diff, which runs git in the worktree
 * after main has checked it is one of ours. Read when the tab opens,
 * again on Refresh, and again after every committed turn (the parent
 * re-mounts this pane per run). This is the ground truth a person reviews
 * before approving a PR proposal; the transcript is supporting evidence.
 */
export function DiffPane({
  run,
  onFileCount,
}: {
  run: AgentRun;
  onFileCount: (count: number | null) => void;
}) {
  const [diff, setDiff] = useState<RunDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getRunDiff(run.id);
      setDiff(result);
      onFileCount(result.files.length);
      setSelected((current) =>
        current && result.files.some((f) => f.path === current)
          ? current
          : (result.files[0]?.path ?? null),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setDiff(null);
    setSelected(null);
    if (!run.worktreePath) {
      onFileCount(null);
      return;
    }
    load().catch(() => {});
    // Per run; `load` reads the id from `run`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, run.worktreePath]);

  const byFile = useMemo(() => splitPatch(diff?.patch ?? ''), [diff]);

  if (!run.worktreePath) {
    return (
      <div className="p-6 text-xs text-text-secondary">
        {statusView(run.status).live || run.status === 'queued'
          ? 'No worktree yet — the diff appears once the run has one.'
          : 'This run has no worktree to diff.'}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="thin-scroll flex w-[220px] shrink-0 flex-col overflow-y-auto border-r border-border p-1.5">
        <div className="flex items-center justify-between px-1.5 pt-1 pb-1.5 text-[10px] text-text-muted">
          <span className="font-mono">
            {diff
              ? `${diff.files.length} file${diff.files.length === 1 ? '' : 's'}${
                  diff.comparedTo === 'HEAD'
                    ? ' · vs HEAD'
                    : ` · vs ${run.baseRef}`
                }`
              : loading
                ? 'Reading…'
                : ''}
          </span>
          <button
            type="button"
            aria-label="Refresh diff"
            onClick={() => load().catch(() => {})}
            disabled={loading}
            className="flex size-5 items-center justify-center rounded text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
          >
            <IconRefresh size={11} />
          </button>
        </div>
        {error && (
          <div className="mx-1 rounded-[var(--radius-sm)] border border-danger bg-danger-bg px-2 py-1.5 text-[11px] text-danger">
            {error}
          </div>
        )}
        {diff && diff.files.length === 0 && !error && (
          <div className="px-2 py-3 text-[11px] text-text-muted">
            No changes against {run.baseRef ?? 'HEAD'} yet.
          </div>
        )}
        {diff?.files.map((file) => {
          const glyph = GLYPH[file.status];
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => setSelected(file.path)}
              className={clsx(
                'flex w-full items-center gap-1.5 rounded-[5px] px-1.5 py-[5px] text-left text-[11px]',
                selected === file.path ? 'bg-surface-2' : 'hover:bg-bg-inset',
              )}
              title={file.path}
            >
              <span
                className={clsx(
                  'flex size-3 shrink-0 items-center justify-center rounded-[3px] text-[8px] font-extrabold',
                  glyph.className,
                )}
              >
                {glyph.letter}
              </span>
              <span className="min-w-0 flex-1 truncate text-text">
                {file.path}
              </span>
              <span className="flex shrink-0 gap-1 font-mono text-[9.5px]">
                {file.additions > 0 && (
                  <span className="text-success">+{file.additions}</span>
                )}
                {file.deletions > 0 && (
                  <span className="text-danger">−{file.deletions}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div className="thin-scroll min-w-0 flex-1 overflow-auto">
        {diff?.truncated && (
          <div className="border-b border-warning bg-warning-bg px-3 py-1.5 text-[11px] text-warning">
            The patch was cut at 400 kB; the file list is complete.
          </div>
        )}
        {selected && byFile.has(selected) ? (
          <FileDiff text={byFile.get(selected)!} />
        ) : selected ? (
          <div className="p-4 text-xs text-text-muted">
            No text diff for {selected} (binary, or past the cut).
          </div>
        ) : null}
      </div>
    </div>
  );
}
