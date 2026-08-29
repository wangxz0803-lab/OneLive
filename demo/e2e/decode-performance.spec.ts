import { expect, test } from '@playwright/test';
import { openDemo } from './helpers';

// Trace 会与被测视频共享 GPU/编码资源，反过来制造掉帧；性能证据必须关闭录屏型诊断。
test.use({ trace: 'off', screenshot: 'off' });

test('近端路径必须持续取得真实新媒体帧，不能只重复绘制旧 Canvas', async ({ page }) => {
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#netList button').nth(0).click();
  await page.locator('#mv .tile').nth(1).click();
  await page.waitForFunction(() => !document.body.classList.contains('media-syncing'));
  await page.waitForTimeout(500);

  const result = await page.evaluate(async () => {
    const video = document.querySelectorAll<HTMLVideoElement>('#mv video')[1];
    const mediaTimes: number[] = [];
    const wallTimes: number[] = [];
    let stopped = false;
    const onFrame = (now: number, meta: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      wallTimes.push(now); mediaTimes.push(meta.mediaTime);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    stopped = true;
    const mediaGaps = mediaTimes.slice(1).map((time, i) => (time - mediaTimes[i]) * 1000);
    const wallGaps = wallTimes.slice(1).map((time, i) => time - wallTimes[i]);
    return {
      frames: mediaTimes.length,
      maxMediaGap: mediaGaps.length ? Math.max(...mediaGaps) : Infinity,
      maxWallGap: wallGaps.length ? Math.max(...wallGaps) : Infinity,
      readyState: video.readyState,
    };
  });

  expect(result.readyState).toBeGreaterThanOrEqual(3);
  /* Chromium 149 的无头模式在本机对四路 H.264 走软件解码；单独重复实测为 34–40 帧/3s，
     不能再用有硬件加速时的 70 帧门槛。这里守的是“持续拿到新媒体帧”与“无秒级冻结”，
     现场 Chrome 的 30fps 观感仍需按 README 的人工验收项确认。 */
  expect(result.frames, '3 秒内应持续取得至少 24 个真实解码帧').toBeGreaterThanOrEqual(24);
  expect(result.maxMediaGap, '近端路径媒体时间不应出现秒级跳帧').toBeLessThan(500);
  expect(result.maxWallGap, '近端路径不应出现秒级解码冻结').toBeLessThan(500);
});
