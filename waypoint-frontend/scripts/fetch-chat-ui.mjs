#!/usr/bin/env node
// Fetches the pinned emdash chat-ui build named in chat-ui.lock.json and
// extracts it into ./vendor/emdash-chat-ui/ (gitignored), verifying its
// sha256 before a byte of it is allowed to exist there. Run by
// `npm run chat-ui:fetch`, and by `postinstall` so a fresh clone can build
// the renderer without anyone remembering a step — ROAD-59.
//
// Same posture as fetch-engine.mjs, for the same reasons: the build is 5 MB
// of bundled JS, CSS and fonts that belongs in a release asset pinned by
// hash, not in git history; `gh` is the auth this private repo's release
// needs; `WAYPOINT_CHAT_UI_ARCHIVE=/path/to/file.tar.gz` bypasses the
// download for an archive built locally (still hash-checked).
//
// This script never fails `npm install`. A machine that cannot reach the
// release (no `gh`, not logged in, offline) is told what is missing and
// exits 0 — the renderer build then fails at the first `@emdash/chat-ui`
// import with a resolution error naming this script, which is the truth.
// The one thing that DOES fail is an archive whose sha256 is not the
// pinned one: that is never allowed to exist in ./vendor/.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'chat-ui.lock.json'), 'utf8'));
const vendorDir = join(root, 'vendor');
const installDir = join(vendorDir, 'emdash-chat-ui');
const stampPath = join(installDir, '.sha256');

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// Already extracted from exactly this archive: nothing to do. The stamp is
// written last, after a verified extraction, so a half-extracted tree
// never carries one.
if (
  existsSync(stampPath) &&
  readFileSync(stampPath, 'utf8').trim() === lock.sha256
) {
  console.log(`[chat-ui] ${lock.file} already extracted and verified.`);
  process.exit(0);
}

mkdirSync(vendorDir, { recursive: true });
const tmp = join(vendorDir, `${lock.file}.download`);
if (existsSync(tmp)) unlinkSync(tmp);

const local = process.env.WAYPOINT_CHAT_UI_ARCHIVE;
if (local) {
  console.log(`[chat-ui] copying ${local}`);
  copyFileSync(local, tmp);
} else {
  const tag = lock.release.split('/').pop();
  console.log(`[chat-ui] downloading ${lock.file} from release ${tag} …`);
  try {
    execFileSync(
      'gh',
      [
        'release',
        'download',
        tag,
        '--repo',
        'amaannawab923/waypoint',
        '--pattern',
        lock.file,
        '--dir',
        vendorDir,
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
      `[chat-ui] could not download ${lock.file}: ${detail}\n` +
        '[chat-ui] Skipping — the renderer will not build until you run `npm run chat-ui:fetch` ' +
        'with `gh auth login` done (or set WAYPOINT_CHAT_UI_ARCHIVE to a local build).',
    );
    process.exit(0);
  }
  renameSync(join(vendorDir, lock.file), tmp);
}

const actual = sha256(tmp);
if (actual !== lock.sha256) {
  unlinkSync(tmp);
  console.error(
    `[chat-ui] sha256 mismatch for ${lock.file}\n  expected ${lock.sha256}\n  actual   ${actual}\nRefusing to keep it.`,
  );
  process.exit(1);
}

// Fresh directory every time: a previous version's files must not shadow
// this one's. The archive's single top-level directory is emdash-chat-ui/.
rmSync(installDir, { recursive: true, force: true });
execFileSync('/usr/bin/tar', ['-xzf', tmp, '-C', vendorDir]);
unlinkSync(tmp);
if (
  !existsSync(
    join(
      installDir,
      lock.name === 'emdash-chat-ui' ? 'chat-ui/dist/index.js' : '',
    ),
  )
) {
  console.error(
    `[chat-ui] ${lock.file} did not contain emdash-chat-ui/chat-ui/dist/index.js; refusing to keep it.`,
  );
  rmSync(installDir, { recursive: true, force: true });
  process.exit(1);
}
writeFileSync(stampPath, `${lock.sha256}\n`);
console.log(
  `[chat-ui] ${lock.file} verified (${lock.sha256.slice(0, 12)}…) → ${installDir}`,
);
