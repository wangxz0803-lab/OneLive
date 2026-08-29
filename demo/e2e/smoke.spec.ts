import { expect, test } from '@playwright/test';
import { openDemo, state } from './helpers';

test('演示台加载出四个监看窗与测试钩子', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openDemo(page);

  await expect(page.locator('#mv .tile')).toHaveCount(4);
  const s = await state(page);
  expect(s.topo).toBe('cloud');
  expect(s.qod).toBe(false);
  expect(s.live).toBe(false);
  await expect(page.locator('#pgmLang')).toHaveText('原始中文');
  await expect(page.locator('#pgmPh')).toHaveAttribute('src', 'assets/original-zh.jpg');
  await expect(page.locator('#bootProgress')).toHaveAttribute('aria-valuenow', '4');
  await expect(page.locator('#bootShell')).toHaveClass(/done/);
  await expect(page.locator('#go')).toBeEnabled();
  expect(errors).toEqual([]);

  // 交叉校验：#bwUp 由 recompute() 的内联算式写入，s.uplinkReal 由新助手算出。
  // 两份实现在 Task 5 合并前必须始终相等，一旦漂移立刻变红。
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  const s2 = await state(page);
  expect(await page.locator('#bwUp').textContent()).toBe(s2.uplinkReal.toFixed(2));
});

test('四路监看指向新素材且标签为三市场', async ({ page }) => {
  await openDemo(page);

  const srcs = await page.locator('#mv .tile video').evaluateAll((els) =>
    els.map((el) => (el as HTMLVideoElement).getAttribute('src')),
  );
  expect(srcs).toEqual([
    'assets/original-zh-demo.mp4',
    'assets/japan-ja-demo.mp4',
    'assets/latam-es-demo.mp4',
    'assets/india-en-demo.mp4',
  ]);

  await page.locator('#go').click();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>('#mv video')]
    .every((video) => video.duration === 15 && !video.paused));
  expect(await page.locator('#mv video').evaluateAll((els) =>
    els.map((el) => (el as HTMLVideoElement).muted),
  )).toEqual([false, true, true, true]);

  const labels = await page.locator('#mv .tile-l').allTextContents();
  expect(labels).toEqual(['原始中文', '日本 · 日语', '拉美 · 西语', '印度 · 英语']);
});

test('左栏状态灯随链路和 QoD 分配显示稳定、波动与受限', async ({ page }) => {
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));

  const channels = page.locator('#chCtl .ctl');
  await expect(channels).toHaveCount(3);
  await expect(channels.nth(0)).toHaveAttribute('data-health', 'ok');
  await expect(channels.nth(0).locator('.cq')).toHaveText('稳定');

  await page.locator('#netList button').nth(1).click();
  await expect(channels.nth(0)).toHaveAttribute('data-health', 'warn');
  await expect(channels.nth(0).locator('.cq')).toHaveText('波动');

  await page.locator('#netList button').nth(3).click();
  await expect(channels.nth(0)).toHaveAttribute('data-health', 'crit');
  await expect(channels.nth(0).locator('.cq')).toHaveText('受限');

  await page.locator('#netList button').nth(0).click();
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  await page.locator('#qodCtl').click();
  await expect(channels.nth(0)).toHaveAttribute('data-health', 'ok');
  await expect(channels.nth(1)).toHaveAttribute('data-health', 'ok');
  await expect(channels.nth(2)).toHaveAttribute('data-health', 'warn');
  await expect(channels.nth(2).locator('.cq')).toHaveText('波动');
});

