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
  await page.getByRole('button', { name: '打开网络设置' }).click();
  await expect(page.getByRole('dialog', { name: '网络体验设置' })).toBeVisible();
}

test.describe('OneLive deterministic mock demonstration', () => {
  test('opens with an original recording and three click-to-reveal localized markets', async ({
    page,
  }) => {
    const runtimeErrors = captureRuntimeErrors(page);
    await openReadyDemo(page);

    await expect(page.getByTestId('source-panel')).toBeVisible();
    await expect(page.getByText('全球直播智能引擎')).toBeVisible();
    await expect(page.getByTestId('source-mode')).toHaveAttribute('data-source', 'mock');
    await expect(page.getByTestId('source-recording')).toHaveAttribute(
      'src',
      '/demo-media/original-zh.mp4',
    );
    await expect(page.getByTestId('channel-grid')).toBeVisible();
    await expect(page.getByRole('group', { name: '系统状态' })).toContainText(
      '真人直播样例 · 模拟 EMULATED',
    );
    await expect(page.getByTestId('source-panel')).not.toContainText('模拟 EMULATED');
    await expect(page.getByTestId('channel-grid')).not.toContainText('模拟 EMULATED');
    const kickerStyle = await page.getByText('真人直播源').evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        fontFamily: style.fontFamily,
        fontSize: Number.parseFloat(style.fontSize),
      };
    });
    expect(kickerStyle.fontFamily.toLowerCase()).not.toContain('consolas');
    expect(kickerStyle.fontSize).toBeGreaterThanOrEqual(11);
    await expect(page.getByTestId('source-panel')).toContainText('真人主播 · 中文主直播');
    await expect(page.getByText('AI 生成 · 已授权')).toHaveCount(0);
    await expect(page.getByTestId('network-path')).toHaveCount(0);

    for (const marketId of MARKET_IDS) {
      const tab = page.getByTestId(`channel-tab-${marketId}`);
      await expect(tab).toBeVisible();
      await expect(tab).toHaveAttribute('data-status', 'live');
    }
    await expect(page.getByTestId('channel-card-japan')).toBeVisible();
    await expect(page.getByTestId('channel-card-latam')).toHaveCount(0);
    await page.getByRole('tab', { name: /拉美.*西班牙语/i }).click();
    await expect(page.getByTestId('channel-card-latam')).toBeVisible();
    await expect(page.getByTestId('localized-video')).toHaveAttribute(
      'src',
      '/demo-media/latam-es.mp4',
    );

    await page.getByTestId('channel-tab-india').click();
    const indiaCard = page.getByTestId('channel-card-india');
    const indiaVideo = page.getByTestId('localized-video');
    await expect(indiaCard).toBeVisible();
    await expect(indiaVideo).toHaveAttribute('src', '/demo-media/india-en.mp4');
    await expect(indiaVideo).toHaveAttribute('poster', '/demo-media/india-en.jpg');
    await expect(indiaCard).not.toContainText('本地化素材待补充');
    await expect
      .poll(() => indiaVideo.evaluate((video) => (video as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(1);

    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-network', 'premium');
    await page.getByRole('button', { name: '打开输入源工具' }).click();
    await expect(page.getByTestId('connect-qr')).toBeVisible();
    await expect(page.getByTestId('connect-qr')).toHaveAccessibleName('手机');
    await expect(page.getByTestId('director-start')).toHaveAccessibleName('开始自动演示');
    await expect(page.getByRole('button', { name: '打开网络设置' })).toBeVisible();
    await expectDesktopFirstScreenFits(page);
    await expectNoRuntimeErrors(runtimeErrors);
  });

  test('reveals the network story once and hides it only on reset', async ({ page }) => {
    await openReadyDemo(page);
    const directorControl = page.getByTestId('director-start');

    await expect(page.getByTestId('network-path')).toHaveCount(0);
    await directorControl.click();
    await expect(page.getByTestId('network-path')).toBeVisible();
    await expect(directorControl).toHaveAccessibleName('暂停自动演示');

    await directorControl.click();
    await expect(page.getByTestId('network-path')).toBeVisible();

    await page.keyboard.press('r');
    await expect(page.getByTestId('network-path')).toHaveCount(0);

    await page.keyboard.press('Space');
    await expect(page.getByTestId('network-path')).toBeVisible();
    await expect(page.getByTestId('network-path')).toContainText('本地化 · 语音 · 视频');

    await page.keyboard.press('r');
    await page.keyboard.press('2');
    await expect(page.getByTestId('network-path')).toBeVisible();

    await page.keyboard.press('r');
    await page.keyboard.press('c');
    await expect(page.getByTestId('comparison-view')).toBeVisible();
    await page.keyboard.press('c');
    await expect(page.getByTestId('network-path')).toBeVisible();
  });

  test('makes congestion and high latency visible within one second', async ({ page }) => {
    const runtimeErrors = captureRuntimeErrors(page);
    await openReadyDemo(page);
    await openNetworkControls(page);
    await page.getByTestId('profile-premium').click();
    const premiumLatency = await numericDataValue(page, 'metric-e2e-latency');

    await page.getByTestId('profile-congested').click();
    await expect(page.getByTestId('network-path')).toHaveAttribute('data-state', 'stressed', {
      timeout: 1000,
    });
    await expectChannelStatuses(page, {
      japan: 'low-res',
      latam: 'buffering',
      india: 'low-res',
    });

    await page.getByTestId('profile-latency').click();
    await expect(page.getByTestId('av-sync-warning').first()).toBeVisible({ timeout: 1000 });
    for (const marketId of MARKET_IDS) {
      await expect(page.getByTestId(`channel-tab-${marketId}`)).toHaveAttribute(
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
      japan: 'low-res',
      latam: 'buffering',
      india: 'low-res',
    });

    await page.getByTestId('qod-toggle').click();
    await expect(page.getByTestId('qod-toggle')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('network-path')).toHaveAttribute('data-state', 'protected');
    await expectChannelStatuses(page, {
      japan: 'live',
      latam: 'live',
      india: 'live',
    });
    await expectNoRuntimeErrors(runtimeErrors);
  });

  test('runs the six-step director, shortcuts, comparison and business close', async ({ page }) => {
    const runtimeErrors = captureRuntimeErrors(page);
    await openReadyDemo(page, DEMO_URL);

    await startManualDirector(page);
    await expect(page.getByTestId('director-next')).toHaveAccessibleName('下一步');
    await expect(page.getByTestId('director-previous')).toHaveAccessibleName('上一步');
    await expect(page.getByRole('button', { name: '重置演示' })).toBeVisible();
    await page.getByTestId('localized-video').evaluate(async (video) => {
      await (video as HTMLVideoElement).play();
    });
    await expect(page.getByTestId('localized-video')).toHaveAttribute(
      'data-applied-audio-delay-ms',
      '0',
    );
    for (const expectedState of DIRECTOR_FLOW.slice(1)) {
      await page.keyboard.press('Space');
      await expectDirectorState(page, expectedState);
      if (expectedState.step === 3) {
        await expect(page.getByTestId('network-path')).toHaveAttribute(
          'data-topology',
          'central-cloud',
        );
        await expect(page.getByTestId('network-path')).toContainText('单路源流上行');
        await expect(page.getByTestId('localized-video')).toHaveAttribute(
          'data-audio-delay-ms',
          '1000',
        );
        await expect(page.getByTestId('localized-video')).toHaveAttribute(
          'data-applied-audio-delay-ms',
          '1000',
        );
        await expect(page.getByTestId('av-sync-warning')).toBeVisible();
      } else if (expectedState.step === 4) {
        await expect(page.getByTestId('network-path')).toHaveAttribute(
          'data-topology',
          'device-edge',
        );
        await expect(page.getByTestId('network-path')).toContainText('三路并发上行');
        await expect(page.getByTestId('localized-video')).toHaveAttribute(
          'data-audio-delay-ms',
          '100',
        );
        await expect(page.getByTestId('localized-video')).toHaveAttribute(
          'data-applied-audio-delay-ms',
          '100',
        );
        await expect(page.getByTestId('av-sync-warning')).toHaveCount(0);
      }
    }

    await page.keyboard.press('Backspace');
    await expectDirectorState(page, DIRECTOR_FLOW[4]);
    await page.keyboard.press('r');
    await expect(page.getByTestId('app-shell')).toHaveAttribute('data-network', 'premium');
    await expect(page.getByTestId('localized-video')).toHaveAttribute('data-audio-delay-ms', '0');

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
    await expect(page.getByText('AI 生成 · 已授权')).toHaveCount(0);

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
