import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { ValidationError } from '../middleware/errors.js';

// Same Drizzle-shaped fake as copilot.service.test.ts — this file's subject
// is validateRepoPath (real filesystem, real temp dirs) plus the ORDER
// updateProject does things in, neither of which needs a real database.
function chainable(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ['from', 'where', 'set', 'values'];
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  chain.returning = vi.fn(() => Promise.resolve(resolvedValue));
  chain.then = (resolve: (value: unknown) => void) => resolve(resolvedValue);
  return chain;
}

const { db } = vi.hoisted(() => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../db/client.js', () => ({ db }));

const { validateRepoPath, updateProject } = await import('./projects.service.js');

// One temp root for the whole file, cleaned up at the end — each case gets
// its own subdirectory so a failing case can't leak state into another.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-repo-path-'));
let caseCounter = 0;
function makeDir(): string {
  caseCounter += 1;
  const dir = path.join(tmpRoot, `case-${caseCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const PROJECT_ROW = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Launch',
  identifier: 'LAUNCH',
  description: '',
  icon: '📦',
  coverGradientStart: '#c2542a',
  coverGradientEnd: '#3a2314',
  visibility: 'public',
  leadId: null,
  defaultAssigneeId: null,
  timezone: 'UTC',
  estimate: null,
  automations: {},
  createdAt: new Date(),
  archivedAt: null,
  guestAccessEnabled: false,
  acceptsRequests: false,
  repoPath: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.update.mockReturnValue(chainable([PROJECT_ROW]));
  db.select.mockReturnValue(chainable([]));
});

describe('validateRepoPath', () => {
  it('accepts a directory containing a .git directory (an ordinary checkout)', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, '.git'));
    expect(() => validateRepoPath(dir)).not.toThrow();
  });

  // A git worktree's ".git" is a pointer FILE, not a directory — checking
  // for a directory specifically would reject every worktree.
  it('accepts a directory whose .git is a file (a git worktree)', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    expect(() => validateRepoPath(dir)).not.toThrow();
  });

  it('rejects a path that does not exist', () => {
    const dir = path.join(tmpRoot, 'definitely-not-here');
    expect(() => validateRepoPath(dir)).toThrow(ValidationError);
    expect(() => validateRepoPath(dir)).toThrow(/does not exist/);
  });

  it('rejects a path that is a file, not a directory', () => {
    const dir = makeDir();
    const file = path.join(dir, 'README.md');
    fs.writeFileSync(file, '# hi\n');
    expect(() => validateRepoPath(file)).toThrow(ValidationError);
    expect(() => validateRepoPath(file)).toThrow(/is not a directory/);
  });

  it('rejects a real directory with no .git at all', () => {
    const dir = makeDir();
    expect(() => validateRepoPath(dir)).toThrow(ValidationError);
    expect(() => validateRepoPath(dir)).toThrow(/is not a git repository/);
  });
});

describe('updateProject repoPath validation', () => {
  it('rejects an invalid repoPath before any write reaches the database', async () => {
    const dir = makeDir();

    await expect(updateProject('proj-1', { repoPath: dir })).rejects.toThrow(ValidationError);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('writes a valid repoPath through', async () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, '.git'));

    await updateProject('proj-1', { repoPath: dir });

    expect(db.update).toHaveBeenCalledTimes(1);
    const setCall = db.update.mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith({ repoPath: dir });
  });

  // Unlinking must work even when the checkout is long gone — that's often
  // exactly why the user is unlinking.
  it('skips validation entirely for an explicit null, so a deleted checkout can still be unlinked', async () => {
    await updateProject('proj-1', { repoPath: null });

    expect(db.update).toHaveBeenCalledTimes(1);
    const setCall = db.update.mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith({ repoPath: null });
  });

  it('leaves patches that do not mention repoPath alone', async () => {
    await updateProject('proj-1', { name: 'Renamed' });

    expect(db.update).toHaveBeenCalledTimes(1);
  });
});