test('监看窗与播出画面均为 9:16 竖屏且首屏不横向溢出', async ({ page }) => {
  await openDemo(page);

  const tile = await page.locator('#mv .tile').first().boundingBox();
  expect(tile).not.toBeNull();
  expect(tile!.height / tile!.width).toBeCloseTo(16 / 9, 1);

  const stage = await page.locator('.pgm-frame').boundingBox();
  expect(stage).not.toBeNull();
  expect(stage!.height / stage!.width).toBeCloseTo(16 / 9, 1);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('窄视口下播出舞台不塌陷', async ({ page }) => {
  // ≤900px 时 .body 变单列、栅格行改为内容撑高。若 .pgm-frame 没有高度地板，
  // height:100% 会解析成 auto → 算出 0 高 → 9:16 再推出 0 宽，整块舞台消失。
  for (const [width, height] of [
    [900, 900],
    [768, 1024],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await openDemo(page);
    const stage = await page.locator('.pgm-frame').boundingBox();
    expect(stage, `${width}x${height} 舞台应存在`).not.toBeNull();
    expect(stage!.width, `${width}x${height} 舞台宽度`).toBeGreaterThan(120);
    expect(stage!.height, `${width}x${height} 舞台高度`).toBeGreaterThan(200);
    // 比例必须仍是 9:16——曾出现宽度走媒体查询、高度被 height:100% 覆盖，
    // 算出 248x925 这种非法比例，同时把侧栏顶出 .program 被 MULTIVIEW 盖住。
    expect(stage!.height / stage!.width, `${width}x${height} 舞台比例`).toBeCloseTo(16 / 9, 1);

    const bounds = await page.evaluate(() => {
      const side = document.querySelector('.pgm-side')!.getBoundingClientRect();
      const prog = document.querySelector('.program')!.getBoundingClientRect();
      return { sideBottom: side.bottom, progBottom: prog.bottom };
    });
    expect(bounds.sideBottom, `${width}x${height} 侧栏不得溢出 .program`).toBeLessThanOrEqual(
      bounds.progBottom + 1,
    );
  }
});

// 版面平衡：这些数字是交付要求，不是审美偏好——评委在笔电/投影上看，
// 机架被裁掉就点不到链路条件，舞台比侧栏还小就不成其为「播出画面」。
// 必须在开播后的满态下量：空侧栏量出来的版面和真实版面是两回事。
test('开播满态下版面收在视口内且舞台占主导', async ({ page }) => {
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await openDemo(page);
    await page.locator('#go').click();
    await page.waitForFunction(() => document.body.classList.contains('live'));

    const m = await page.evaluate(() => {
      const d = document.documentElement;
      const stage = document.querySelector('.pgm-frame')!.getBoundingClientRect();
      const dock = document.querySelector('.dock')!.getBoundingClientRect();
      const row = document.querySelector('.mv-row')!.getBoundingClientRect();
      const tiles = [...document.querySelectorAll('#mv .tile')].map((t) => t.getBoundingClientRect());
      return {
        vOverflow: d.scrollHeight - d.clientHeight,
        hOverflow: d.scrollWidth - d.clientWidth,
        stageW: stage.width,
        stageRatio: stage.height / stage.width,
        dockBottom: dock.bottom,
        viewportH: d.clientHeight,
        gapLeft: tiles[0].left - row.left,
        gapRight: row.right - tiles[tiles.length - 1].right,
      };
    });
    const at = `${width}x${height}`;

    // A1/A2：整页不滚动，机架和法务行都在首屏。
    expect(m.vOverflow, `${at} 纵向溢出`).toBeLessThanOrEqual(0);
    expect(m.hOverflow, `${at} 横向溢出`).toBeLessThanOrEqual(0);
    // A3/A4：舞台是画面主体，且仍是 9:16 竖屏（素材本身是竖屏，裁掉就没有本地化场景了）。
    expect(m.stageW, `${at} 舞台宽度`).toBeGreaterThanOrEqual(300);
    expect(m.stageRatio, `${at} 舞台比例`).toBeCloseTo(16 / 9, 1);
    // A5：四个小窗必须填满 MULTIVIEW 行，右侧不得再留几百像素空档。
    expect(m.gapLeft, `${at} MULTIVIEW 左侧空档`).toBeLessThanOrEqual(40);
    expect(m.gapRight, `${at} MULTIVIEW 右侧空档`).toBeLessThanOrEqual(40);
    // A6：底部机架（含演示时要点的链路条件按钮）整块在视口内。
    expect(m.dockBottom, `${at} 机架底边`).toBeLessThanOrEqual(m.viewportH + 1);
  }
});

test('证据抽屉展开后无需滚动即可看全', async ({ page }) => {
  await openDemo(page);
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  await page.locator('#evToggle').click();
  // 抽屉是升起动画，量在动画途中会读到位移后的坐标——等它落位再量。
  await page
    .locator('#evidence')
    .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

  const m = await page.evaluate(() => {
    const d = document.documentElement;
    const ev = document.querySelector('#evidence')!.getBoundingClientRect();
    const btn = document.querySelector('#evToggle')!.getBoundingClientRect();
    return {
      top: ev.top,
      bottom: ev.bottom,
      viewportH: d.clientHeight,
      vOverflow: d.scrollHeight - d.clientHeight,
      scrollY: window.scrollY,
      coversToggle: ev.bottom > btn.top && ev.top < btn.bottom,
    };
  });
  expect(m.top).toBeGreaterThanOrEqual(0);
  expect(m.bottom).toBeLessThanOrEqual(m.viewportH + 1);
  expect(m.vOverflow).toBeLessThanOrEqual(0);
  expect(m.scrollY).toBe(0);
  // 抽屉盖住自己的开关，评委就再也关不掉了。
  expect(m.coversToggle).toBe(false);
});

test('平台关闭时右栏流量行与底部机架口径一致', async ({ page }) => {
  await openDemo(page);
  await page.locator('#plats .pl').nth(2).click(); // 开播前先关掉 TikTok

  const flowBefore = await page.locator('#flowList .fw-q').allTextContents();
  const rackBefore = await page.locator('#plats .stt').allTextContents();
  expect(flowBefore).toEqual(rackBefore);
  expect(flowBefore[2]).toBe('已关闭');

  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  // 开播后两侧展示的是不同口径（画质档 vs 路数），但「已关闭」必须仍然一致。
  expect((await page.locator('#flowList .fw-q').allTextContents())[2]).toBe('已关闭');
  expect((await page.locator('#plats .stt').allTextContents())[2]).toBe('已关闭');
});

test('PROGRAM 侧栏逐句展示中文原文与目标语译文', async ({ page }) => {
  await openDemo(page);
  await page.locator('#mv .tile').nth(1).click(); // 切到日本频道

  const rows = page.locator('#pgmSide .lz-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator('.lz-zh')).toContainText('梅特德菲多功能电气锅');
  await expect(rows.nth(0).locator('.lz-tt')).toContainText('メテドフィの多機能電気鍋');

  await page.locator('#mv .tile').nth(2).click(); // 切到拉美频道
  await expect(rows.nth(0).locator('.lz-tt')).toContainText('olla eléctrica multifunción');
});

test('顶栏标注能力边界，右栏按平台列出口流量', async ({ page }) => {
  await openDemo(page);

  const caps = page.locator('#capBar .capcell');
  await expect(caps).toHaveCount(4);
  await expect(caps.nth(0)).toContainText('输入');
  await expect(caps.nth(0)).toContainText('预生成同步母版');
  await expect(caps.nth(3)).toContainText('QoD');

  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));

  const rows = page.locator('#flowList .flowrow');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText('YouTube');
  await expect(page.locator('#flowTotal')).not.toHaveText('0.0');
});

test('证据抽屉默认收起，展开后列出可追溯实测', async ({ page }) => {
  await openDemo(page);

  const drawer = page.locator('#evidence');
  await expect(drawer).toBeHidden();

  await page.locator('#evToggle').click();
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('171');
  await expect(drawer).toContainText('m3a-results.md');
  await expect(page.locator('#evidence li')).toHaveCount(6);
});

test('任何桌面宽度下拓扑开关都必须可点', async ({ page }) => {
  // 演示第 4 步要切到「近端生成」。曾有 @media(max-width:1280px){.rail{display:none}}
  // 在 1280px 投影仪上把整个左栏隐藏，动线直接断掉，而当时没有任何测试覆盖到。
  for (const [width, height] of [
    [1920, 1080],
    [1600, 900],
    [1440, 900],
    [1366, 768],
    [1280, 800],
    [1152, 864],
    [1024, 768],
  ]) {
    await page.setViewportSize({ width, height });
    await openDemo(page);

    const edge = page.locator('#topoCtl button[data-topo="edge"]');
    await expect(edge, `${width}x${height} 近端生成按钮应可见`).toBeVisible();
    await edge.click();
    expect((await state(page)).topo, `${width}x${height} 点击后应切到近端`).toBe('edge');

    const hOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(hOverflow, `${width}x${height} 横向溢出`).toBeLessThanOrEqual(0);
  }
});
