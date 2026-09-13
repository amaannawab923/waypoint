import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionFolder } from '../types';
import type { LedgerProject } from './ledgerClient';

/**
 * The folders a session may be started in — W4b, ROAD-116
 * (docs/design/w4b-sessions-anywhere.md §2).
 *
 * The renderer never names a path. A folder reaches `runs:start` as a
 * handle main minted from one of two sources: the OS folder picker, or
 * main's own recents plus the projects' linked repositories. A handle is
 * a random id valid for this process; an unknown one is refused. The
 * reason is the same W3's review gave the diff and reveal channels: the
 * renderer shows markdown an agent wrote, and a renderer that can name a
 * path is a renderer that can point an agent with auto-approve at `~`.
 *
 * Recents are main's file (`recent-folders.json` beside the engine),
 * bounded, pruned of paths that no longer exist on read, and carry the
 * auto-approve choice each folder was last started with — the per-folder
 * memory the founder asked for, so turning it on for a scratch repo never
 * turns it on for the real one.
 */

export const MAX_RECENT_FOLDERS = 20;

export interface RecentFolder {
  path: string;
  lastUsedAt: string;
  autoApprove: boolean;
}

export interface FolderRegistry {
  /** Mints a handle for a canonical path (idempotent per path within the process). */
  mint(canonicalPath: string): string;
  /** The path a handle stands for; throws for a handle this process never minted. */
  resolve(handle: string): string;
}

export function createFolderRegistry(): FolderRegistry {
  const byHandle = new Map<string, string>();
  const byPath = new Map<string, string>();
  return {
    mint(canonicalPath) {
      const existing = byPath.get(canonicalPath);
      if (existing) return existing;
      const handle = `f-${randomBytes(12).toString('hex')}`;
      byHandle.set(handle, canonicalPath);
      byPath.set(canonicalPath, handle);
      return handle;
    },
    resolve(handle) {
      if (typeof handle !== 'string') throw new Error('Choose a folder.');
      const resolved = byHandle.get(handle);
      if (!resolved) {
        throw new Error(
          'That folder is not one this window offered. Pick it again.',
        );
      }
      return resolved;
    },
  };
}

/** `/Users/me/code/x` → `~/code/x`; anything else unchanged. */
export function displayPath(absolute: string, home = os.homedir()): string {
  const rel = path.relative(home, absolute);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${rel}`;
  return absolute;
}

/** A git repository is a folder with a `.git` — a directory, or the file a linked worktree carries. */
export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(path.join(dir, '.git'));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

async function realDirectory(candidate: string): Promise<string | null> {
  try {
    const real = await fs.realpath(candidate);
    const stat = await fs.stat(real);
    return stat.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export interface FolderDeps {
  registry: FolderRegistry;
  /** The recents file's absolute path. */
  recentsFile: string;
  /** Every project, for the linked-repository match. */
  listProjects: () => Promise<LedgerProject[]>;
  home?: string;
}

export async function readRecents(file: string): Promise<RecentFolder[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RecentFolder[] = [];
  for (const item of parsed) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as RecentFolder).path === 'string' &&
      path.isAbsolute((item as RecentFolder).path)
    ) {
      const r = item as Partial<RecentFolder>;
      out.push({
        path: r.path as string,
        lastUsedAt:
          typeof r.lastUsedAt === 'string'
            ? r.lastUsedAt
            : new Date(0).toISOString(),
        autoApprove: r.autoApprove === true,
      });
    }
  }
  return out;
}

async function writeRecents(
  file: string,
  recents: RecentFolder[],
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(recents, null, 2)}\n`);
}

/** Records a start: the folder goes to the top with its auto-approve choice. */
export async function rememberFolder(
  file: string,
  canonicalPath: string,
  autoApprove: boolean,
  now = new Date(),
): Promise<void> {
  const rest = (await readRecents(file)).filter(
    (r) => r.path !== canonicalPath,
  );
  const next: RecentFolder[] = [
    { path: canonicalPath, lastUsedAt: now.toISOString(), autoApprove },
    ...rest,
  ].slice(0, MAX_RECENT_FOLDERS);
  await writeRecents(file, next);
}

/**
 * Describes one folder the way the dialog shows it. Null when the path is
 * not a directory on this machine (a recent that moved, a link from
 * another machine).
 */
export async function describeFolder(
  deps: FolderDeps,
  candidate: string,
  extra: { recent?: RecentFolder; projects?: LedgerProject[] } = {},
): Promise<SessionFolder | null> {
  const real = await realDirectory(candidate);
  if (!real) return null;
  const projects = extra.projects ?? (await deps.listProjects());
  let project: LedgerProject | null = null;
  for (const p of projects) {
    if (!p.repoPath) continue;
    // eslint-disable-next-line no-await-in-loop -- a handful of projects, each a realpath
    const linked = await realDirectory(p.repoPath);
    if (linked === real) {
      project = p;
      break;
    }
  }
  return {
    handle: deps.registry.mint(real),
    path: real,
    displayPath: displayPath(real, deps.home),
    name: path.basename(real),
    kind: (await isGitRepository(real)) ? 'repo' : 'folder',
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    lastAutoApprove: extra.recent ? extra.recent.autoApprove : null,
    lastUsedAt: extra.recent ? extra.recent.lastUsedAt : null,
  };
}

/**
 * What the dialog lists: recents (most recent first, pruned of what is
 * gone) and then every project's linked repository that is not already
 * among them, by name.
 */
export async function listSessionFolders(
  deps: FolderDeps,
): Promise<SessionFolder[]> {
  const projects = await deps.listProjects();
  const recents = await readRecents(deps.recentsFile);
  const out: SessionFolder[] = [];
  const seen = new Set<string>();
  for (const recent of recents) {
    // eslint-disable-next-line no-await-in-loop -- bounded by MAX_RECENT_FOLDERS
    const described = await describeFolder(deps, recent.path, {
      recent,
      projects,
    });
    if (!described || seen.has(described.path)) continue;
    seen.add(described.path);
    out.push(described);
  }
  const linked: SessionFolder[] = [];
  for (const p of projects) {
    if (!p.repoPath) continue;
    // eslint-disable-next-line no-await-in-loop -- a handful of projects
    const described = await describeFolder(deps, p.repoPath, { projects });
    if (!described || seen.has(described.path)) continue;
    seen.add(described.path);
    linked.push(described);
  }
  linked.sort((a, b) => a.name.localeCompare(b.name));
  return [...out, ...linked];
}
