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
    await page.screenshot({
      path: path.join(artifactsDirectory, 'control-room.png'),
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
    });

    await page.setViewportSize({ width: 1920, height: 1080 });
    await expectDesktopFirstScreenFits(page);
    for (const marketId of MARKET_IDS) {
      await expect(page.getByTestId(`channel-card-${marketId}`)).toBeInViewport();
    }
  });

  test('captures visible network degradation', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReadyDemo(page);
    await page.getByRole('button', { name: 'Open network controls' }).click();
    await page.getByTestId('profile-congested').click();
    await expectChannelStatuses(page, {
      'north-america': 'low-res',
      japan: 'buffering',
      spanish: 'low-res',
    });
    await page.getByRole('button', { name: 'Close network controls' }).click();
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
    await page.getByRole('button', { name: 'Open network controls' }).click();
    await page.getByTestId('profile-congested').click();
    await page.getByTestId('deployment-toggle').click();
    await page.getByTestId('qod-toggle').click();
    await expect(page.getByTestId('network-path')).toHaveAttribute('data-state', 'protected');
    await expectChannelStatuses(page, {
      'north-america': 'live',
      japan: 'live',
      spanish: 'live',
    });
    await page.getByRole('button', { name: 'Close network controls' }).click();
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
    await expect(page.getByTestId('broadcast-start')).toBeVisible();
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
