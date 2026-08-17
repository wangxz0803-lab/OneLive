import { expect, test } from '@playwright/test';
import {
  captureRuntimeErrors,
  expectDesktopFirstScreenFits,
  expectNoRuntimeErrors,
  openReadyDemo,
  startManualDirector,
} from './helpers';

test('tells the real-host, device-edge and three-uplink business story', async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await openReadyDemo(page);

  await expect(page.getByTestId('source-panel')).toContainText('真人主播 · 中文主直播');
  await expect(page.getByTestId('channel-grid')).toContainText('3个市场 · 3路直播');

  await startManualDirector(page);
  await page.keyboard.press('Space');
  await page.keyboard.press('Space');
  await page.keyboard.press('Space');

  const path = page.getByTestId('network-path');
  await expect(path).toHaveAttribute('data-topology', 'device-edge');
  await expect(path).toContainText('端侧AI直播终端');
  await expect(path).toContainText('三路并发上行');
  await expect(path).toContainText('普通网络承载');
  await expectDesktopFirstScreenFits(page);
  await page.screenshot({ path: 'artifacts/terminal-edge-story.png', fullPage: true });

  await page.keyboard.press('Space');
  await expect(path).toContainText('QoD 已启用');

  await page.keyboard.press('Space');
  await expect(page.getByTestId('business-summary')).toContainText('一个真人，');
  await expect(page.getByTestId('business-summary')).toContainText('三个市场同时开播');
  await expect(page.getByTestId('business-summary')).toContainText('AI直播终端');
  await page.screenshot({ path: 'artifacts/business-terminal-story.png', fullPage: true });
  await expectNoRuntimeErrors(runtimeErrors);
});
