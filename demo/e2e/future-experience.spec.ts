import { expect, test } from '@playwright/test';
import { openDemo, state } from './helpers';

test('未来体验独立打开且不重载主直播媒体', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>('#mv video')]
    .every((video) => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused));

  await page.locator('#mv video').evaluateAll((videos) => {
    for (const video of videos) {
      (video as HTMLVideoElement & { __futureLoadStarts?: number }).__futureLoadStarts = 0;
      video.addEventListener('loadstart', () => {
        const tracked = video as HTMLVideoElement & { __futureLoadStarts?: number };
        tracked.__futureLoadStarts = (tracked.__futureLoadStarts ?? 0) + 1;
      });
    }
  });
  const before = await page.locator('#mv video').evaluateAll((videos) =>
    videos.map((video) => (video as HTMLVideoElement).currentTime));

  await page.locator('#futureOpen').click();
  await expect(page.locator('#futureDialog')).toBeVisible();
  await page.waitForTimeout(450);

  const current = await state(page);
  expect(current.futureOpen).toBe(true);
  expect(current.futureMode).toBe('multi');
  expect(current.futureStreams).toBe(9);
  expect(current.futureDemand).toBeCloseTo(55.44, 2);
  await expect(page.locator('#futureScale')).toHaveText('3语言 × 3视图');
  await expect(page.locator('#futureStatus')).toContainText('超出当前网络预算');
  expect(await page.locator('#futureMainImage').evaluate((image) =>
    (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(1000);
  await expect(page.locator('#futureViews img')).toHaveCount(3);
  await expect(page.locator('.future-route.active')).toHaveCount(9);

  const media = await page.locator('#mv video').evaluateAll((videos, previous) =>
    videos.map((video, index) => {
      const mediaVideo = video as HTMLVideoElement;
      const elapsed = mediaVideo.currentTime >= previous[index]
        ? mediaVideo.currentTime - previous[index]
        : (mediaVideo.duration - previous[index]) + mediaVideo.currentTime;
      return {
        advanced: elapsed > 0.1,
        paused: mediaVideo.paused,
        loadStarts: (mediaVideo as HTMLVideoElement & { __futureLoadStarts?: number }).__futureLoadStarts ?? 0,
      };
    }), before);
  expect(media.every((sample) => sample.advanced && !sample.paused && sample.loadStarts === 0)).toBe(true);
  expect(errors).toEqual([]);
});

test('多视图切换与按需视口展示完整网络账本', async ({ page }) => {
  await openDemo(page);
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#qodCtl').click();
  await page.locator('#futureOpen').click();

  const side = page.locator('[data-future-view="side"]');
  await side.click();
  await expect(side).toHaveAttribute('aria-pressed', 'true');
  await expect(side).toHaveClass(/is-primary/);
  expect((await state(page)).futureView).toBe('side');
  await expect(page.locator('#futureFrameTitle')).toHaveText('侧面互动');

  await page.locator('[data-future-policy="viewport"]').click();
  const current = await state(page);
  expect(current.futureDelivery).toBe('viewport');
  expect(current.futureStreams).toBe(3);
  expect(current.futureDemand).toBeCloseTo(18.48, 2);
  await expect(page.locator('#futureStreams')).toHaveText('3 路概念流');
  await expect(page.locator('#futureStatus')).toContainText('两路 VIP 1080P，一路 Best Effort 480P');
  await expect(page.locator('.future-route.active')).toHaveCount(3);
  await expect(page.locator('.future-route.vip')).toHaveCount(2);
  await expect(page.locator('.future-route.best')).toHaveCount(1);
  await expect(page.locator('.future-view.is-sleeping')).toHaveCount(2);
});

test('空间模式不虚构固定码率并支持视角交互', async ({ page }) => {
  await openDemo(page);
  await page.locator('#futureOpen').click();
  await page.locator('#futureSpatialTab').click();

  let current = await state(page);
  expect(current.futureMode).toBe('spatial');
  expect(current.futureStreams).toBeNull();
  expect(current.futureDemand).toBeNull();
  await expect(page.locator('#futureDemand')).toHaveText('场景相关');
  await expect(page.locator('#futureStatus')).toContainText('不展示虚构固定码率');
  await expect(page.locator('.future-boundary')).toContainText('没有真实多机位采集或实时三维重建');
  await expect(page.locator('#futurePolicies')).toBeHidden();
  await expect(page.locator('#futureSpatialPolicy')).toBeVisible();

  await page.locator('#futureAngle').fill('20');
  current = await state(page);
  expect(current.futureAngle).toBe(20);
  await expect(page.locator('#futureAngleValue')).toHaveText('+20°');
  expect(await page.locator('#futurePlane').evaluate((element) =>
    element.style.getPropertyValue('--angle'))).toBe('20deg');
});

test('V 与 Esc 控制未来体验并恢复焦点', async ({ page }) => {
  await openDemo(page);
  await page.locator('#futureOpen').focus();
  await page.keyboard.press('v');
  await expect(page.locator('#futureDialog')).toBeVisible();
  await expect(page.locator('#futureClose')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('#futureShell')).toBeHidden();
  await expect(page.locator('#futureOpen')).toBeFocused();
  expect((await state(page)).futureOpen).toBe(false);
});

test('未来体验在桌面与手机视口无横向溢出', async ({ page }) => {
  for (const [width, height] of [[1440, 900], [1920, 1080], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await openDemo(page);
    await page.locator('#futureOpen').click();

    const bounds = await page.locator('#futureDialog').boundingBox();
    expect(bounds, `${width}x${height} 对话框应存在`).not.toBeNull();
    expect(bounds!.x, `${width}x${height} 左边界`).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width, `${width}x${height} 右边界`).toBeLessThanOrEqual(width + 1);
    expect(bounds!.y, `${width}x${height} 上边界`).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height, `${width}x${height} 下边界`).toBeLessThanOrEqual(height + 1);

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${width}x${height} 横向溢出`).toBeLessThanOrEqual(0);
    await page.keyboard.press('Escape');
  }
});
