#!/usr/bin/env node
// Fetches the pinned agent-engine archive named in engine.lock.json into
// ./engine/ (gitignored), verifying its sha256 before it is allowed to exist
// there. Run by `npm run engine:fetch`, and by `postinstall` so a fresh clone
// has the engine available to `npm start` and to electron-builder's
// extraResources without anyone remembering a step.
//
// Why a script and not a checked-in file: the archive is ~62 MB of a bundled
// Node runtime plus compiled native modules. That belongs in a release
// asset pinned by hash, not in git history.
//
// Why `gh` and not a bare HTTPS download: the waypoint repo is private, so
// the asset URL needs auth, and `gh` is the auth the founder (and CI) already
// have. `WAYPOINT_ENGINE_ARCHIVE=/path/to/file.tar.gz` bypasses the download
// for an archive built locally (the way the pinned one was, from emdash
// source) — still hash-checked, because a wrong local build is the exact
// thing the pin exists to catch.
//
// This script never fails `npm install`. Apple Silicon only in this release
// (ROAD-46/ROAD-101): on any other platform, and on a machine that cannot
// reach the release (no `gh`, not logged in, offline), it prints what is
// missing and exits 0 — the app then reports the engine as "not installed",
// which is the truth, while everything that is not the engine keeps working.
// The one thing that DOES fail is a downloaded or supplied archive whose
// sha256 is not the pinned one: that is never allowed to exist in ./engine/.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'engine.lock.json'), 'utf8'));
const targetId = `${process.platform}-${process.arch}`;
const target = lock.targets[targetId];
const outDir = join(root, 'engine');

if (!target) {
  console.log(
    `[engine] no pinned ${lock.name} build for ${targetId} (have: ${Object.keys(lock.targets).join(', ')}). ` +
      'Skipping; the agent engine will report "not installed" on this machine.',
  );
  process.exit(0);
}

const dest = join(outDir, target.file);
mkdirSync(outDir, { recursive: true });

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

if (existsSync(dest) && sha256(dest) === target.sha256) {
  console.log(`[engine] ${target.file} already present and verified.`);
  process.exit(0);
}

const tmp = `${dest}.download`;
if (existsSync(tmp)) unlinkSync(tmp);

const local = process.env.WAYPOINT_ENGINE_ARCHIVE;
if (local) {
  console.log(`[engine] copying ${local}`);
  copyFileSync(local, tmp);
} else {
  const tag = target.release.split('/').pop();
  console.log(`[engine] downloading ${target.file} from release ${tag} …`);
  // `gh release download` writes into --dir under the asset's own name.
  // Found in review (H2): this ran inside postinstall with no guard, so a
  // machine without `gh`, or with `gh` not logged in (CI without
  // GH_TOKEN), failed the whole `npm install` with a stack trace. The
  // engine being absent is a *status* the app can show ("not installed");
  // it must never be a reason `npm install` cannot finish.
  try {
    // Straight into the `.download` name, never the bundled name: an
    // interrupted download must not leave an unverified file where
    // electron-builder would pick it up (review round 2). The runtime
    // installer would still refuse it by hash, but a broken engine in a
    // packaged app is a worse day than a failed fetch.
    execFileSync(
      'gh',
      [
        'release',
        'download',
        tag,
        '--repo',
        'amaannawab923/waypoint',
        '--pattern',
        target.file,
        '--output',
        tmp,
        '--clobber',
      ],
      { stdio: ['ignore', 'inherit', 'pipe'] },
    );
  } catch (err) {
    const detail =
      err && err.stderr
        ? String(err.stderr).trim().split('\n').slice(-2).join(' ')
        : err && err.code === 'ENOENT'
          ? '`gh` is not installed'
          : String(err);
    console.log(
      `[engine] could not download ${target.file}: ${detail}\n` +
        '[engine] Skipping — the agent engine will report "not installed" until you run `npm run engine:fetch` ' +
        'with `gh auth login` done (or set WAYPOINT_ENGINE_ARCHIVE to a local build).',
    );
    process.exit(0);
  }
}

const actual = sha256(tmp);
if (actual !== target.sha256) {
  unlinkSync(tmp);
  console.error(
    `[engine] sha256 mismatch for ${target.file}\n  expected ${target.sha256}\n  actual   ${actual}\nRefusing to keep it.`,
  );
  process.exit(1);
}
renameSync(tmp, dest);
console.log(
  `[engine] ${target.file} verified (${target.sha256.slice(0, 12)}…) → ${dest}`,
);
