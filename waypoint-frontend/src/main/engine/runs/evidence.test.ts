import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EVIDENCE_NAME,
  MAX_EVIDENCE_FILES,
  collectEvidence,
  evidenceSourceDir,
  listEvidence,
  readEvidence,
} from './evidence';
import { EVIDENCE_DIR } from './sessionBrowser';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let scratch = '';
let worktree = '';
let deps: { evidenceDir: string; logger: { warn: jest.Mock } };
const run = { id: 'run-abc123', worktreePath: '', cwd: null as string | null };

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'waypoint-evidence-'));
  worktree = path.join(scratch, 'wt');
  await fs.mkdir(path.join(worktree, EVIDENCE_DIR), { recursive: true });
  run.worktreePath = worktree;
  deps = {
    evidenceDir: path.join(scratch, 'keep'),
    logger: { warn: jest.fn() },
  };
});
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

async function saved(name: string, bytes: Buffer = PNG): Promise<void> {
  await fs.writeFile(path.join(worktree, EVIDENCE_DIR, name), bytes);
}

describe('evidenceSourceDir', () => {
  it('is .waypoint/evidence under the worktree, else the cwd, else null', () => {
    expect(evidenceSourceDir({ worktreePath: '/w', cwd: '/c' })).toBe(
      path.join('/w', EVIDENCE_DIR),
    );
    expect(evidenceSourceDir({ worktreePath: null, cwd: '/c' })).toBe(
      path.join('/c', EVIDENCE_DIR),
    );
    expect(evidenceSourceDir({ worktreePath: null, cwd: null })).toBeNull();
  });
});

describe('EVIDENCE_NAME', () => {
  it('takes plain image names and nothing that could be a path', () => {
    expect(EVIDENCE_NAME.test('01-before.png')).toBe(true);
    expect(EVIDENCE_NAME.test('after_click.JPG')).toBe(true);
    expect(EVIDENCE_NAME.test('../x.png')).toBe(false);
    expect(EVIDENCE_NAME.test('a/b.png')).toBe(false);
    expect(EVIDENCE_NAME.test('.hidden.png')).toBe(false);
    expect(EVIDENCE_NAME.test('notes.txt')).toBe(false);
    expect(EVIDENCE_NAME.test('x.png.sh')).toBe(false);
  });
});

describe('collectEvidence / listEvidence', () => {
  it('copies the images the session saved into the keep, in name order, skipping what is not an image', async () => {
    await saved('02-after.png');
    await saved('01-before.png');
    await saved('notes.txt', Buffer.from('not an image'));
    await fs.mkdir(path.join(worktree, EVIDENCE_DIR, 'sub.png'));

    const items = await listEvidence(deps, run);
    expect(items.map((i) => i.name)).toEqual(['01-before.png', '02-after.png']);
    expect(items[0].bytes).toBe(PNG.length);
    await expect(
      fs.stat(path.join(deps.evidenceDir, run.id, '01-before.png')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(deps.evidenceDir, run.id, 'notes.txt')),
    ).rejects.toBeTruthy();
  });

  it('is what the keep holds once the worktree is gone', async () => {
    await saved('01.png');
    await collectEvidence(deps, run);
    await fs.rm(worktree, { recursive: true, force: true });
    expect((await listEvidence(deps, run)).map((i) => i.name)).toEqual([
      '01.png',
    ]);
  });

  it('is empty, not an error, for a run with no evidence folder or no directory at all', async () => {
    await fs.rm(path.join(worktree, EVIDENCE_DIR), { recursive: true });
    expect(await listEvidence(deps, run)).toEqual([]);
    expect(
      await listEvidence(deps, {
        id: 'run-none',
        worktreePath: null,
        cwd: null,
      }),
    ).toEqual([]);
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('re-copies a file the session overwrote, and caps the count', async () => {
    await saved('01.png');
    await collectEvidence(deps, run);
    const bigger = Buffer.concat([PNG, Buffer.from([0])]);
    await saved('01.png', bigger);
    const items = await listEvidence(deps, run);
    expect(items[0].bytes).toBe(bigger.length);

    await Promise.all(
      Array.from({ length: MAX_EVIDENCE_FILES + 5 }, (_, i) =>
        saved(`s-${String(i).padStart(3, '0')}.png`),
      ),
    );
    expect((await listEvidence(deps, run)).length).toBe(MAX_EVIDENCE_FILES);
  });

  it('refuses a run id that is not one', async () => {
    await expect(
      listEvidence(deps, { id: '../etc', worktreePath: null, cwd: null }),
    ).rejects.toThrow();
  });
});

describe('readEvidence', () => {
  it('answers a kept file as a data URL, and refuses anything else', async () => {
    await saved('01.png');
    await collectEvidence(deps, run);
    const file = await readEvidence(deps, run.id, '01.png');
    expect(file.name).toBe('01.png');
    expect(file.dataUrl).toBe(
      `data:image/png;base64,${PNG.toString('base64')}`,
    );
    await expect(readEvidence(deps, run.id, '../01.png')).rejects.toThrow(
      'Not an evidence file.',
    );
    await expect(readEvidence(deps, run.id, 'missing.png')).rejects.toThrow();
  });
});
