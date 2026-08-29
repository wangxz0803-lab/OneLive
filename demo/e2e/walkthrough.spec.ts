import { expect, test } from '@playwright/test';
import { openDemo, state } from './helpers';

const SHOTS = 'artifacts/demo-walkthrough';

/* 选中态的高亮走 .24s CSS transition。点完立刻截图会拍到过渡中间帧——
   实测 3-congested 里「优秀」仍是蓝底、「拥塞」还没亮，截图讲的故事和状态相反。
   截图是这条用例的交付物，所以每张都先让过渡走完再拍。 */
async function shot(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('六步动线全程可走，逐步留证', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openDemo(page);

  // 1 开播
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  await page.waitForTimeout(1500);
  expect((await state(page)).sourceLag).toBe(2500);
  await shot(page, '1-live');

  // 2 本地化深度
  // PROGRAM 默认从中文原流开始。先切 CH2 再切 CH1，让这一步同时验证跨频道切换
  // 和「中文输入 → 多语言生成」的叙事起点。
  const pgmLang = page.locator('#pgmLang');
  await page.locator('#mv .tile').nth(2).click();
  await expect(pgmLang).toHaveText(/西/);
  await page.locator('#mv .tile').nth(1).click();
  await expect(pgmLang).toHaveText(/日/);
  await expect(page.locator('#pgmSide .lz-row')).toHaveCount(3);
  await shot(page, '2-localized');

  // 3 先看纯高时延：画质与帧率不变，整路内容更晚；再看拥塞造成降码和卡顿。
  await page.locator('#netList button').nth(1).click();
  let s = await state(page);
  expect(s.quality).toBe('1080P');
  expect(s.sourceLag).toBe(3965);
  expect(s.deliveryFps).toBe(30);
  await shot(page, '3-high-latency');
  await page.locator('#netList button').nth(2).click();
  await expect(page.locator('#abr')).toBeVisible();
  await shot(page, '3-congested');
  await page.locator('#netList button').nth(0).click();

  // 4 切拓扑
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  s = await state(page);
  expect(s.gap).toBeCloseTo(-10.23, 2);
  expect(s.quality).toBe('480P');
  expect(s.channelQualities).toEqual(['LOCAL', '480P', '480P', '480P']);
  expect(s.av).toBe(0);
  expect(s.sourceLag).toBe(180);
  expect(s.deliveryMode).toBe('smooth');
  await expect(page.locator('#pgmMotion')).toHaveText('流畅交付 · 30fps');
  await shot(page, '4-edge');

  // 5 开 QoD
  await page.locator('#qodCtl').click();
  s = await state(page);
  expect(s.quality).toBe('1080P');
  expect(s.channelQualities).toEqual(['LOCAL', '1080P', '1080P', '480P']);
  expect(s.cap).toBeCloseTo(15, 2);
  expect(s.uplinkReal).toBeCloseTo(13.68, 2);
  expect(s.deliveryMode).toBe('smooth');
  await shot(page, '5-qod');

  // 6 加平台（先全关再逐个开，验证出口线性增长）
  // 平台开关是 div[role=button].pl 而非 <button>，选 `#plats button` 会静默匹配到 0 个，
  // 于是「全关」一次没点、断言却读到旧值——这里显式钉住个数，避免同样的空集再骗过测试。
  const plats = page.locator('#plats .pl');
  const n = await plats.count();
  expect(n).toBe(5);
  for (let i = 0; i < n; i++) await plats.nth(i).click(); // 全关
  const zero = await page.locator('#flowTotal').textContent();
  expect(Number(zero)).toBe(0);
  for (let i = 0; i < n; i++) await plats.nth(i).click(); // 全开
  const full = Number(await page.locator('#flowTotal').textContent());
  expect(full).toBeGreaterThan(0);
  await shot(page, '6-platforms');

  expect(errors).toEqual([]);
});

test('1920×1080 首屏无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openDemo(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
