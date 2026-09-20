import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AgentRun } from './ledgerClient';
import { assertRunId } from './ledgerClient';
import { EVIDENCE_DIR } from './sessionBrowser';

/**
 * A run's evidence — the screenshots a session saved while verifying its
 * change in the isolated browser (sessionBrowser.ts, briefs.ts's
 * verification task). Two homes:
 *
 *  - `<worktree>/.waypoint/evidence/` is where the session WRITES (a
 *    relative path the brief can name before the run has an id);
 *    git-excluded by worktrees.ts.
 *  - `<userData>/run-evidence/<runId>/` is where Waypoint KEEPS a copy —
 *    a worktree is removed once its PR merges (worktrees.ts
 *    releaseWorktree); the proof must outlive it.
 *
 * `collect` copies the first into the second, and runs at both moments
 * that matter: when finalize reads the closing message, and whenever the
 * renderer asks for the list (so a run still working shows what it has
 * so far, and a run whose worktree is already gone still lists what was
 * copied). Only image files with plain names are taken — the folder is
 * written by an agent with a shell, and a name is the one thing that
 * turns into a path here.
 */
export interface EvidenceItem {
  name: string;
  bytes: number;
  /** ISO time the file was last written, as the session left it. */
  modifiedAt: string;
}

export interface EvidenceDeps {
  /** EnginePaths.evidenceDir — `<userData>/run-evidence`. */
  evidenceDir: string;
  logger: {
    warn: (m: string, meta?: Record<string, unknown>) => void;
  };
}

/** A screenshot's file name: one plain segment, an image extension. */
export const EVIDENCE_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(png|jpe?g|webp)$/i;
/** The most files kept per run, and the largest single file. */
export const MAX_EVIDENCE_FILES = 40;
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function keptDir(deps: EvidenceDeps, runId: string): string {
  assertRunId(runId);
  return path.join(deps.evidenceDir, runId);
}

/** Where the session writes, for a run with a working directory; null otherwise. */
export function evidenceSourceDir(
  run: Pick<AgentRun, 'worktreePath' | 'cwd'>,
): string | null {
  const root = run.worktreePath ?? run.cwd;
  return root ? path.join(root, EVIDENCE_DIR) : null;
}

async function listImages(dir: string): Promise<EvidenceItem[]> {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  const stats = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && EVIDENCE_NAME.test(entry.name))
      .map(async (entry) => ({
        name: entry.name,
        stat: await fs.stat(path.join(dir, entry.name)).catch(() => null),
      })),
  );
  // Name order is the session's own numbering (01-…, 02-…).
  return stats
    .filter(
      (
        s,
      ): s is {
        name: string;
        stat: NonNullable<(typeof stats)[number]['stat']>;
      } => !!s.stat && s.stat.size > 0 && s.stat.size <= MAX_EVIDENCE_BYTES,
    )
    .map(({ name, stat }) => ({
      name,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_EVIDENCE_FILES);
}

/**
 * Copies the run's current evidence into Waypoint's keep. Idempotent —
 * a file already kept with the same size and mtime is skipped — and
 * never throws: a missing source dir is the normal "nothing verified"
 * case, a copy failure is a warning.
 */
export async function collectEvidence(
  deps: EvidenceDeps,
  run: Pick<AgentRun, 'id' | 'worktreePath' | 'cwd'>,
): Promise<EvidenceItem[]> {
  const source = evidenceSourceDir(run);
  if (!source) return [];
  const items = await listImages(source);
  if (!items.length) return [];
  const target = keptDir(deps, run.id);
  await fs.mkdir(target, { recursive: true });
  await Promise.all(
    items.map(async (item) => {
      const to = path.join(target, item.name);
      const kept = await fs.stat(to).catch(() => null);
      if (
        kept &&
        kept.size === item.bytes &&
        kept.mtime.toISOString() === item.modifiedAt
      )
        return;
      try {
        await fs.copyFile(path.join(source, item.name), to);
        const at = new Date(item.modifiedAt);
        await fs.utimes(to, at, at);
      } catch (error) {
        deps.logger.warn('engine: evidence file not copied', {
          runId: run.id,
          name: item.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  return items;
}

/** What Waypoint keeps for the run, after collecting whatever is new. */
export async function listEvidence(
  deps: EvidenceDeps,
  run: Pick<AgentRun, 'id' | 'worktreePath' | 'cwd'>,
): Promise<EvidenceItem[]> {
  await collectEvidence(deps, run);
  return listImages(keptDir(deps, run.id));
}

/** One kept file as a data URL, for an <img> in the renderer. */
export async function readEvidence(
  deps: EvidenceDeps,
  runId: string,
  name: string,
): Promise<{ name: string; dataUrl: string }> {
  if (!EVIDENCE_NAME.test(name)) throw new Error('Not an evidence file.');
  const file = path.join(keptDir(deps, runId), name);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES)
    throw new Error('Not an evidence file.');
  const mime = MIME[path.extname(name).toLowerCase()] ?? 'image/png';
  const bytes = await fs.readFile(file);
  return { name, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
}
