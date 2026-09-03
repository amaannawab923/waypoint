import fs from 'fs';
import path from 'path';

/**
 * Vocabulary tripwire.
 *
 * The rename from Waypoint's old vocabulary to its new one (docs/design/
 * waypoint-revamp-architecture.md §6) lands as five sequential commits, C1-C5.
 * A partial rename is worse than no rename: a half-renamed tree still compiles
 * and still passes every other test, so a session that stops mid-cluster leaves
 * something that looks finished and is not.
 *
 * This test makes that state mechanically impossible to miss. It greps the
 * whole renderer tree for identifiers that a landed commit has abolished and
 * fails the suite on any hit, so a stalled rename shows up as a red build
 * rather than as a plausible-looking half-rename.
 *
 * Bans are added cluster by cluster, in the same commit that abolishes them —
 * see docs/design/RENAME-STATE.md for which commits have landed. As of C1 the
 * only ban is the old `mock/` import path. C2 adds the work-item cluster, C3
 * the cycles/modules/intake/pages/stickies cluster. Do not add a ban ahead of
 * the commit that makes it true; the point of the tripwire is that it is green
 * exactly when the tree is consistent.
 */

const RENDERER_ROOT = path.resolve(__dirname, '..');

/** Directories never worth scanning, at any depth. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

/** Only text we actually author; binaries and assets are not vocabulary. */
const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.scss',
  '.json',
  '.md',
  '.html',
]);

/**
 * Files exempt from every ban. This file necessarily contains the banned
 * strings — they are its subject matter — so it cannot scan itself.
 */
const EXEMPT_FILES = new Set([__filename]);

type Ban = {
  /** The literal string no file may contain. */
  pattern: string;
  /** Shown on failure: what to do instead. */
  reason: string;
};

const BANS: Ban[] = [
  {
    // Assembled from fragments so that grepping the tree for the banned import
    // prefix — the check C1 is verified by, and that later commits will re-run
    // — comes back genuinely empty rather than matching this file's own source.
    pattern: `@/${'mock'}`,
    reason:
      "C1 renamed src/renderer/mock/ to src/renderer/data/. Import from '@/data/…' instead.",
  },
];

function collectFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : collectFiles(fullPath);
    }
    const scanned =
      entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name));
    return scanned ? [fullPath] : [];
  });
}

function findHits(ban: Ban): string[] {
  return collectFiles(RENDERER_ROOT)
    .filter((file) => !EXEMPT_FILES.has(file))
    .flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          line.includes(ban.pattern)
            ? [
                `${path.relative(RENDERER_ROOT, file)}:${index + 1}: ${line.trim()}`,
              ]
            : [],
        ),
    );
}

describe('vocabulary tripwire', () => {
  it('scans a non-trivial number of renderer files', () => {
    // Guards against the tripwire silently passing because the walk broke —
    // a green suite must mean "no hits", not "nothing was looked at".
    expect(collectFiles(RENDERER_ROOT).length).toBeGreaterThan(50);
  });

  it.each(BANS.map((ban) => [ban.pattern, ban] as const))(
    'finds no occurrence of %s in the renderer',
    (_pattern, ban) => {
      const hits = findHits(ban);
      expect(
        hits.length === 0
          ? ''
          : `${ban.reason}\n\n${hits.length} occurrence(s):\n${hits.join('\n')}`,
      ).toBe('');
    },
  );
});
