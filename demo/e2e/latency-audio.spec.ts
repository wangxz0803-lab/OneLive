import { expect, test } from '@playwright/test';
import { openDemo, state } from './helpers';

async function goLive(page: import('@playwright/test').Page) {
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>('#mv video')]
    .every((video) => video.readyState >= 3 && !video.paused));
}

test('云端返回流真实落后本地 2500ms，切端侧后收敛到 180ms', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#mv .tile').nth(1).click();

  let s = await state(page);
  expect(s.sourceLag).toBe(2500);
  expect(s.av).toBe(0);
  await expect(page.locator('#mE2E')).toHaveText('2.50 s');
  await expect(page.locator('#latencyUp')).toHaveText('250 ms');
  await expect(page.locator('#latencyProcess')).toHaveText('1250 ms');
  await expect(page.locator('#latencyDown')).toHaveText('1000 ms');
  await expect(page.locator('#latencyTotal')).toHaveText('2.50 s');
  await expect(page.locator('#mAV')).toHaveText('同步 · 同源');
  await expect.poll(async () => Math.abs((await state(page)).actualMediaLag - 2500), {
    message: '云端返回流必须在媒体时间轴上真实落后本地',
  }).toBeLessThan(120);

  await page.locator('#topoCtl button[data-topo="edge"]').click();
  s = await state(page);
  expect(s.sourceLag).toBe(180);
  await expect(page.locator('#mE2E')).toHaveText('0.18 s');
  await expect.poll(async () => Math.abs((await state(page)).actualMediaLag - 180), {
    message: '端侧流必须追近本地，而不只是修改指标',
  }).toBeLessThan(90);
});

test('云端双流保障降低时延和波动，端侧只保障上行并按处理顺序展示', async ({ page }) => {
  test.setTimeout(60_000);
  await openDemo(page);
  await goLive(page);
  await page.locator('#mv .tile').nth(1).click();

  const before = await state(page);
  expect(before.latencyBreakdown).toMatchObject({
    up: 250, process: 1250, down: 1000, total: 2500, protected: false,
  });

  await page.locator('#qodCtl').click();
  const after = await state(page);
  expect(after.latencyBreakdown).toMatchObject({
    up: 120, process: 1250, down: 580, total: 1950,
    baseline: 2500, upSaved: 130, downSaved: 420, protected: true,
  });
  await expect(page.locator('#latencyUp')).toHaveText('120 ms');
  await expect(page.locator('#latencyUpSaved')).toHaveText('↓ 130 ms');
  await expect(page.locator('#latencyProcess')).toHaveText('1250 ms');
  await expect(page.locator('#latencyDown')).toHaveText('580 ms');
  await expect(page.locator('#latencyDownSaved')).toHaveText('↓ 420 ms');
  await expect(page.locator('#latencyTotal')).toHaveText('1.95 s');
  await expect(page.locator('#qodNote')).toContainText('云端处理不变');
  await expect.poll(async () => Math.abs((await state(page)).actualMediaLag - 1950))
    .toBeLessThan(120);
  expect(after.serviceCap).toBe(before.serviceCap);
  expect(after.assuranceFlows.map(flow => flow.status)).toEqual(['active', 'active']);
  expect(after.latencyBreakdown.upVariation).toBeLessThan(before.latencyBreakdown.upVariation);
  expect(after.latencyBreakdown.downVariation).toBeLessThan(before.latencyBreakdown.downVariation);
  await expect(page.locator('#assuranceUp')).toContainText('主播采集上行');
  await expect(page.locator('#assuranceDown')).toContainText('当前观众下行');

  await page.locator('#netList button').nth(1).click();
  expect((await state(page)).sourceLag).toBe(2450);
  await expect.poll(async () => Math.abs((await state(page)).actualMediaLag - 2450)).toBeLessThan(120);
  await expect(page.locator('#latencyTotalSaved')).toHaveText('原 3.97s');
  await expect(page.locator('#latencyUpVariation')).toContainText('±25ms');
  await expect(page.locator('#latencyDownVariation')).toContainText('±50ms');
  await page.locator('#qodCtl').click();
  expect((await state(page)).sourceLag).toBe(3965);
  await expect(page.locator('#mE2E')).toHaveText('3.97 s');
  await expect(page.locator('#assuranceDown')).toHaveAttribute('data-status', 'inactive');
  await expect(page.locator('#latencyDownSaved')).toHaveText('基线');

  await page.locator('#netList button').nth(0).click();
  await page.getByRole('button', { name: /^端侧生成/ }).click();
  const deviceBefore = await state(page);
  expect(await page.locator('[data-stage]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-stage'))))
    .toEqual(['process', 'up', 'down']);
  await page.locator('#qodCtl').click();
  const deviceAfter = await state(page);
  expect(deviceAfter.serviceCap).toBe(15);
  expect(deviceAfter.assuranceFlows.map(flow => flow.status)).toEqual(['active', 'standard']);
  expect(deviceAfter.latencyBreakdown.process).toBe(deviceBefore.latencyBreakdown.process);
  expect(deviceAfter.latencyBreakdown.down).toBe(deviceBefore.latencyBreakdown.down);
  expect(deviceAfter.latencyBreakdown.downVariation).toBe(deviceBefore.latencyBreakdown.downVariation);
  expect(deviceAfter.sourceLag).toBe(165);
  await expect(page.locator('#assuranceDown')).toContainText('普通分发');
  await page.getByRole('button', { name: /^云端生成/ }).click();
  expect(await page.locator('[data-stage]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-stage'))))
    .toEqual(['up', 'process', 'down']);
  expect((await state(page)).serviceCap).toBe(8);
});

