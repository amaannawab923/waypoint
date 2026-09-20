#!/usr/bin/env node
// Assembles the emdash-chat-ui archive Waypoint pins (chat-ui.lock.json)
// from a built emdash checkout — the layout fetch-chat-ui.mjs expects and
// the first archive (2026-09-12) was assembled by hand into:
//
//   emdash-chat-ui/
//     manifest.json, LICENSE.md, NOTICE
//     chat-ui/package.json, chat-ui/dist/**        (the built package)
//     core-types/*.d.mts                            (@emdash/core's acp client types + chunks)
//     shared-types/*.d.mts                          (@emdash/shared's index + markdown types + chunks)
//
// Since the fork (2026-09-20) emdash is built from Waypoint's own branch of
// it, so this runs every time that branch moves. It does NOT run the
// builds — `pnpm --filter @emdash/shared --filter @emdash/core --filter
// @emdash/chat-ui build` in the checkout first, so what gets archived is
// exactly what was tested. Prints the archive path and its sha256; the
// lock file is updated by hand from those (the sha256 is the pin).
//
//   node scripts/build-chat-ui-archive.mjs --emdash ../../emdash [--out ./dist-chat-ui]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const emdash = resolve(opt('--emdash', resolve(here, '../../../emdash')));
const outDir = resolve(opt('--out', resolve(here, '../dist-chat-ui')));

const chatUi = join(emdash, 'packages/chat-ui');
const coreDist = join(emdash, 'packages/core/dist');
const sharedDist = join(emdash, 'packages/shared/dist');
for (const must of [
  join(chatUi, 'dist/index.js'),
  join(chatUi, 'dist/src/index.d.ts'),
  join(coreDist, 'runtimes-acp-api-client.d.mts'),
  join(sharedDist, 'index.d.mts'),
  join(sharedDist, 'markdown.d.mts'),
]) {
  if (!existsSync(must)) {
    console.error(
      `[chat-ui] missing ${must} — build @emdash/shared, @emdash/core and @emdash/chat-ui first.`,
    );
    process.exit(1);
  }
}

