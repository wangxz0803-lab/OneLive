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
    const beforeQuality = video.getVideoPlaybackQuality();
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
    const afterQuality = video.getVideoPlaybackQuality();
    return {
      frames: mediaTimes.length,
      decodedFrames: afterQuality.totalVideoFrames - beforeQuality.totalVideoFrames,
      droppedFrames: afterQuality.droppedVideoFrames - beforeQuality.droppedVideoFrames,
      maxMediaGap: mediaGaps.length ? Math.max(...mediaGaps) : Infinity,
      maxWallGap: wallGaps.length ? Math.max(...wallGaps) : Infinity,
      readyState: video.readyState,
    };
  });

  expect(result.readyState).toBeGreaterThanOrEqual(3);
  /* Chromium 无头模式会节流 requestVideoFrameCallback / 合成提交，却仍持续解码媒体。
     totalVideoFrames 守真实解码吞吐；回调数和最大间隔守“不是只重复旧 Canvas”。
     可见浏览器还需以 --headed 复测，验证现场合成路径。 */
  expect(result.decodedFrames, '3 秒内应解码至少 75 个真实视频帧').toBeGreaterThanOrEqual(75);
  expect(result.frames, '无头合成器应持续提交媒体帧回调').toBeGreaterThanOrEqual(12);
  expect(result.maxMediaGap, '近端路径媒体时间不应出现秒级跳帧').toBeLessThan(500);
  expect(result.maxWallGap, '近端路径不应出现秒级解码冻结').toBeLessThan(500);
});
