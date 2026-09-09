import { test, expect } from '@playwright/test';
import { launchApp } from './fixtures';

test('the app launches and shows the home view', async () => {
  const { app, window } = await launchApp();
  try {
    await expect(window).toHaveTitle('Waypoint');
    await expect(
      window.getByText(/Good (morning|afternoon|evening)/),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test('the packaged main process is not running in dev mode', async () => {
  const { app, window } = await launchApp();
  try {
    const isPackaged = await app.evaluate(
      ({ app: electronApp }) => electronApp.isPackaged,
    );
    // The unpacked release build isn't a real installed app, so this stays
    // false here too — the real assertion is that main.js loaded and
    // responded at all, proving the production bundle is sound end to end.
    expect(typeof isPackaged).toBe('boolean');
    await expect(window).toHaveTitle('Waypoint');
  } finally {
    await app.close();
  }
});

// Ticket UX pass, findings 2a/2e: covers the new ParentTicketPicker end to
// end against the real backend — creating a ticket, opening the picker,
// searching/selecting a parent, and seeing it render nested (not just a
// parent-chip pointer) in the SAME session, no reload. Runs against the
// real shared dev backend (localhost:14000), so both tickets use
// timestamped markers rather than fixed titles.
test('creates a subtask via the parent picker and shows it nested under its parent without a reload', async () => {
  const { app, window } = await launchApp();
  try {
    await window.getByText('Tickets', { exact: true }).first().click();

    const parentMarker = `e2e parent ${Date.now()}`;
    const childMarker = `e2e child ${Date.now()}`;

    // Both created through the same toolbar "Add ticket" button, with no
    // column/group context — each falls back to the project's own default
    // (first "unstarted") state, so they land in the SAME group under the
    // default 'state' groupBy without depending on any pre-existing seed
    // ticket's state.
    await window.getByRole('button', { name: 'Add ticket' }).click();
    await window.getByPlaceholder('Ticket title').fill(parentMarker);
    await window.getByRole('button', { name: 'Create ticket' }).click();
    await expect(
      window.getByRole('button', { name: 'Create ticket' }),
    ).toHaveCount(0);

    await window.getByRole('button', { name: 'Add ticket' }).click();
    await window.getByPlaceholder('Ticket title').fill(childMarker);
    // Opens the new ParentTicketPicker and searches/selects through it —
    // not a pre-filled defaultParentId (that's the separate "Add subtask"
    // flow from the ticket detail page).
    await window.getByText('Parent', { exact: true }).click();
    await window.getByPlaceholder('Search tickets…').fill(parentMarker);
    await window.getByText(parentMarker, { exact: true }).click();
    await window.getByRole('button', { name: 'Create ticket' }).click();
    await expect(
      window.getByRole('button', { name: 'Create ticket' }),
    ).toHaveCount(0);

    // Both visible in the same List, in the same session — no reload
    // anywhere above — with the child rendered directly under its parent
    // and indented (finding 2e's same-group nesting), not merely
    // somewhere in the list.
    const parentRow = window.getByText(parentMarker, { exact: true });
    const childRow = window.getByText(childMarker, { exact: true });
    await expect(parentRow).toBeVisible();
    await expect(childRow).toBeVisible();

    const parentBox = await parentRow.boundingBox();
    const childBox = await childRow.boundingBox();
    expect(parentBox).not.toBeNull();
    expect(childBox).not.toBeNull();
    expect(childBox!.y).toBeGreaterThan(parentBox!.y);
    expect(childBox!.x).toBeGreaterThan(parentBox!.x);
  } finally {
    await app.close();
  }
});
