// @anthropic-ai/claude-agent-sdk ships its native runtime as ~8
// os/cpu-gated optionalDependencies (e.g. claude-agent-sdk-darwin-arm64,
// claude-agent-sdk-darwin-x64). A plain `npm install` only fetches the ONE
// variant matching the machine it runs on — but electron-builder (see
// build.mac.target.arch in ../../package.json) packages BOTH arm64 and x64
// mac targets from this same node_modules tree, so whichever arch wasn't
// the install machine's own ends up missing from that arch's bundle and
// the SDK crashes at launch. Confirmed live: a normal arm64 dev install
// only ever populates node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64.
//
// Fix: before packaging, explicitly fetch the optional variant(s) for
// every mac arch electron-builder is configured to build, using npm's
// --os/--cpu flags (npm >=8.7) to pull a specific platform's package
// regardless of the host machine's own arch. --no-save keeps
// release/app/package.json and its lockfile untouched — this only fills
// in node_modules.
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import webpackPaths from '../configs/webpack.paths';
// eslint-disable-next-line import/no-relative-packages
import { build } from '../../package.json';

const PACKAGE_NAME = '@anthropic-ai/claude-agent-sdk';

const { appPath, appNodeModulesPath } = webpackPaths;

const installedPackagePath = path.join(
  appNodeModulesPath,
  PACKAGE_NAME,
  'package.json',
);

if (!fs.existsSync(installedPackagePath)) {
  // Nothing installed yet (e.g. a fresh checkout that hasn't run
  // `npm install` in release/app) — nothing for this script to fix.
  console.log(
    `Skipping optional native dep fetch: ${PACKAGE_NAME} is not installed in release/app.`,
  );
  process.exit(0);
}

const { version } = JSON.parse(fs.readFileSync(installedPackagePath, 'utf8'));

// npm's --cpu values line up 1:1 with electron-builder's mac.target.arch
// values ('arm64' | 'x64' | 'universal') — 'universal' isn't a real npm
// --cpu value and isn't used by this project's build config, so it's not
// handled here.
const macArches: string[] = (build?.mac?.target?.arch ?? []).filter(
  (arch: string) => arch === 'arm64' || arch === 'x64',
);

const missingArches = macArches.filter((arch) => arch !== process.arch);

if (missingArches.length === 0) {
  console.log(
    `${PACKAGE_NAME}: no other mac arch declared in build.mac.target.arch — nothing to fetch.`,
  );
  process.exit(0);
}

missingArches.forEach((arch) => {
  console.log(
    `Fetching ${PACKAGE_NAME}@${version} for darwin/${arch} (host is ${process.arch}) so the ${arch} package includes its native runtime...`,
  );
  execSync(
    `npm install --no-save --os=darwin --cpu=${arch} ${PACKAGE_NAME}@${version}`,
    { cwd: appPath, stdio: 'inherit' },
  );
});