const git = (...a) =>
  execFileSync('git', ['-C', emdash, ...a], { encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
const short = commit.slice(0, 9);
const repo = git('remote', 'get-url', 'origin').replace(/\.git$/, '');
if (
  git(
    'status',
    '--porcelain',
    '--',
    'packages/chat-ui/src',
    'packages/core/src',
    'packages/shared/src',
  )
) {
  console.error(
    '[chat-ui] the emdash checkout has uncommitted changes under the packages this archives; commit them first so sourceCommit means what it says.',
  );
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(join(chatUi, 'package.json'), 'utf8'));

// A .d.mts and, transitively, every sibling chunk it imports (`./x.mjs` →
// `x.d.mts`) — the hashed chunk names change on every build.
function collectTypes(distDir, entry, into) {
  if (into.has(entry)) return;
  into.add(entry);
  const text = readFileSync(join(distDir, entry), 'utf8');
  for (const m of text.matchAll(/from\s*["']\.\/([^"']+)\.mjs["']/g)) {
    collectTypes(distDir, `${m[1]}.d.mts`, into);
  }
}

const stage = mkdtempSync(join(tmpdir(), 'waypoint-chat-ui-'));
const root = join(stage, 'emdash-chat-ui');
mkdirSync(join(root, 'chat-ui'), { recursive: true });
cpSync(join(chatUi, 'dist'), join(root, 'chat-ui/dist'), { recursive: true });
// The package.json the vendored copy carries — Waypoint's own, not the
// workspace's: `main` for the bundler, `types` for TypeScript, solid-js
// as the one peer. No "type": "module" ON PURPOSE (found the hard way on
// the first fork build): the emitted .d.ts files use extensionless
// relative imports, which TypeScript only accepts under CommonJS
// resolution — with it, every Waypoint import of the package fails with
// TS1479/TS1541.
const solid =
  pkg.peerDependencies?.['solid-js'] ??
  pkg.dependencies?.['solid-js'] ??
  pkg.devDependencies?.['solid-js'] ??
  '';
writeFileSync(
  join(root, 'chat-ui/package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: `Build of @emdash/chat-ui at ${repo} ${short} — see ../NOTICE. Added by Waypoint's vendoring so the folder resolves as a package: \`main\` for the bundler, \`types\` for TypeScript. No "type": "module" on purpose: the emitted .d.ts files use extensionless relative imports, which TypeScript only accepts under CommonJS resolution.`,
      license: 'Apache-2.0',
      main: 'dist/index.js',
      types: 'dist/src/index.d.ts',
      sideEffects: ['dist/style.css', 'dist/index.js'],
      peerDependencies: { 'solid-js': solid },
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(root, 'NOTICE'),
  `emdash chat-ui, built for Waypoint
==================================

This archive is a build of the following packages from Waypoint's fork of
the emdash repository (${repo}, branch waypoint — upstream
https://github.com/generalaction/emdash plus Waypoint's own commits), at
commit ${commit}:

  @emdash/chat-ui ${pkg.version}   chat-ui/dist/index.js, chat-ui/dist/style.css,
                          chat-ui/dist/src/**/*.d.ts
  @emdash/core            core-types/*.d.mts   (type declarations only —
                          the ACP transcript model chat-ui's public types
                          reference; no runtime code)
  @emdash/shared          shared-types/*.d.mts (type declarations only)

Copyright 2026 General Action, Inc.; Waypoint's changes copyright their
authors. Licensed under the Apache License, Version 2.0 (the "License");
you may not use these files except in compliance with the License. The
full text of the License is in LICENSE.md beside this file, and at
http://www.apache.org/licenses/LICENSE-2.0.

The build was produced with the packages' own build scripts
(\`pnpm --filter @emdash/chat-ui build\`); the type declarations are the
packages' own \`dist\` output. Waypoint's React wrapper around this
library is Waypoint's own code and lives in the Waypoint repository, not
in this archive.

Bundled third-party code inside chat-ui/dist/index.js is listed with its
license in chat-ui's own package.json dependencies at that commit: shiki
(MIT), @chenglou/pretext (MIT), unified/remark (MIT), beautiful-mermaid
(MIT), vanilla-extract (MIT), Inter (OFL-1.1) and JetBrains Mono (OFL-1.1)
via @fontsource-variable. solid-js (MIT) is NOT bundled: it is a peer the
consumer installs.
`,
);
for (const [dir, distDir, entries] of [
  ['core-types', coreDist, ['runtimes-acp-api-client.d.mts']],
  ['shared-types', sharedDist, ['index.d.mts', 'markdown.d.mts']],
]) {
  const files = new Set();
  for (const e of entries) collectTypes(distDir, e, files);
  mkdirSync(join(root, dir), { recursive: true });
  for (const f of files) cpSync(join(distDir, f), join(root, dir, f));
}
cpSync(join(emdash, 'LICENSE.md'), join(root, 'LICENSE.md'));
writeFileSync(
  join(root, 'manifest.json'),
  `${JSON.stringify(
    {
      name: 'emdash-chat-ui',
      version: pkg.version,
      sourceCommit: commit,
      sourceRepository: repo,
      license: 'Apache-2.0',
      peers: { 'solid-js': solid },
      typePeers: { zod: '4.4.3' },
      entry: 'chat-ui/dist/index.js',
      styles: 'chat-ui/dist/style.css',
      types: 'chat-ui/dist/src/index.d.ts',
    },
    null,
    2,
  )}\n`,
);

mkdirSync(outDir, { recursive: true });
const file = `emdash-chat-ui-${pkg.version}-${short}.tar.gz`;
const archive = join(outDir, file);
// Not byte-reproducible: bsdtar records the staged files' mtimes and this
// runs on a developer machine, so two builds of one commit hash
// differently. The lock pins the sha of THE archive that was published,
// which is the contract; if this is ever run in CI as a check against
// source, normalize mtimes and ordering first.
execFileSync('/usr/bin/tar', ['-czf', archive, '-C', stage, 'emdash-chat-ui']);
rmSync(stage, { recursive: true, force: true });
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${sha256}  ${file}\n`);
console.log(
  JSON.stringify(
    { file, archive, sha256, sourceRepo: repo, sourceCommit: short },
    null,
    2,
  ),
);
