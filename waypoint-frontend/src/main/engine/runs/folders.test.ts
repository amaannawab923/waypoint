import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createFolderRegistry,
  describeFolder,
  displayPath,
  isGitRepository,
  listSessionFolders,
  MAX_RECENT_FOLDERS,
  readRecents,
  rememberFolder,
  type FolderDeps,
} from './folders';

// The folder handles and recents of W4b (docs/design/w4b-sessions-anywhere.md
// §2): a handle is unforgeable, recents are bounded and pruned, a folder is
// described by what it is on disk and which project links it.

let root: string;
let repo: string;
let plain: string;
let linkedViaSymlink: string;
let recentsFile: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-folders-')));
  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  linkedViaSymlink = path.join(root, 'repo-link');
  fs.symlinkSync(repo, linkedViaSymlink);
  recentsFile = path.join(root, 'recent-folders.json');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function deps(
  projects: Array<{ id: string; name: string; repoPath: string | null }> = [],
): FolderDeps {
  return {
    registry: createFolderRegistry(),
    recentsFile,
    listProjects: async () => projects,
    home: root,
  };
}

beforeEach(() => fs.rmSync(recentsFile, { force: true }));

describe('the handle registry', () => {
  it('mints one handle per path, resolves it, and refuses anything else', () => {
    const registry = createFolderRegistry();
    const h = registry.mint(repo);
    expect(h).toMatch(/^f-[0-9a-f]{24}$/);
    expect(registry.mint(repo)).toBe(h);
    expect(registry.resolve(h)).toBe(repo);
    expect(() => registry.resolve('f-000000000000000000000000')).toThrow(
      /not one this window offered/,
    );
    expect(() => registry.resolve(repo)).toThrow(/not one this window offered/);
    expect(() => registry.resolve(undefined as never)).toThrow(
      /Choose a folder/,
    );
  });
});

describe('displayPath and isGitRepository', () => {
  it('shortens the home directory and knows a .git directory or file', async () => {
    expect(displayPath(path.join(root, 'code', 'x'), root)).toBe('~/code/x');
    expect(displayPath(root, root)).toBe('~');
    expect(displayPath('/opt/other', root)).toBe('/opt/other');
    expect(await isGitRepository(repo)).toBe(true);
    expect(await isGitRepository(plain)).toBe(false);
    const linkedWorktree = path.join(root, 'wt');
    fs.mkdirSync(linkedWorktree);
    fs.writeFileSync(path.join(linkedWorktree, '.git'), 'gitdir: /elsewhere\n');
    expect(await isGitRepository(linkedWorktree)).toBe(true);
  });
});

describe('describeFolder', () => {
  it('describes a repo, a plain folder, and matches a linked project through a symlink', async () => {
    const d = deps([
      { id: 'proj-1', name: 'Waypoint', repoPath: linkedViaSymlink },
    ]);
    const described = await describeFolder(d, repo);
    expect(described).toMatchObject({
      path: repo,
      displayPath: '~/repo',
      name: 'repo',
      kind: 'repo',
      projectId: 'proj-1',
      projectName: 'Waypoint',
      lastAutoApprove: null,
      lastUsedAt: null,
    });
    expect(d.registry.resolve(described!.handle)).toBe(repo);
    expect(await describeFolder(d, plain)).toMatchObject({
      kind: 'folder',
      projectId: null,
    });
    expect(await describeFolder(d, path.join(root, 'nope'))).toBeNull();
    expect(await describeFolder(d, path.join(repo, '.git', 'HEAD'))).toBeNull();
  });
});

describe('recents', () => {
  it('remembers a start at the top with its auto-approve choice, bounded, deduplicated', async () => {
    await rememberFolder(
      recentsFile,
      plain,
      false,
      new Date('2026-09-12T10:00:00Z'),
    );
    await rememberFolder(
      recentsFile,
      repo,
      true,
      new Date('2026-09-12T11:00:00Z'),
    );
    await rememberFolder(
      recentsFile,
      plain,
      true,
      new Date('2026-09-12T12:00:00Z'),
    );
    const recents = await readRecents(recentsFile);
    expect(recents.map((r) => [r.path, r.autoApprove])).toEqual([
      [plain, true],
      [repo, true],
    ]);
    for (let i = 0; i < MAX_RECENT_FOLDERS + 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await rememberFolder(recentsFile, path.join(root, `r${i}`), false);
    }
    expect(await readRecents(recentsFile)).toHaveLength(MAX_RECENT_FOLDERS);
  });

  it('reads nothing from a missing, malformed, or relative-path file', async () => {
    expect(await readRecents(recentsFile)).toEqual([]);
    fs.writeFileSync(recentsFile, '{not json');
    expect(await readRecents(recentsFile)).toEqual([]);
    fs.writeFileSync(
      recentsFile,
      JSON.stringify([{ path: 'relative/x' }, { path: repo }]),
    );
    expect(await readRecents(recentsFile)).toEqual([
      { path: repo, lastUsedAt: new Date(0).toISOString(), autoApprove: false },
    ]);
  });
});

describe('listSessionFolders', () => {
  it('lists recents first (pruned of what is gone), then the linked repositories not already listed, by name', async () => {
    const gone = path.join(root, 'gone');
    fs.mkdirSync(gone);
    await rememberFolder(
      recentsFile,
      gone,
      true,
      new Date('2026-09-12T09:00:00Z'),
    );
    await rememberFolder(
      recentsFile,
      plain,
      false,
      new Date('2026-09-12T10:00:00Z'),
    );
    fs.rmSync(gone, { recursive: true });
    const d = deps([
      { id: 'proj-z', name: 'Zed', repoPath: repo },
      { id: 'proj-a', name: 'Alpha', repoPath: path.join(root, 'alpha') },
      { id: 'proj-n', name: 'None', repoPath: null },
      { id: 'proj-m', name: 'Missing', repoPath: path.join(root, 'missing') },
    ]);
    fs.mkdirSync(path.join(root, 'alpha', '.git'), { recursive: true });

    const listed = await listSessionFolders(d);
    expect(
      listed.map((f) => [f.name, f.kind, f.projectName, f.lastAutoApprove]),
    ).toEqual([
      ['plain', 'folder', null, false],
      ['alpha', 'repo', 'Alpha', null],
      ['repo', 'repo', 'Zed', null],
    ]);
    // A recent that is also a linked repository is listed once, as a recent.
    await rememberFolder(recentsFile, repo, true);
    const again = await listSessionFolders(d);
    expect(again.map((f) => f.name)).toEqual(['repo', 'plain', 'alpha']);
    expect(again[0]).toMatchObject({
      projectName: 'Zed',
      lastAutoApprove: true,
    });
  });
});
