import { expect, test } from '@playwright/test';
import {
  captureRuntimeErrors,
  expectDesktopFirstScreenFits,
  expectNoRuntimeErrors,
  openReadyDemo,
} from './helpers';

test('keeps the avatar interface as an optional technical view', async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await openReadyDemo(page);

  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-control-mode', 'video');
  await expect(page.getByTestId('channel-grid')).toBeVisible();

  await page.getByRole('button', { name: '打开网络设置' }).click();
  await page.getByTestId('stage-mode-avatar').click();

  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-control-mode', 'avatar');
  await expect(page.getByTestId('avatar-technology-stage')).toBeVisible();
  for (const marketId of ['japan', 'latam', 'india']) {
    await expect(page.getByTestId(`avatar-channel-${marketId}`)).toBeVisible();
    await expect(page.getByTestId(`avatar-stage-${marketId}`)).toBeVisible();
  }
  await expect(page.getByTestId('channel-grid')).toHaveCount(0);
  await expectDesktopFirstScreenFits(page);
  await page.screenshot({ path: 'artifacts/avatar-technology.png', fullPage: true });

  await page.keyboard.press('Space');
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-control-mode', 'video');
  await expect(page.getByTestId('channel-grid')).toBeVisible();
  await expectNoRuntimeErrors(runtimeErrors);
});
