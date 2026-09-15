import { expect, test } from '@playwright/test';
import { openDemo, state } from './helpers';

async function goLive(page: import('@playwright/test').Page) {
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
}

test('云端路径：单路上行保持三路高清，保障服务可以按需启用', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#mv .tile').nth(1).click();

  const s = await state(page);
  expect(s.topo).toBe('cloud');
  expect(s.qodAvailable).toBe(true);
  expect(s.uplinkNeed).toBeCloseTo(5.16, 2);
  expect(s.serviceCap).toBeCloseTo(8, 2);
  expect(s.cap).toBeCloseTo(6.4, 2);
  expect(s.gap).toBeCloseTo(1.24, 2);
  expect(s.quality).toBe('1080P');
  expect(s.channelQualities).toEqual(['LOCAL', '1080P', '1080P', '1080P']);
  expect(s.uplinkReal).toBeCloseTo(5.16, 2);
  expect(s.deliveryMode).toBe('smooth');
  await expect(page.locator('#qodCtl')).toBeEnabled();
  await expect(page.locator('#qodNote')).toContainText('可保障云端关键流');
});

test('端侧路径：三路并发超过容量，公平降至 480P', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#mv .tile').nth(1).click();

  const s = await state(page);
  expect(s.topo).toBe('edge');
  expect(s.uplinkNeed).toBeCloseTo(15.48, 2);
  expect(s.gap).toBeCloseTo(-9.08, 2);
  expect(s.quality).toBe('480P');
  expect(s.channelQualities).toEqual(['LOCAL', '480P', '480P', '480P']);
  expect(s.uplinkReal).toBeCloseTo(4.08, 2);
  expect(s.deliveryMode).toBe('smooth');
  await expect(page.locator('#abr')).toBeVisible();
  await expect(page.locator('#abrTxt')).toContainText('三路公平降至 480P');
});

test('业务保障服务：15M 预算使两路关键频道清晰、一路普通频道模糊', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#mv .tile').nth(1).click();
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#qodCtl').click();

  const s = await state(page);
  expect(s.qod).toBe(true);
  expect(s.serviceCap).toBeCloseTo(15, 2);
  expect(s.cap).toBeCloseTo(12, 2);
  expect(s.gap).toBeCloseTo(-3.48, 2);
  expect(s.priorityChannel).toBe(1);
  expect(s.quality).toBe('1080P');
  expect(s.channelQualities).toEqual(['LOCAL', '1080P', '1080P', '480P']);
  expect(s.uplinkReal).toBeCloseTo(11.68, 2);
  expect(s.head).toBeCloseTo(0.32, 2);
  await expect(page.locator('#lqBr')).toHaveText('15.00');
  await expect(page.locator('#qodNote')).toContainText('优先：日本 · 日语 / 海湾 · 阿拉伯语');
  await expect(page.locator('#abr')).toBeVisible();
  await expect(page.locator('#abrTxt')).toContainText('两路关键频道 1080P');
});

test('保障策略跟随 PROGRAM：当前节目与一个核心市场优先', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#qodCtl').click();
  await page.locator('#mv .tile').nth(2).click();

  const s = await state(page);
  expect(s.priorityChannel).toBe(2);
  expect(s.quality).toBe('1080P');
  expect(s.channelQualities).toEqual(['LOCAL', '1080P', '1080P', '480P']);
  await page.locator('#mv .tile').nth(3).click();
  const switched = await state(page);
  expect(switched.priorityChannel).toBe(3);
  expect(switched.channelQualities).toEqual(['LOCAL', '1080P', '480P', '1080P']);
  await expect(page.locator('#qodNote')).toContainText('拉美 · 西语 / 日本 · 日语');
});

test('未配置保障的网络档位清除服务状态且恢复网络后不自动激活', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#qodCtl').click();
  expect((await state(page)).qod).toBe(true);

  await page.locator('#netList button').nth(2).click();
  const s = await state(page);
  expect(s.qod).toBe(false);
  expect(s.qodAvailable).toBe(false);
  expect(s.serviceCap).toBeCloseTo(2.5, 2);
  expect(s.cap).toBeCloseTo(2, 2);
  await expect(page.locator('#qodCtl')).toBeDisabled();
  await expect(page.locator('#qodNote')).toContainText('当前演示档位未配置');
  await page.locator('#netList button').nth(0).click();
  expect((await state(page)).qod).toBe(false);
  await expect(page.locator('#qodCtl')).toBeEnabled();
});
