import { test, expect } from '@playwright/test';
import { launchApp } from './fixtures';

// Requires the production build to have been built with
// WAYPOINT_FEATURE_COPILOT=true (see package.json's test:e2e script) — the
// flag is inlined into the renderer bundle at webpack build time, not read
// at runtime, so it can't be set via this test's own env.
//
// The panel now opens to a session list, not straight to a composer (issue
// #11's backend-backed multi-session migration) — every test below creates
// its own fresh session via the header "+" rather than assuming an empty
// conversation. This runs against the real shared dev backend
// (localhost:14000), which already carries session history from manual
// testing, so assertions are scoped to each test's own freshly-created
// session rather than assuming the list (or any one session) starts empty.

test('opens the Copilot panel from the topbar toggle, landing on the session list', async () => {
  const { app, window } = await launchApp();
  try {
    const toggle = window.getByLabel('Open Copilot');
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect(window.getByLabel('Close Copilot')).toBeVisible();
    // The list view's header — 'Copilot', not a session's own title — and
    // its "New session" affordance, proving the conversations list loaded
    // rather than hanging on the composer this suite used to open into
    // directly.
    await expect(window.getByText('Copilot', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(window.getByLabel('New session')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('creates a session and sends a message through the real IPC bridge', async () => {
  const { app, window } = await launchApp();
  try {
    await window.getByLabel('Open Copilot').click();
    await expect(window.getByLabel('New session')).toBeVisible({
      timeout: 15_000,
    });

    // A freshly created session has no history to fetch, so the composer is
    // usable immediately — no long "wait for an existing conversation to
    // load" delay like this suite needed before.
    await window.getByLabel('New session').click();
    const composer = window.getByPlaceholder('Ask Copilot…');
    await expect(composer).toBeEnabled({ timeout: 15_000 });

    const marker = `hello from e2e ${Date.now()}`;
    await composer.fill(marker);
    await window.getByLabel('Send').click();

    // Not asserting on a real Claude reply — that depends on the test
    // machine having `claude` installed and authenticated. This proves the
    // message reached the real main-process IPC handler, was persisted to
    // the real backend, and the UI reflects it; the reply content itself is
    // covered by the jest suite's mocked IPC. A timestamped marker, not a
    // fixed string, since this runs against the real shared dev backend.
    await expect(
      window.getByText(marker, { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

// This is the one check that actually exercises issue #11's core
// acceptance criterion end-to-end — "switching conversations shows the
// correct, isolated message history for each" — which the old
// single-conversation version of this suite structurally couldn't cover.
test("keeps two sessions' histories isolated when switching between them", async () => {
  const { app, window } = await launchApp();
  try {
    await window.getByLabel('Open Copilot').click();
    await expect(window.getByLabel('New session')).toBeVisible({
      timeout: 15_000,
    });

    const markerA = `session A marker ${Date.now()}`;
    const markerB = `session B marker ${Date.now()}`;

    await window.getByLabel('New session').click();
    const composer = window.getByPlaceholder('Ask Copilot…');
    await expect(composer).toBeEnabled({ timeout: 15_000 });
    await composer.fill(markerA);
    await window.getByLabel('Send').click();
    await expect(
      window.getByText(markerA, { exact: true }).first(),
    ).toBeVisible();

    await window.getByLabel('Back to sessions').click();
    await window.getByLabel('New session').click();
    await expect(composer).toBeEnabled({ timeout: 15_000 });
    await composer.fill(markerB);
    await window.getByLabel('Send').click();
    await expect(
      window.getByText(markerB, { exact: true }).first(),
    ).toBeVisible();

    // Session B's chat, still open, must not show session A's message.
    await expect(window.getByText(markerA, { exact: true })).toHaveCount(0);

    // Back to the list, into session A (auto-titled from markerA, its first
    // message) — must show only markerA, not markerB.
    await window.getByLabel('Back to sessions').click();
    await window.getByText(markerA, { exact: true }).first().click();
    await expect(
      window.getByText(markerA, { exact: true }).first(),
    ).toBeVisible();
    await expect(window.getByText(markerB, { exact: true })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
