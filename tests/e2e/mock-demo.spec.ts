import { expect, test } from '@playwright/test';
import {
  captureRuntimeErrors,
  DEMO_URL,
  DIRECTOR_FLOW,
  expectChannelStatuses,
  expectDesktopFirstScreenFits,
  expectDirectorState,
  expectNoRuntimeErrors,
  MARKET_IDS,
  numericDataValue,
  openReadyDemo,
  startManualDirector,
} from './helpers';

async function openNetworkControls(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Open network controls' }).click();
  await expect(page.getByRole('dialog', { name: 'Network experience controls' })).toBeVisible();
}

test.describe('OneLive deterministic mock demonstration', () => {
  test('opens with one source and three healthy localized markets', async ({ page }) => {
    const runtimeErrors = captureRuntimeErrors(page);
    await openReadyDemo(page);

    await expect(page.getByTestId('source-panel')).toBeVisible();
    await expect(page.getByTestId('source-mode')).toHaveAttribute('data-source', 'mock');
    await expect(page.getByTestId('channel-grid')).toBeVisible();

    for (const marketId of MARKET_IDS) {
      const channel = page.getByTestId(`channel-card-${marketId}`);
      await expect(channel).toBeVisible();
      await expect(channel).toHaveAttribute('data-status', 'live');
      await expect(channel).toHaveAttribute('data-provenance', 'EMULATED');
    }

    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-network', 'premium');
    await expect(page.getByTestId('network-path')).toHaveAttribute('data-state', 'stable');
    await expect(page.getByTestId('connect-qr')).toBeVisible();
    await expect(page.getByTestId('connect-qr')).toHaveAccessibleName('Phone');
    await expect(page.getByTestId('director-start')).toHaveAccessibleName(
      'Start automatic demo director',
    );
    await expect(page.getByRole('button', { name: 'Open network controls' })).toBeVisible();
    await expectDesktopFirstScreenFits(page);
    await expectNoRuntimeErrors(runtimeErrors);
  });

  test('makes congestion and high latency visible within one second', async ({ page }) => {
    const runtimeErrors = captureRuntimeErrors(page);
    await openReadyDemo(page);
    const premiumLatency = await numericDataValue(page, 'metric-e2e-latency');
    await openNetworkControls(page);

    await page.getByTestId('profile-congested').click();
    await expect(page.getByTestId('network-path')).toHaveAttribute('data-state', 'stressed', {
      timeout: 1000,
    });
    await expectChannelStatuses(page, {
      'north-america': 'low-res',
      japan: 'buffering',
      spanish: 'low-res',
    });

    await page.getByTestId('profile-latency').click();
    await expect(page.getByTestId('av-sync-warning').first()).toBeVisible({ timeout: 1000 });
    for (const marketId of MARKET_IDS) {
      await expect(page.getByTestId(`channel-card-${marketId}`)).toHaveAttribute(
        'data-sync',
        'warning',
      );
    }
    await expect
      .poll(() => numericDataValue(page, 'metric-e2e-latency'))
      .toBeGreaterThan(premiumLatency);
    await expectNoRuntimeErrors(runtimeErrors);
  });

  test('shows measurable Edge and QoD recovery instead of cosmetic metric changes', async ({
    page,
  }) => {
    const runtimeErrors = captureRuntimeErrors(page);
    await openReadyDemo(page);
    await openNetworkControls(page);

    await page.getByTestId('profile-latency').click();
    const cloudLatency = await numericDataValue(page, 'metric-e2e-latency');
    await page.getByTestId('deployment-toggle').click();
    await expect(page.getByTestId('deployment-toggle')).toHaveAttribute('data-mode', 'edge');
    await expect
      .poll(() => numericDataValue(page, 'metric-e2e-latency'))
      .toBeLessThan(cloudLatency);

    await page.getByTestId('profile-congested').click();
    await expectChannelStatuses(page, {
      'north-america': 'low-res',
      japan: 'buffering',
      spanish: 'low-res',
    });

    await page.getByTestId('qod-toggle').click();
    await expect(page.getByTestId('qod-toggle')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('network-path')).toHaveAttribute('data-state', 'protected');
    await expectChannelStatuses(page, {
      'north-america': 'live',
      japan: 'live',
      spanish: 'live',
    });
    await expectNoRuntimeErrors(runtimeErrors);
  });

  test('runs the six-step director, shortcuts, comparison and business close', async ({ page }) => {
    const runtimeErrors = captureRuntimeErrors(page);
    await openReadyDemo(page, DEMO_URL);

    await startManualDirector(page);
    for (const expectedState of DIRECTOR_FLOW.slice(1)) {
      await page.keyboard.press('Space');
      await expectDirectorState(page, expectedState);
    }

    await page.keyboard.press('Backspace');
    await expectDirectorState(page, DIRECTOR_FLOW[4]);
    await page.keyboard.press('r');
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-network', 'premium');

    for (const [key, profile] of [
      ['2', 'congested'],
      ['3', 'weak'],
      ['4', 'latency'],
      ['1', 'premium'],
    ] as const) {
      await page.keyboard.press(key);
      await expect(page.getByTestId('app-shell')).toHaveAttribute('data-network', profile);
    }

    await page.keyboard.press('e');
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-edge', 'true');
    await page.keyboard.press('q');
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-qod', 'true');

    await page.keyboard.press('c');
    await expect(page.getByTestId('comparison-view')).toBeVisible();
    await expect(page.getByTestId('comparison-cloud')).toBeVisible();
    await expect(page.getByTestId('comparison-edge-qod')).toBeVisible();

    await page.keyboard.press('c');
    await page.keyboard.press('m');
    await expect(page.getByTestId('source-mode')).toHaveAttribute('data-source', 'mock');

    await page.evaluate(() => {
      Object.defineProperty(document.documentElement, 'requestFullscreen', {
        configurable: true,
        value: () => {
          document.documentElement.dataset.fullscreenRequested = 'true';
          return Promise.resolve();
        },
      });
    });
    await page.keyboard.press('f');
    await expect(page.locator('html')).toHaveAttribute('data-fullscreen-requested', 'true');
    await expectNoRuntimeErrors(runtimeErrors);
  });
});
