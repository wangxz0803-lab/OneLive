import { expect, test } from '@playwright/test';
import { openDemo, state } from './helpers';

test('未来体验打开后暂停后台解码且关闭后无重载恢复主演示', async ({ page }) => {
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
  await page.locator('#futureOpen').click();
  await expect(page.locator('#futureDialog')).toBeVisible();
  await expect(page.locator('#futureProduction')).toBeVisible();
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('#futureOrbitVideo');
    return !!video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  });
  await page.waitForFunction(() => (window as unknown as { __demo: { state(): { future3dReady: boolean } } }).__demo.state().future3dReady,
    undefined, { timeout: 20_000 });

  const current = await state(page);
  expect(current.futureOpen).toBe(true);
  expect(current.futureMode).toBe('production');
  expect(current.future3dReady).toBe(true);
  expect(current.futureOrbitDuration).toBeCloseTo(7.533, 2);
  await expect(page.locator('.future-rig-cam')).toHaveCount(3);
  await expect(page.locator('.future-rig-monitor img')).toHaveCount(3);
  const cameraSources = await page.locator('.future-rig-monitor img').evaluateAll((images) =>
    images.map((image) => (image as HTMLImageElement).getAttribute('src')));
  expect(new Set(cameraSources).size).toBe(3);
  expect(await page.locator('.future-rig-monitor img').evaluateAll((images) =>
    images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(page.locator('#future3DLayer')).toHaveClass(/is-ready/);
  await expect(page.locator('#future3DLayer canvas')).toHaveCount(1);
  await expect(page.locator('#futureOrbitVideo')).toBeVisible();
  await expect(page.locator('#futureEnterViewer')).toHaveText('进入3D空间');
  expect(await page.locator('#futureOrbitVideo').evaluate((video) => (video as HTMLVideoElement).paused)).toBe(true);

  await page.locator('.future-rig-cam.left').click();
  await expect.poll(async () => (await state(page)).futureAngle).toBe(25);
  await expect.poll(async () => page.locator('#futureOrbitVideo').evaluate((video) => {
    const media = video as HTMLVideoElement;
    return media.duration > 0 ? media.currentTime / media.duration : 0;
  })).toBeGreaterThan(0.9);
  await expect(page.locator('.future-rig-cam.left')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(450);
  expect((await state(page)).futureAngle).toBe(25);
  await page.locator('.future-rig-cam.right').click();
  await expect.poll(async () => (await state(page)).futureAngle).toBe(-25);
  await expect.poll(async () => page.locator('#futureOrbitVideo').evaluate((video) => {
    const media = video as HTMLVideoElement;
    return media.duration > 0 ? media.currentTime / media.duration : 1;
  })).toBeLessThan(0.1);
  await expect(page.locator('#futureOrbitVideo')).toBeVisible();
  expect(await page.locator('#futureOrbitVideo').evaluate((video) => (video as HTMLVideoElement).paused)).toBe(true);

  await page.waitForTimeout(350);
  const media = await page.locator('#mv video').evaluateAll((videos) =>
    videos.map((video) => {
      const mediaVideo = video as HTMLVideoElement;
      return {
        currentTime: mediaVideo.currentTime,
        paused: mediaVideo.paused,
        loadStarts: (mediaVideo as HTMLVideoElement & { __futureLoadStarts?: number }).__futureLoadStarts ?? 0,
      };
    }));
  expect(media.every((sample) => sample.paused && sample.loadStarts === 0)).toBe(true);

  const suspendedTimes = media.map((sample) => sample.currentTime);
  await page.locator('#futureClose').click();
  await expect(page.locator('#futureShell')).toBeHidden();
  await expect.poll(async () => page.locator('#mv video').evaluateAll((videos) =>
    videos.every((video) => !(video as HTMLVideoElement).paused))).toBe(true);
  await page.waitForTimeout(350);
  const resumed = await page.locator('#mv video').evaluateAll((videos, previous) =>
    videos.map((video, index) => {
      const mediaVideo = video as HTMLVideoElement;
      const elapsed = mediaVideo.currentTime >= previous[index]
        ? mediaVideo.currentTime - previous[index]
        : (mediaVideo.duration - previous[index]) + mediaVideo.currentTime;
      return elapsed > 0.1;
    }), suspendedTimes);
  expect(resumed.every(Boolean)).toBe(true);
  expect(errors).toEqual([]);
});

test('观众端支持水平与俯仰自由视角及独立音频', async ({ page }) => {
  test.setTimeout(90_000);
  await openDemo(page);
  await page.locator('#futureOpen').click();
  await page.waitForFunction(() => (window as unknown as { __demo: { state(): { future3dReady: boolean } } }).__demo.state().future3dReady,
    undefined, { timeout: 20_000 });
  await page.locator('#futureEnterViewer').click();

  await expect(page.locator('#futureAudience')).toBeVisible();
  await expect(page.locator('#futureOrbitVideo')).toBeHidden();
  await expect(page.locator('#future3DLayer canvas')).toBeVisible();
  await expect(page.locator('#futureAudience')).toContainText('PRE-GENERATED 3D · LIVE RENDER');
  expect((await state(page)).futureMode).toBe('viewer');

  const canvas = page.locator('#future3DLayer canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * 0.5, bounds!.y + bounds!.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.62, bounds!.y + bounds!.height * 0.32, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).futurePitch).toBeGreaterThan(5);
  await expect(page.locator('#futureViewerAngleValue')).toContainText('俯仰 +');

  await page.locator('#futureAngle').fill('20');
  await expect.poll(async () => (await state(page)).futureAngle).toBe(20);
  await expect(page.locator('#futureAngleValue')).toHaveText('+20°');
  const seek = await page.locator('#futureOrbitVideo').evaluate((video) => ({
    currentTime: (video as HTMLVideoElement).currentTime,
    duration: (video as HTMLVideoElement).duration,
    paused: (video as HTMLVideoElement).paused,
    muted: (video as HTMLVideoElement).muted,
  }));
  expect(seek.currentTime / seek.duration).toBeGreaterThan(0.85);
  expect(seek.paused).toBe(true);
  expect(seek.muted).toBe(true);

  await page.locator('#futureAudioControl').click();
  await expect(page.locator('#futureAudioControl')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('#futureCoreAudio').evaluate((audio) => (audio as HTMLAudioElement).paused)).toBe(false);

  await page.keyboard.press('Escape');
  await expect(page.locator('#futureProduction')).toBeVisible();
  expect((await state(page)).futureMode).toBe('production');
  expect(await page.locator('#futureCoreAudio').evaluate((audio) => (audio as HTMLAudioElement).paused)).toBe(true);
});

test.skip('未来体验不重复承担网络对比，网络差异由六步主演示验证', async ({ page }) => {
  await openDemo(page);
  await page.locator('#futureOpen').click();
  await page.waitForFunction(() => (window as unknown as { __demo: { state(): { future3dReady: boolean } } }).__demo.state().future3dReady,
    undefined, { timeout: 20_000 });
  await page.locator('#futureProduction [data-future-net="congested"]').click();
  await page.locator('#futureEnterViewer').click();

  let current = await state(page);
  expect(current.futureNetwork).toBe('congested');
  expect(current.futureQod).toBe(false);
  await expect(page.locator('#futureGeometryMetric')).toContainText('64');
  await expect(page.locator('#futureAudience')).toHaveClass(/future-net-congested/);
  expect(await page.locator('#future3DLayer canvas').evaluate((canvas) => getComputedStyle(canvas).filter)).toContain('blur(1.6px)');

  await page.locator('#futureAudience [data-future-qod]').click();
  current = await state(page);
  expect(current.futureQod).toBe(true);
  await expect(page.locator('#futureGeometryMetric')).toContainText('91');
  await expect(page.locator('#futureAudience')).toHaveClass(/future-qod/);
  await expect.poll(async () => page.locator('#future3DLayer canvas').evaluate((canvas) => getComputedStyle(canvas).filter))
    .toContain('blur(0.2px)');
  await expect(page.locator('#futureViewerTitle')).toHaveText('当前视口获得优先保障');

  await page.locator('#futureAudience [data-future-qod]').click();
  await page.locator('#futureAudience [data-future-net="weak"]').click();
  await expect(page.locator('#futureAngle')).toHaveAttribute('min', '-25');
  await expect(page.locator('#futureAngle')).toHaveAttribute('max', '25');
  await page.locator('#futureAngle').fill('25');
  await expect.poll(async () => (await state(page)).futureAngle).toBe(25);

  await page.locator('#futureAudience [data-future-net="latency"]').click();
  await page.locator('#futureAngle').fill('20');
  await expect(page.locator('#futureResponseMetric')).toContainText('780');
  await expect.poll(async () => (await state(page)).futureAngle, { timeout: 1500 }).toBe(20);
});

test('V、Esc与返回按钮维持正确层级和焦点', async ({ page }) => {
  await openDemo(page);
  await page.locator('#futureOpen').focus();
  await page.keyboard.press('v');
  await expect(page.locator('#futureDialog')).toBeVisible();
  await expect(page.locator('#futureClose')).toBeFocused();

  await page.locator('#futureEnterViewer').click();
  await expect(page.locator('#futureViewerBack')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#futureProduction')).toBeVisible();
  await expect(page.locator('#futureEnterViewer')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('#futureShell')).toBeHidden();
  await expect(page.locator('#futureOpen')).toBeFocused();
  expect((await state(page)).futureOpen).toBe(false);
});

test('未来体验在桌面与手机视口无页面横向溢出', async ({ page }) => {
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

    await page.locator('#futureEnterViewer').click();
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${width}x${height} 横向溢出`).toBeLessThanOrEqual(0);
    await page.keyboard.press('v');
  }
});