test('部署路径切换必须覆盖尚未完成的旧媒体 seek', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#mv .tile').nth(1).click();

  // 同一事件循环内先制造一个尚未完成的旧 seek，再切换端侧路径。
  // 旧实现会因为 video.seeking 而丢弃新目标，500ms 后才补一次约 2.5 秒跳转。
  await page.evaluate(() => {
    const runtime = window as unknown as { __seekEvents: number };
    const video = document.querySelectorAll<HTMLVideoElement>('#mv video')[1];
    runtime.__seekEvents = 0;
    video.addEventListener('seeking', () => runtime.__seekEvents++);
    video.currentTime = video.duration - 0.01;
    (document.querySelector('#topoCtl button[data-topo="edge"]') as HTMLButtonElement).click();
  });

  await page.waitForTimeout(1200);
  // 一次来自测试制造的旧目标，一次来自用户最新选择；后台校时不得再追加第三次 seek。
  expect(await page.evaluate(() => (window as unknown as { __seekEvents: number }).__seekEvents)).toBe(2);
  await expect.poll(async () => Math.abs((await state(page)).actualMediaLag - 180))
    .toBeLessThan(90);
});

test('高时延保持 1080P 和 30fps，只增加整路交付滞后', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#mv .tile').nth(1).click();
  await page.locator('#netList button').nth(1).click();

  const s = await state(page);
  expect(s.sourceLag).toBe(3965);
  expect(s.quality).toBe('1080P');
  expect(s.deliveryFps).toBe(30);
  expect(s.channelQualities).toEqual(['LOCAL', '1080P', '1080P', '1080P']);
  await expect(page.locator('#pgmMotion')).toHaveText('流畅交付 · 30fps');
  await expect.poll(async () => Math.abs((await state(page)).actualMediaLag - 3965))
    .toBeLessThan(120);
});

test('每路视频自带声音，仅 PROGRAM 路解除静音', async ({ page }) => {
  await openDemo(page);
  await goLive(page);

  expect(await page.locator('#mv video').evaluateAll((els) =>
    els.map((el) => ({
      muted: (el as HTMLVideoElement).muted,
      duration: (el as HTMLVideoElement).duration,
      paused: (el as HTMLVideoElement).paused,
    })),
  )).toEqual([
    { muted: false, duration: 14, paused: false },
    { muted: true, duration: 14, paused: false },
    { muted: true, duration: 14, paused: false },
    { muted: true, duration: 14, paused: false },
  ]);
  await expect(page.locator('#pgmAudios')).toHaveCount(0);
});

