import { defineConfig } from '@playwright/test';

// Electron E2E tests (see docs/qa-electron.md) — launched against the real
// production build (`npm run build`), not the dev server: a self-contained
// main.js is what CI and `electron.launch()` can reliably drive without
// also needing webpack-dev-server up. `npm run test:e2e` builds first.
export default defineConfig({
  testDir: './tests/e2e',
  // 120s, not Playwright's 30s default: this suite launches a fresh
  // Electron instance per test, sequentially, in the same CI job — the
  // last one in the run has hit real resource contention taking 60s+ just
  // to finish its first conversation load (confirmed live in CI; the
  // *first* launch of the run reliably does the same load in under 15s).
  timeout: 120_000,
  fullyParallel: false, // one Electron instance per worker gets expensive fast
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
