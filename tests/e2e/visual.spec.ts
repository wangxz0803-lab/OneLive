import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  DEMO_URL,
  expectChannelStatuses,
  expectDesktopFirstScreenFits,
  expectNoHorizontalOverflow,
  MARKET_IDS,
  MOBILE_URL,
  openReadyDemo,
  startManualDirector,
} from './helpers';

const artifactsDirectory = path.resolve(process.cwd(), 'artifacts');

test.beforeAll(async () => {
  await mkdir(artifactsDirectory, { recursive: true });
});

test.describe('required visual QA artifacts', () => {
  test('captures the premium control room at 1440x900 and validates 1920x1080', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReadyDemo(page, DEMO_URL);
    await expectDesktopFirstScreenFits(page);
    const sourceStage = await page.getByTestId('source-panel').boundingBox();
    const localizedStage = await page.getByTestId('channel-grid').boundingBox();
    expect(sourceStage?.width ?? 0).toBeGreaterThan(420);
    expect(localizedStage?.width ?? 0).toBeGreaterThan(520);
    for (const marketId of MARKET_IDS) {
      const tabBox = await page.getByTestId(`channel-tab-${marketId}`).boundingBox();
      expect(tabBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expect
      .poll(() =>
        page
          .getByTestId('source-recording')
          .evaluate((element) => (element as HTMLVideoElement).readyState),
      )
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() =>
        page
          .getByTestId('localized-video')
          .evaluate((element) => (element as HTMLVideoElement).readyState),
      )
      .toBeGreaterThanOrEqual(1);
    const captionSize = await page
      .locator('.localized-caption p')
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(captionSize).toBeGreaterThanOrEqual(13);
    await page.screenshot({
      path: path.join(artifactsDirectory, 'control-room.png'),
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
    });

    await page.setViewportSize({ width: 1920, height: 1080 });
    await expectDesktopFirstScreenFits(page);
    for (const marketId of MARKET_IDS) {
      await expect(page.getByTestId(`channel-tab-${marketId}`)).toBeInViewport();
    }
  });

  test('captures visible network degradation', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReadyDemo(page);
    await page.getByRole('button', { name: '打开网络设置' }).click();
    await page.getByTestId('profile-congested').click();
    await expectChannelStatuses(page, {
      japan: 'low-res',
      latam: 'buffering',
      india: 'low-res',
    });
    await page.getByRole('button', { name: '关闭网络设置' }).click();
    await page.screenshot({
      path: path.join(artifactsDirectory, 'network-degraded.png'),
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
    });
  });

  test('captures Edge and QoD recovery under background congestion', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReadyDemo(page);
    await page.getByRole('button', { name: '打开网络设置' }).click();
    await page.getByTestId('profile-congested').click();
    await page.getByTestId('deployment-toggle').click();
    await page.getByTestId('qod-toggle').click();
    await expect(page.getByTestId('network-path')).toHaveAttribute('data-state', 'protected');
    await expectChannelStatuses(page, {
      japan: 'live',
      latam: 'live',
      india: 'live',
    });
    await page.getByRole('button', { name: '关闭网络设置' }).click();
    await page.screenshot({
      path: path.join(artifactsDirectory, 'edge-qod-recovered.png'),
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
    });
  });

  test('captures the dedicated 390x844 broadcaster', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openReadyDemo(page, MOBILE_URL);
    await expect(page.getByTestId('camera-preview')).toBeVisible();
    await expect(page.getByRole('button', { name: '开始直播' })).toBeVisible();
    await expect(page.getByRole('button', { name: '静音' })).toBeVisible();
    await expect(page.getByRole('button', { name: '切换镜头' })).toBeVisible();
    await expect(page.getByRole('button', { name: '直播文案' })).toBeVisible();
    await expect(page.getByText('不录制 · 不保存 · 自动重连')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const primaryControl = await page.getByTestId('broadcast-start').boundingBox();
    expect(primaryControl?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(primaryControl?.height ?? 0).toBeGreaterThanOrEqual(44);

    await page.screenshot({
      path: path.join(artifactsDirectory, 'mobile-broadcaster.png'),
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
    });
  });

  test('keeps comparison and presenter close unobstructed', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReadyDemo(page);

    await page.keyboard.press('c');
    await expect(page.getByTestId('comparison-view')).toBeVisible();
    await expectDesktopFirstScreenFits(page);
    await page.screenshot({
      path: path.join(artifactsDirectory, 'comparison.png'),
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
    });

    await page.keyboard.press('c');
    await startManualDirector(page);
    const pathBox = await page.getByTestId('network-path').boundingBox();
    const initialHudBox = await page.getByTestId('director-step').boundingBox();
    expect(initialHudBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(initialHudBox?.width ?? 0).toBeGreaterThan(800);
    expect((pathBox?.y ?? 0) + (pathBox?.height ?? 0)).toBeLessThanOrEqual(
      (initialHudBox?.y ?? 0) + 1,
    );
    expect(
      (initialHudBox?.y ?? 0) - ((pathBox?.y ?? 0) + (pathBox?.height ?? 0)),
    ).toBeLessThanOrEqual(14);

    for (let index = 0; index < 5; index += 1) await page.keyboard.press('Space');
    await expect(page.getByTestId('business-summary')).toBeVisible();
    await expectDesktopFirstScreenFits(page);
    const footerBox = await page.locator('.business-footer').boundingBox();
    const summaryBox = await page.getByTestId('business-summary').boundingBox();
    const hudBox = await page.getByTestId('director-step').boundingBox();
    expect(hudBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(hudBox?.width ?? 0).toBeGreaterThan(800);
    expect((footerBox?.y ?? 0) + (footerBox?.height ?? 0)).toBeLessThanOrEqual(
      (hudBox?.y ?? 0) + 1,
    );
    expect(
      (hudBox?.y ?? 0) - ((summaryBox?.y ?? 0) + (summaryBox?.height ?? 0)),
    ).toBeLessThanOrEqual(14);
    await page.screenshot({
      path: path.join(artifactsDirectory, 'business-summary.png'),
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
    });
  });
});
