import * as fs from 'fs';
import * as path from 'path';
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

// Launches the real production build (release/app/dist/main/main.js) — the
// same one `npm run package` would ship. Not the dev-server-backed build:
// a self-contained main.js is what CI can reliably drive without also
// needing webpack-dev-server running alongside it.
export async function launchApp(): Promise<{
  app: ElectronApplication;
  window: Page;
}> {
  const distMainPath = path.join(
    __dirname,
    '..',
    '..',
    'release',
    'app',
    'dist',
    'main',
  );
  const mainPath = path.join(distMainPath, 'main.js');

  // main.ts picks a preload path based on app.isPackaged — true when
  // electron-builder actually packages the app (dist/main/preload.js,
  // where webpack.config.main.prod.ts's own second entry already puts
  // it), false otherwise, which is what this is: a real production
  // build, but launched unpacked, directly, by Playwright — a third
  // scenario main.ts's own two branches don't cover. Confirmed live: an
  // unpacked launch takes the isPackaged-false (dev) branch and looks
  // for .erb/dll/preload.js relative to dist/main, ENOENT. Copying the
  // already-correct, already-built prod preload.js to that one dev-path
  // location is a test-infrastructure accommodation, not a real app
  // behavior change — main.ts itself is untouched.
  const devDllDir = path.join(distMainPath, '..', '..', '.erb', 'dll');
  fs.mkdirSync(devDllDir, { recursive: true });
  fs.copyFileSync(
    path.join(distMainPath, 'preload.js'),
    path.join(devDllDir, 'preload.js'),
  );

  const app = await electron.launch({
    args: [mainPath],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const window = await app.firstWindow();
  // Printed straight to this step's own stdout, which CI does capture
  // (unlike a backgrounded process's — see the backend-log workflow
  // fix) — the fastest way to actually see what a failed backend
  // request returned, since this backend logs nothing server-side and
  // this suite's trace config doesn't capture network resources.
  window.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[renderer console] ${msg.text()}`);
  });
  window.on('response', (res) => {
    if (!res.ok()) console.log(`[bad response] ${res.status()} ${res.url()}`);
  });
  window.on('requestfailed', (req) => {
    console.log(`[request failed] ${req.url()} — ${req.failure()?.errorText}`);
  });
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}