test('切 PROGRAM 只切监听与主画面，不重新 load 四路媒体', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __mediaLoads: number };
    w.__mediaLoads = 0;
    const original = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = function load() {
      w.__mediaLoads++;
      return original.call(this);
    };
  });
  await openDemo(page);
  await goLive(page);
  await page.waitForTimeout(500);

  const before = await page.evaluate(() => ({
    loads: (window as unknown as { __mediaLoads: number }).__mediaLoads,
    srcs: [...document.querySelectorAll<HTMLVideoElement>('#mv video')].map((video) => video.currentSrc),
    times: [...document.querySelectorAll<HTMLVideoElement>('#mv video')].map((video) => video.currentTime),
  }));
  await page.locator('#mv .tile').nth(2).click();
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => ({
    loads: (window as unknown as { __mediaLoads: number }).__mediaLoads,
    srcs: [...document.querySelectorAll<HTMLVideoElement>('#mv video')].map((video) => video.currentSrc),
    times: [...document.querySelectorAll<HTMLVideoElement>('#mv video')].map((video) => video.currentTime),
    muted: [...document.querySelectorAll<HTMLVideoElement>('#mv video')].map((video) => video.muted),
  }));

  expect(after.loads).toBe(before.loads);
  expect(after.srcs).toEqual(before.srcs);
  after.times.forEach((time, i) => expect(time).not.toBe(before.times[i]));
  expect(after.muted).toEqual([true, true, false, true]);
});

test('跨过 14 秒循环边界后四路仍维持同一叙事周期和云端滞后', async ({ page }) => {
  test.setTimeout(40_000);
  await openDemo(page);
  await goLive(page);
  await page.locator('#mv .tile').nth(1).click();
  await page.waitForTimeout(16_000);

  const s = await state(page);
  expect(s.sourceLag).toBe(2500);
  expect(Math.abs(s.actualMediaLag - 2500)).toBeLessThan(140);
  const durations = await page.locator('#mv video').evaluateAll((els) =>
    els.map((el) => (el as HTMLVideoElement).duration),
  );
  expect(durations).toEqual([14, 14, 14, 14]);
});

test('两条部署路径都保持流畅，差异来自整路时延而非音画错位', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#mv .tile').nth(1).click();
  expect((await state(page)).deliveryFps).toBe(30);
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  const s = await state(page);
  expect(s.deliveryFps).toBe(30);
  expect(s.av).toBe(0);
});

test('切 PROGRAM 立即提交目标频道首帧', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const w = window as unknown as { __switchPaintAt: number };
    w.__switchPaintAt = 0;
    const target = document.querySelectorAll('#mv .tile video')[2];
    const proto = CanvasRenderingContext2D.prototype as unknown as {
      drawImage: (this: CanvasRenderingContext2D, ...args: unknown[]) => void;
    };
    const original = proto.drawImage;
    proto.drawImage = function drawImage(this: CanvasRenderingContext2D, ...args: unknown[]) {
      if (args[0] === target && this.canvas.width === 360) w.__switchPaintAt = performance.now();
      return original.apply(this, args);
    };
  });
  const elapsed = await page.evaluate(() => {
    const w = window as unknown as { __switchPaintAt: number };
    const started = performance.now();
    (document.querySelectorAll('#mv .tile')[2] as HTMLElement).click();
    return w.__switchPaintAt - started;
  });
  expect(elapsed).toBeGreaterThanOrEqual(0);
  expect(elapsed).toBeLessThan(80);
});

test('原始信号是本地监看，不经过交付路径劣化', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#mv .tile').nth(0).click();

  await expect(page.locator('#mE2E')).toHaveText('本地');
  await expect(page.locator('#mAV')).toHaveText('本地');
  await expect(page.locator('#pgmMotion')).toHaveText('本地监看 · 30fps');
  const s = await state(page);
  expect(s.actualMediaLag).toBe(0);
  expect(s.quality).toBe('1080P');
});
