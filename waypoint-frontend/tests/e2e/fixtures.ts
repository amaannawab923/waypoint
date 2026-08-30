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
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}
