import { expect, test } from '@playwright/test';
import { openDemo, state } from './helpers';

async function goLive(page: import('@playwright/test').Page) {
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
}

test('云端路径：单路上行保持三路高清，QoD 无需启用', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#mv .tile').nth(1).click();

  const s = await state(page);
  expect(s.topo).toBe('cloud');
  expect(s.qodAvailable).toBe(false);
  expect(s.uplinkNeed).toBeCloseTo(6.16, 2);
  expect(s.cap).toBeCloseTo(8.25, 2);
  expect(s.gap).toBeCloseTo(2.09, 2);
  expect(s.quality).toBe('1080P');
  expect(s.channelQualities).toEqual(['LOCAL', '1080P', '1080P', '1080P']);
  expect(s.uplinkReal).toBeCloseTo(6.16, 2);
  expect(s.deliveryMode).toBe('smooth');
  await expect(page.locator('#qodCtl')).toBeDisabled();
  await expect(page.locator('#qodNote')).toContainText('云端只上传一条原流');
});

test('近端路径：三路并发超过容量，公平降至 480P', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#mv .tile').nth(1).click();

  const s = await state(page);
  expect(s.topo).toBe('edge');
  expect(s.uplinkNeed).toBeCloseTo(18.48, 2);
  expect(s.gap).toBeCloseTo(-10.23, 2);
  expect(s.quality).toBe('480P');
  expect(s.channelQualities).toEqual(['LOCAL', '480P', '480P', '480P']);
  expect(s.uplinkReal).toBeCloseTo(4.08, 2);
  expect(s.deliveryMode).toBe('smooth');
  await expect(page.locator('#abr')).toBeVisible();
  await expect(page.locator('#abrTxt')).toContainText('三路公平降至 480P');
});

test('QoD 业务保障：15M 预算使两路 VIP 清晰、一路 Best Effort 模糊', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#mv .tile').nth(1).click();
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#qodCtl').click();

  const s = await state(page);
  expect(s.qod).toBe(true);
  expect(s.cap).toBeCloseTo(15, 2);
  expect(s.gap).toBeCloseTo(-3.48, 2);
  expect(s.priorityChannel).toBe(1);
  expect(s.quality).toBe('1080P');
  expect(s.channelQualities).toEqual(['LOCAL', '1080P', '1080P', '480P']);
  expect(s.uplinkReal).toBeCloseTo(13.68, 2);
  expect(s.head).toBeCloseTo(1.32, 2);
  await expect(page.locator('#lqBr')).toHaveText('15.00');
  await expect(page.locator('#qodNote')).toContainText('VIP：日本 · 日语 / 拉美 · 西语');
  await expect(page.locator('#abr')).toBeVisible();
  await expect(page.locator('#abrTxt')).toContainText('两路 VIP 1080P');
});

test('QoD 策略跟随 PROGRAM：当前节目与一个核心市场为 VIP', async ({ page }) => {
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
  await expect(page.locator('#qodNote')).toContainText('印度 · 英语 / 日本 · 日语');
});

test('4G 档位不支持 QoD，切换制式时自动清除保障状态', async ({ page }) => {
  await openDemo(page);
  await goLive(page);
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#qodCtl').click();
  expect((await state(page)).qod).toBe(true);

  await page.locator('#netList button').nth(2).click();
  const s = await state(page);
  expect(s.qod).toBe(false);
  expect(s.qodAvailable).toBe(false);
  expect(s.cap).toBeCloseTo(1.45, 2);
  await expect(page.locator('#qodCtl')).toBeDisabled();
  await expect(page.locator('#qodNote')).toContainText('当前接入制式不支持');
});
