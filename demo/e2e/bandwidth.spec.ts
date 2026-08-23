import { expect, test } from '@playwright/test';
import { openDemo, state } from './helpers';

async function goLive(page: import('@playwright/test').Page) {
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
}

test('云端拓扑：单路上行 6.16，容量充裕，维持 1080P', async ({ page }) => {
  await openDemo(page);
  await goLive(page);

  const s = await state(page);
  expect(s.topo).toBe('cloud');
  expect(s.uplinkNeed).toBeCloseTo(6.16, 2);
  expect(s.cap).toBeCloseTo(8.25, 2);
  expect(s.gap).toBeCloseTo(2.09, 2);
  expect(s.quality).toBe('1080P');
  expect(s.uplinkReal).toBeCloseTo(6.16, 2);
});

test('端侧拓扑：三路并发 18.48，缺口 -10.23，ABR 压到 480P', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#topoCtl button[data-topo="edge"]').click();

  const s = await state(page);
  expect(s.topo).toBe('edge');
  expect(s.uplinkNeed).toBeCloseTo(18.48, 2);
  expect(s.gap).toBeCloseTo(-10.23, 2);
  expect(s.quality).toBe('480P');
  expect(s.uplinkReal).toBeCloseTo(4.08, 2);
});

test('带宽账本把目标需求与缺口显示出来', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#topoCtl button[data-topo="edge"]').click();

  await expect(page.locator('#bwNeed')).toHaveText('18.48');
  await expect(page.locator('#bwGap')).toHaveText('-10.23');
  await expect(page.locator('#bwGap')).toHaveClass(/bad/);
  await expect(page.locator('#abr')).toBeVisible();
});

test('端侧 + QoD：容量抬到 22，三路并发装得下，回到 1080P', async ({ page }) => {
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#qodCtl').click();

  const s = await state(page);
  expect(s.qod).toBe(true);
  expect(s.cap).toBeCloseTo(22, 2);
  expect(s.uplinkNeed).toBeCloseTo(18.48, 2);
  expect(s.gap).toBeCloseTo(3.52, 2);
  expect(s.quality).toBe('1080P');
  expect(s.uplinkReal).toBeCloseTo(18.48, 2);

  await expect(page.locator('#lqBr')).toHaveText('22.00');
  await expect(page.locator('#lqName')).toContainText('QoD');
  // 降码警告必须真的从台上消失——这是本步的收尾画面。
  await expect(page.locator('#abr')).toBeHidden();
});

test('4G 档位不支持 QoD，开关灰置并说明原因', async ({ page }) => {
  await openDemo(page);
  await page.locator('#netList button').nth(2).click();   // 拥塞 = 4G

  const s = await state(page);
  expect(s.qodAvailable).toBe(false);
  await expect(page.locator('#qodCtl')).toBeDisabled();
  await expect(page.locator('#qodNote')).toContainText('当前接入制式不支持');
});

test('5G NSA 的 QoD 是有限救援：480P → 720P 而非 1080P', async ({ page }) => {
  // QoD 受接入制式约束，不是魔法。NSA 保障 12 < 需求 18.48，只能救到 720P。
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  await page.locator('#netList button').nth(1).click(); // 良好 = 5G NSA
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#qodCtl').click();

  const s = await state(page);
  expect(s.cap).toBeCloseTo(12, 2);
  expect(s.uplinkNeed).toBeCloseTo(18.48, 2);
  expect(s.quality).toBe('720P');
  expect(s.uplinkReal).toBeCloseTo(9.48, 2);
  expect(s.gap).toBeCloseTo(-6.48, 2);
  await expect(page.locator('#abr')).toBeVisible();
});

test('切到不支持 QoD 的制式时自动清除保障状态', async ({ page }) => {
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  await page.locator('#qodCtl').click();
  expect((await state(page)).qod).toBe(true);

  await page.locator('#netList button').nth(2).click(); // 拥塞 = 4G
  const s = await state(page);
  expect(s.qod, 'QoD 必须被强制清除').toBe(false);
  expect(s.cap).toBeCloseTo(1.45, 2); // 回到 4G 真实容量，而非残留的 22
  await expect(page.locator('#qodCtl')).toBeDisabled();
});
