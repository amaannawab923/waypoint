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
 * see docs/design/RENAME-STATE.md for which commits have landed. As of C3 the
 * bans are the old `mock/` import path, the ticket cluster, and the
 * sprints/workstreams/requests/docs/scratchpad cluster. Do not add a ban ahead
 * of the commit that makes it true; the point of the tripwire is that it is
 * green exactly when the tree is consistent.
 *
 * A ban may carry `allowed` literals: strings that contain the banned pattern
 * and are legitimately still in the tree. There are two kinds, and each entry
 * says which it is:
 *
 *   - **Dated** — the literal belongs to a cluster a *later* commit owns.
 *     It names that commit, and deleting the allowance is part of it.
 *   - **Permanent** — the literal is a third-party identifier that merely
 *     contains the banned string (a library export, a test-runner API). It
 *     names its owner. Without these the ban would silently forbid writing a
 *     real API's name, which is a rule nobody would guess from a failure.
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
  /**
   * Literals that contain `pattern` but are legitimately still in the tree.
   * Removed from a line before the line is tested. Each entry names either
   * the commit that deletes it or the third party that owns it.
   */
  allowed?: string[];
};

/**
 * Every pattern and allowance below is assembled from fragments, so that
 * grepping the tree for a banned identifier — the check each commit is
 * verified by, and that later commits re-run — comes back genuinely empty
 * rather than matching this file's own source. No fragment may itself contain
 * a banned string.
 */
const BANS: Ban[] = [
  {
    pattern: `@/${'mock'}`,
    reason:
      "C1 renamed src/renderer/mock/ to src/renderer/data/. Import from '@/data/…' instead.",
  },
  {
    pattern: `Work${'Item'}`,
    reason:
      'C2 renamed the work-item entity to Ticket. Use Ticket, TicketState, TicketFilters, … instead.',
  },
  {
    pattern: `work${'_item'}`,
    reason:
      'C2 renamed the work-item entity to ticket. Use ticket_id, ticket_states, … instead.',
  },
  {
    pattern: `work${'-items'}`,
    reason:
      "C2 renamed the ticket list's route segment and its pages/ directory. Use '/tickets' and '@/pages/tickets/…' instead.",
  },
  {
    pattern: `${'Cyc'}le`,
    reason:
      'C3 renamed the cycle entity to Sprint. Use Sprint, listSprints, SprintsPage, /sprints, … instead.',
  },
  {
    pattern: `${'Mod'}ule`,
    reason:
      'C3 renamed the work-module entity to Workstream. Use Workstream, listWorkstreams, WorkstreamsPage, /workstreams, … instead.',
    allowed: [
      // Permanent — Jest's own API, named in a comment that explains why
      // AppShell's flag-disabled case needs its own file. Not the entity.
      `jest.reset${'Mod'}ules`,
    ],
  },
  {
    pattern: `${'Int'}ake`,
    reason:
      'C3 renamed the intake entity to Request. Use Request, listRequests, RequestsPage, /requests, … instead.',
  },
  {
    pattern: `${'Stic'}ky`,
    reason:
      'C3 renamed the sticky entity to ScratchNote, and the page to Scratchpad. Use ScratchNote, listScratchNotes, /scratchpad, … instead.',
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

/** The line as the ban sees it: allowed literals removed, everything else intact. */
function withoutAllowances(line: string, ban: Ban): string {
  return (ban.allowed ?? []).reduce(
    (rest, allowance) => rest.split(allowance).join(''),
    line,
  );
}

function findHits(ban: Ban): string[] {
  return collectFiles(RENDERER_ROOT)
    .filter((file) => !EXEMPT_FILES.has(file))
    .flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          withoutAllowances(line, ban).includes(ban.pattern)
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
