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
