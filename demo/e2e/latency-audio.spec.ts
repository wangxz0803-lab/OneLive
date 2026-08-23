import { expect, test } from '@playwright/test';
import { openDemo, state } from './helpers';

test('云端 860ms / 错位 440ms；切端侧后 215ms / 40ms', async ({ page }) => {
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));

  let s = await state(page);
  expect(s.e2e).toBe(860);
  expect(s.av).toBe(440);
  await expect(page.locator('#mE2E')).toHaveText('860 ms');
  await expect(page.locator('#mAV')).toHaveText('440 ms');

  await page.locator('#topoCtl button[data-topo="edge"]').click();
  s = await state(page);
  expect(s.e2e).toBe(215);
  expect(s.av).toBe(40);
  await expect(page.locator('#mAV')).toHaveText('40 ms');
});

test('抖动加剧音画错位', async ({ page }) => {
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#netList button').nth(2).click();   // 拥塞 jit=100

  const s = await state(page);
  expect(s.av).toBe(100);          // 40 + 100*0.6
  expect(s.e2e).toBe(360);         // rtt 180 + infer 180
});

test('仅 PROGRAM 路出声，四路 video 恒为静音', async ({ page }) => {
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));

  const muted = await page.locator('#mv .tile video').evaluateAll((els) =>
    els.map((el) => (el as HTMLVideoElement).muted),
  );
  expect(muted).toEqual([true, true, true, true]);

  const a = page.locator('#pgmAudio');
  await expect(a).toHaveJSProperty('muted', false);
  await page.waitForFunction(
    () => (document.getElementById('pgmAudio') as HTMLAudioElement).currentTime > 0.2,
  );
});

test('音频落后画面的实测偏移随拓扑收敛到目标值', async ({ page }) => {
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  await page.locator('#mv .tile').nth(1).click();

  const drift = async () =>
    page.evaluate(() => {
      const v = document.querySelectorAll('#mv .tile video')[1] as HTMLVideoElement;
      const a = document.getElementById('pgmAudio') as HTMLAudioElement;
      return v.currentTime - a.currentTime;
    });

  await page.waitForTimeout(3000);
  expect(Math.abs((await drift()) - 0.44)).toBeLessThan(0.12);

  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.waitForTimeout(3000);
  expect(Math.abs((await drift()) - 0.04)).toBeLessThan(0.12);
});

test('拓扑必须驱动流畅度：云端卡顿、端侧流畅', async ({ page }) => {
  // 这是演示第 4 步最先被眼睛捕捉到的差异。曾经 topo 完全不参与渲染，
  // 切拓扑只改清晰度不改流畅度，导致"没有革命性提升"的观感。
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));

  const measure = async () => {
    await page.evaluate(() => {
      const w = window as unknown as { __paints: number };
      w.__paints = 0;
      const ctx = (document.getElementById('pgmCv') as HTMLCanvasElement).getContext('2d')!;
      const orig = ctx.drawImage.bind(ctx);
      // @ts-expect-error 测量用打点
      ctx.drawImage = (...a) => { w.__paints++; return orig(...a); };
    });
    await page.waitForTimeout(2500);
    return page.evaluate(() => (window as unknown as { __paints: number }).__paints / 2.5);
  };

  const cloudFps = await measure();
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.waitForTimeout(500);
  const edgeFps = await measure();

  // 端侧必须显著更流畅——不是"略好"，是评委一眼能看出来的量级差
  expect(edgeFps, `端侧重绘 ${edgeFps.toFixed(1)}/s 应远高于云端 ${cloudFps.toFixed(1)}/s`)
    .toBeGreaterThan(cloudFps * 1.8);
});

test('原始信号是本地监看：不劣化、不错位', async ({ page }) => {
  // CAM 是主播本地采集，不经过任何网络路径。曾经它与交付流一同降画质、
  // 一同卡顿、一同错位 440ms——评委一眼就能看穿"劣化是统一撒的假动画"。
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  await page.locator('#mv .tile').nth(0).click();       // 云端拓扑下切到 CAM

  await expect(page.locator('#mE2E')).toHaveText('本地');
  await expect(page.locator('#mAV')).toHaveText('本地');

  await page.waitForTimeout(3500);
  const drift = await page.evaluate(() => {
    const v = document.querySelectorAll('#mv .tile video')[0] as HTMLVideoElement;
    const a = document.getElementById('pgmAudio') as HTMLAudioElement;
    return v.currentTime - a.currentTime;
  });
  // 本地监看零错位；交付路在云端拓扑下是 0.44s——两者不可混淆
  expect(Math.abs(drift)).toBeLessThan(0.12);
});
