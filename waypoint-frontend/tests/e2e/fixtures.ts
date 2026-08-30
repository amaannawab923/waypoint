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
  const mainPath = path.join(
    __dirname,
    '..',
    '..',
    'release',
    'app',
    'dist',
    'main',
    'main.js',
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
