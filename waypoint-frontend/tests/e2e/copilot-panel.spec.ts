import { test, expect } from '@playwright/test';
import { launchApp } from './fixtures';

// Requires the production build to have been built with
// WAYPOINT_FEATURE_COPILOT=true (see package.json's test:e2e script) — the
// flag is inlined into the renderer bundle at webpack build time, not read
// at runtime, so it can't be set via this test's own env.
//
// Written against the single-conversation CopilotPanel currently on main
// (backend-persisted via getCopilotConversation) — the multi-session UI
// (session list, pin/rename/delete) lives on a separate not-yet-merged
// branch and would need this test updated once it lands.
//
// Assertions here deliberately avoid the empty-conversation-only "Ask
// Copilot anything" text: this suite runs against the real shared dev
// backend (localhost:4000), which already carries message history from
// manual testing — the composer input is what's actually always present
// once the conversation loads, regardless of how many messages it holds.
test('opens the Copilot panel from the topbar toggle', async () => {
  const { app, window } = await launchApp();
  try {
    const toggle = window.getByLabel('Open Copilot');
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect(window.getByLabel('Close Copilot')).toBeVisible();
    await expect(window.getByPlaceholder('Ask Copilot…')).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await app.close();
  }
});

test('sends a message through the real IPC bridge', async () => {
  const { app, window } = await launchApp();
  try {
    await window.getByLabel('Open Copilot').click();
    const composer = window.getByPlaceholder('Ask Copilot…');
    // Visible as soon as the panel mounts, but stays disabled until the
    // conversation finishes loading — a cold CI backend (fresh migrate,
    // first request) can take a while, longer than Playwright's default
    // 30s action timeout covers on its own (hit live in CI).
    await expect(composer).toBeEnabled({ timeout: 30_000 });

    const marker = `hello from e2e ${Date.now()}`;
    await composer.fill(marker);
    await window.getByLabel('Send').click();

    // Not asserting on a real Claude reply — that depends on the test
    // machine having `claude` installed and authenticated. This proves the
    // message reached the real main-process IPC handler and the UI
    // reflects it, which is what an E2E pass here is actually verifying;
    // the reply content itself is covered by the jest suite's mocked IPC.
    // A timestamped marker, not a fixed string, since this runs against
    // the real shared dev backend and message history persists across runs.
    await expect(
      window.getByText(marker, { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
