# OneLive 创新大赛演示台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把队友 PR #1 的四段真实电商成片与本地化叙事，装进我方 `demo/index.html` 播控台，做成单文件、双击即开、断网可演的大赛演示台，并让"端侧生成 → N 路并发上行 → QoD 保障"这条根技术论证在界面上自证。

**Architecture:** 全部改动落在 `demo/index.html` 一个文件内。现有 ABR、逐帧劣化引擎、音频总线、链路四档、平台分发逻辑不动；新增 `topo` / `qod` 两个状态量改写上行侧公式，新增时延模型驱动指标条，新增单个 `<audio>` 元素以 `currentTime` 偏移实现真实音画错位。测试是独立的 Playwright 工程，直接以 `file://` 打开 `demo/index.html`——与现场交付方式完全一致。

**Tech Stack:** 原生 HTML/CSS/JS 单文件（无构建、无运行时依赖）；Playwright（仅测试期，用捆绑 chromium）。

**Spec:** `docs/superpowers/specs/2026-08-17-onelive-competition-demo-design.md`

---

## 约定

- **提交作者**：本仓库全局 git 作者是 Codex 遗留配置。每次提交请带上
  `-c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com"`。
- **提交尾注**：所有提交信息末尾追加一行
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **不要触碰**：`engine/`、`mobile/`、`src/`、`server/`、根 `playwright.config.ts`。
- **每个任务结束都要提交**，保持可回退。
- **新增 CSS 类名前必须先查冲突**：`demo/index.html` 是单文件、全局样式表，短类名极易撞车。
  已踩过三次（`.mk`/`.mv` 撞顶栏品牌标记与 MULTIVIEW 卡片；`.fn`/`.fv` 撞音频推子）。
  动手前跑 `grep -nE "\.<类名>[ ,{:.]" demo/index.html` 确认为空。

---

## 文件结构

| 文件 | 状态 | 职责 |
| --- | --- | --- |
| `demo/index.html` | 修改 | 演示台全部逻辑与样式，单文件 |
| `demo/assets/*.mp4` `*.jpg` | 新增/替换 | 四段成片与 poster |
| `demo/playwright.config.ts` | 创建 | 演示台专用测试配置，无 webServer，走 `file://` |
| `demo/e2e/helpers.ts` | 创建 | 打开演示台、读取状态快照的公共助手 |
| `demo/e2e/smoke.spec.ts` | 创建 | 加载与结构冒烟 |
| `demo/e2e/bandwidth.spec.ts` | 创建 | 拓扑 / QoD / ABR 数字自洽 |
| `demo/e2e/latency-audio.spec.ts` | 创建 | 时延指标与音画错位 |
| `demo/e2e/walkthrough.spec.ts` | 创建 | 六步动线截图走查 |
| `demo/README.md` | 修改 | 现场动线说明同步更新 |
| `package.json` | 修改 | 新增 `test:demo` 脚本 |

---

### Task 1: 演示台测试脚手架

**Files:**
- Create: `demo/playwright.config.ts`
- Create: `demo/e2e/helpers.ts`
- Create: `demo/e2e/smoke.spec.ts`
- Modify: `package.json`（scripts 段）

- [ ] **Step 1: 创建测试配置**

创建 `demo/playwright.config.ts`：

```ts
import { defineConfig } from '@playwright/test';

// 演示台是纯静态单文件，测试直接以 file:// 打开——与现场"双击即开"完全同一条路径。
// 刻意不设 webServer，也不复用根配置（根配置会拉起 React 应用的 mock server）。
export default defineConfig({
  testDir: './e2e',
  outputDir: '../artifacts/demo-playwright-results',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    colorScheme: 'dark',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // 用捆绑 chromium，避开 chrome/msedge 渠道差异；放开自动播放以便无手势起播。
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
});
```

- [ ] **Step 2: 创建测试助手**

创建 `demo/e2e/helpers.ts`：

```ts
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';

// 从仓库根运行，故用 cwd 定位。
export const DEMO_URL = pathToFileURL(path.resolve('demo/index.html')).href;

export interface DemoState {
  topo: 'edge' | 'cloud';
  qod: boolean;
  qodAvailable: boolean;
  live: boolean;
  quality: string;
  cap: number;
  uplinkNeed: number;
  uplinkReal: number;
  gap: number;
  head: number;
  e2e: number;
  av: number;
}

export async function openDemo(page: Page): Promise<void> {
  await page.goto(DEMO_URL);
  await page.waitForFunction(() => document.querySelectorAll('#mv .tile').length === 4);
}

export async function state(page: Page): Promise<DemoState> {
  return page.evaluate(() => (window as unknown as { __demo: { state(): DemoState } }).__demo.state());
}
```

- [ ] **Step 3: 写冒烟测试（会失败）**

创建 `demo/e2e/smoke.spec.ts`：

```ts
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
  expect(errors).toEqual([]);
});
```

- [ ] **Step 4: 加 npm 脚本**

在 `package.json` 的 `scripts` 中，紧跟 `"test:e2e"` 之后加入一行：

```json
    "test:demo": "playwright test --config demo/playwright.config.ts",
```

- [ ] **Step 5: 运行测试确认失败**

Run: `npm run test:demo`
Expected: FAIL — `window.__demo` 未定义，`state()` 抛 `TypeError: Cannot read properties of undefined`。

- [ ] **Step 6: 在 demo/index.html 暴露测试钩子**

在 `demo/index.html` 的 `</script>` 之前（文件末尾，约第 771 行）插入：

```js
/* ── 测试钩子：只读状态快照，供 demo/e2e 断言（不影响演示逻辑） ── */
window.__demo = {
  state(){
    return {
      topo, qod, qodAvailable: qodAvailable(), live,
      quality: LADDER[actualQ].id,
      cap: +capEffective().toFixed(2),
      uplinkNeed: +uplinkNeedMbps().toFixed(2),
      uplinkReal: +uplinkRealMbps().toFixed(2),
      gap:  +(capEffective() - uplinkNeedMbps()).toFixed(2),
      head: +(capEffective() - uplinkRealMbps()).toFixed(2),
      e2e: e2eMs(), av: avSkewMs()
    };
  }
};
```

这些函数在 Task 5–7 建立。为让本任务先通过，同时在 `/* ── 状态 ── */` 段（约第 489 行 `let tiles = [], cmtN = 0;` 之后）插入临时定义：

```js
/* 拓扑与 QoD 状态（Task 5/6 接线） */
let topo = "cloud", qod = false;
const QOD_GUARANTEE = { "5G SA": 22.0, "5G NSA": 12.0 };
function qodAvailable(){ return QOD_GUARANTEE[net.m] !== undefined; }
function capEffective(){ return (qod && qodAvailable()) ? QOD_GUARANTEE[net.m] : net.cap; }
function upLanes(){ return topo === "edge" ? chOn.filter(Boolean).length : 1; }
function perLaneAt(qi){ return LADDER[qi].v + AUDIO_MBPS; }
function uplinkNeedMbps(){ return live ? upLanes()*perLaneAt(targetQ) : 0; }
function uplinkRealMbps(){ return live ? upLanes()*perLaneAt(actualQ) : 0; }
function e2eMs(){ return 0; }        // Task 7 实现
function avSkewMs(){ return 0; }     // Task 7 实现
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npm run test:demo`
Expected: PASS，1 passed。

- [ ] **Step 8: 提交**

```bash
git add demo/playwright.config.ts demo/e2e package.json demo/index.html
git -c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com" commit -m "test(demo): add file:// playwright harness and state hook

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 素材接入与 SRC 数据重写

**Files:**
- Create: `demo/assets/original-zh.mp4` `japan-ja.mp4` `latam-es.mp4` `india-en.mp4` 及同名 `.jpg`
- Modify: `demo/index.html`（`SRC` 数组，约第 464–472 行；`CMTS`，约第 476 行）
- Test: `demo/e2e/smoke.spec.ts`

- [ ] **Step 1: 备份旧占位素材并导入新素材**

```bash
mkdir -p demo/assets/_placeholder-backup
cp demo/assets/host.mp4 demo/assets/ch1.mp4 demo/assets/ch2.mp4 demo/assets/ch3.mp4 demo/assets/_placeholder-backup/
cp demo/assets/poster-host.png demo/assets/poster1.png demo/assets/poster2.png demo/assets/poster3.png demo/assets/_placeholder-backup/

for f in original-zh japan-ja latam-es india-en; do
  git show "pr-1:public/demo-media/$f.mp4" > "demo/assets/$f.mp4"
  git show "pr-1:public/demo-media/$f.jpg" > "demo/assets/$f.jpg"
done
ls -la demo/assets/
```

Expected: 四对 mp4/jpg 就位，mp4 各约 12–23MB。

- [ ] **Step 2: 扩充冒烟测试断言素材（会失败）**

在 `demo/e2e/smoke.spec.ts` 末尾追加：

```ts
test('四路监看指向新素材且标签为三市场', async ({ page }) => {
  await openDemo(page);

  const srcs = await page.locator('#mv .tile video').evaluateAll((els) =>
    els.map((el) => (el as HTMLVideoElement).getAttribute('src')),
  );
  expect(srcs).toEqual([
    'assets/original-zh.mp4',
    'assets/japan-ja.mp4',
    'assets/latam-es.mp4',
    'assets/india-en.mp4',
  ]);

  const labels = await page.locator('#mv .tile-l').allTextContents();
  expect(labels).toEqual(['原始中文', '日本 · 日语', '拉美 · 西语', '印度 · 英语']);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm run test:demo`
Expected: FAIL — src 仍为 `assets/host.mp4` 等旧路径。

- [ ] **Step 4: 重写 SRC 数组**

把 `demo/index.html` 第 464–472 行的 `const SRC = [...]` 整块替换为：

```js
const SRC = [
  { id:"zh", label:"原始中文", tag:"CAM", ph:"assets/original-zh.jpg", vid:"assets/original-zh.mp4",
    lang:"原始信号", always:true,
    subs:["梅特德菲多功能电气锅，插上电源即可轻松烹饪。手柄触控面板配备九种功能。",
          "炒、蒸、火锅、汤、粥、煮饭、预约和保温，选择想做的料理即可。",
          "一台锅覆盖日常多种料理，操作直观，也更适合轻松展示。"] },
  { id:"ja", label:"日本 · 日语", tag:"CH1", ph:"assets/japan-ja.jpg", vid:"assets/japan-ja.mp4",
    lang:"日本語",
    subs:["メテドフィの多機能電気鍋です。コンセントにつなぐだけで簡単に調理できます。ハンドルのタッチパネルには9つの機能を搭載。",
          "炒め物、蒸し料理、鍋、スープ、おかゆ、炊飯、予約、保温まで、作りたい料理を選ぶだけです。",
          "一台で毎日のさまざまな料理に対応。操作も直感的で、手軽に使えます。"] },
  { id:"es", label:"拉美 · 西语", tag:"CH2", ph:"assets/latam-es.jpg", vid:"assets/latam-es.mp4",
    lang:"Español",
    subs:["Esta es la olla eléctrica multifunción Metedfi. Solo tienes que enchufarla para cocinar fácilmente. El panel táctil del mango incluye nueve funciones.",
          "Elige saltear, cocinar al vapor, olla caliente, sopa, avena, arroz, programación o conservación del calor.",
          "Una sola olla cubre muchas comidas diarias, con controles sencillos y una presentación clara."] },
  { id:"en", label:"印度 · 英语", tag:"CH3", ph:"assets/india-en.jpg", vid:"assets/india-en.mp4",
    lang:"English (IN)",
    subs:["This is Metedfi’s multifunction electric pot. Just plug it in and start cooking. The handle’s touch panel offers nine cooking modes.",
          "Choose stir-fry, steaming, hot pot, soup, porridge, rice, scheduling or keep-warm mode.",
          "One compact pot handles everyday meals with simple controls and an easy live demonstration."] }
];

/* 中文原文，供 PROGRAM 侧栏做逐句对照（索引与各路 subs 对齐） */
const ZH_LINES = SRC[0].subs;
```

- [ ] **Step 5: 更新评论语言键**

把 `demo/index.html` 约第 476–480 行的 `CMTS` 对象整块替换为：

```js
const CMTS={
  "原始信号":["这个锅看着好实用","多少钱呀主播","有没有优惠券","已下单，期待"],
  "日本語":["便利そうですね！","お値段はいくらですか","日本にも発送できますか","注文しました！"],
  "Español":["¡Qué práctica se ve!","¿Cuánto cuesta?","¿Envían a México?","¡Ya la pedí!"],
  "English (IN)":["This looks so useful!","What's the price?","Do you ship to India?","Just ordered one!"]};
```

- [ ] **Step 6: 更新 PROGRAM 默认 poster**

把 `demo/index.html` 第 365 行：

```html
          <img id="pgmPh" src="assets/poster1.png" alt="播出画面">
```

改为：

```html
          <img id="pgmPh" src="assets/japan-ja.jpg" alt="播出画面">
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npm run test:demo`
Expected: PASS，2 passed。

- [ ] **Step 8: 提交**

```bash
git add demo/assets demo/index.html demo/e2e/smoke.spec.ts
git -c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com" commit -m "feat(demo): swap in four real localized e-commerce clips

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 版面改 9:16 竖屏

**Files:**
- Modify: `demo/index.html`（CSS `.tile` 约第 152 行；`.pgm-frame` 约第 110 行；`.mv-row` 约第 149 行；body 结构约第 360–371 行）
- Test: `demo/e2e/smoke.spec.ts`

- [ ] **Step 1: 写版面测试（会失败）**

在 `demo/e2e/smoke.spec.ts` 末尾追加：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:demo -- --grep "9:16"`
Expected: FAIL — tile 比例约 10/16=0.625，期望 1.78。

- [ ] **Step 3: 改 MULTIVIEW 尺寸**

把 `demo/index.html` 第 149 行：

```css
.mv-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}
@media(max-width:640px){.mv-row{grid-template-columns:repeat(2,1fr)}}
```

替换为：

```css
/* 竖屏素材：固定窗高，宽度由 9:16 推出，四窗横排不撑破舞台列 */
.mv-row{display:flex;gap:9px;align-items:flex-start}
@media(max-width:640px){.mv-row{flex-wrap:wrap;justify-content:center}}
```

把第 152 行 `.tile{...aspect-ratio:16/10;...}` 中的 `aspect-ratio:16/10` 改为：

```css
  aspect-ratio:9/16;height:178px;flex:none;
```

（即 `.tile` 规则变为 `position:relative;border-radius:var(--r1);overflow:hidden;cursor:pointer;background:var(--void);aspect-ratio:9/16;height:178px;flex:none;box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);transition:.28s var(--e)`）

同时把 `.tile img,.tile video,.tile canvas` 规则里的 `object-position:50% 20%` 改为 `object-position:50% 50%`——竖屏素材不再需要上移取景。

- [ ] **Step 4: 改 PROGRAM 为「竖屏舞台 + 右侧栏」两栏**

把 `demo/index.html` 第 360–371 行的 `<section class="program">…</section>` 整块替换为：

```html
      <section class="program">
        <div class="pgm-tag">PROGRAM</div>
        <div class="pgm-body">
          <div class="pgm-frame">
            <canvas id="pgmBg" aria-hidden="true"></canvas>
            <canvas id="pgmCv" aria-label="播出画面"></canvas>
            <img id="pgmPh" src="assets/japan-ja.jpg" alt="播出画面">
            <div class="pgm-tally"><span class="rec"><i></i>ON AIR</span><span class="tc" id="tcPgm">00:00:00</span></div>
            <div class="pgm-meta"><span id="pgmLang">日本語</span><span class="sepdot">·</span><span id="pgmRes">1080P</span></div>
            <div class="pgm-cc" id="pgmCC"></div>
            <div class="pgm-veil">点击右上「开始直播」</div>
          </div>
          <div class="pgm-side" id="pgmSide"></div>
        </div>
      </section>
```

在 CSS 的 `/* ── PROGRAM ── */` 段内，`.pgm-tag` 规则之后插入：

```css
.pgm-body{display:flex;gap:14px;flex:1;min-height:0;margin-top:16px;align-items:stretch}
.pgm-side{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}
```

并把 `.pgm-frame` 规则中的 `flex:1;min-height:330px;` 改为 `flex:0 0 auto;height:100%;aspect-ratio:9/16;min-height:0;`，同时删除该规则里的 `margin-top:16px`（已移到 `.pgm-body`）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test:demo`
Expected: PASS，3 passed。

- [ ] **Step 6: 人工目检**

Run: `npx playwright test --config demo/playwright.config.ts demo/e2e/smoke.spec.ts --headed --grep "9:16"`

浏览器窗口弹出时人工确认：四个竖屏窗横排不溢出、PROGRAM 竖屏舞台右侧留出空白列（Task 4 会填入文案对照）、底部机架未被挤出首屏。

- [ ] **Step 7: 提交**

```bash
git add demo/index.html demo/e2e/smoke.spec.ts
git -c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com" commit -m "feat(demo): switch stage and multiview to 9:16 portrait

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: PROGRAM 侧栏——本地化文案对照

**Files:**
- Modify: `demo/index.html`（CSS 新增；`setPgm()` 约第 509 行；字幕轮换处）
- Test: `demo/e2e/smoke.spec.ts`

- [ ] **Step 1: 写文案对照测试（会失败）**

在 `demo/e2e/smoke.spec.ts` 末尾追加：

```ts
test('PROGRAM 侧栏逐句展示中文原文与目标语译文', async ({ page }) => {
  await openDemo(page);
  await page.locator('#mv .tile').nth(1).click();      // 切到日本频道

  const rows = page.locator('#pgmSide .lz-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator('.lz-zh')).toContainText('梅特德菲多功能电气锅');
  await expect(rows.nth(0).locator('.lz-tt')).toContainText('メテドフィの多機能電気鍋');

  await page.locator('#mv .tile').nth(2).click();      // 切到拉美频道
  await expect(rows.nth(0).locator('.lz-tt')).toContainText('olla eléctrica multifunción');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:demo -- --grep "文案对照"`
Expected: FAIL — `#pgmSide .lz-row` 数量为 0。

- [ ] **Step 3: 加侧栏样式**

在 CSS `/* ── PROGRAM ── */` 段末尾（`.pgm-veil` 规则之后）插入：

```css
/* 本地化文案对照：竖屏留白的主要承载物 */
.lz{border-radius:var(--r2);padding:11px 13px;background:var(--glass);
  backdrop-filter:blur(18px) saturate(150%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);
  display:flex;flex-direction:column;gap:9px;overflow:auto;flex:1;min-height:0}
.lz-h{display:flex;align-items:baseline;justify-content:space-between}
.lz-h b{font-family:var(--mono);font-size:9px;letter-spacing:.22em;color:var(--t3);font-weight:600}
.lz-h em{font-style:normal;font-size:10px;color:var(--t3)}
.lz-row{padding:8px 0;border-top:1px dashed rgba(255,255,255,.09)}
.lz-row:first-of-type{border-top:none}
.lz-zh{font-size:11.5px;line-height:1.6;color:var(--t2)}
.lz-tt{font-size:12.5px;line-height:1.65;margin-top:5px}
.lz-k{font-family:var(--mono);font-size:8.5px;letter-spacing:.1em;color:var(--t3);
  display:block;margin-bottom:3px}
```

- [ ] **Step 4: 实现侧栏渲染并在切频道时刷新**

在 `demo/index.html` 的 `setPgm()` 函数（约第 509 行）之前插入：

```js
/* ── PROGRAM 侧栏：中文原文 ↔ 目标语译文逐句对照 ── */
function renderPgmSide(){
  const s = SRC[pgm], isSrc = pgm === 0;
  const rows = ZH_LINES.map((zh,i)=>`
    <div class="lz-row">
      <span class="lz-k">ZH-CN · 原文</span>
      <div class="lz-zh">${zh}</div>
      ${isSrc ? "" : `<span class="lz-k" style="margin-top:6px">${s.lang} · 本地化文案</span>
      <div class="lz-tt">${s.subs[i]}</div>`}
    </div>`).join("");
  $("pgmSide").innerHTML = `
    <div class="lz">
      <div class="lz-h"><b>本地化文案对照</b><em>${isSrc ? "原始信号" : s.label}</em></div>
      ${rows}
    </div>`;
}
```

在 `setPgm()` 函数体末尾（`document.querySelector(".pgm-frame").classList.toggle(...)` 那一行之后）追加一行：

```js
  renderPgmSide();
```

不需要另加初始化调用：文件末尾的初始化链（约第 770 行）已有 `setPgm(1)`，会带出侧栏首次渲染。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test:demo`
Expected: PASS，4 passed。

- [ ] **Step 6: 提交**

```bash
git add demo/index.html demo/e2e/smoke.spec.ts
git -c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com" commit -m "feat(demo): add side-by-side localization script panel

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 拓扑状态、上行公式与带宽账本

**Files:**
- Modify: `demo/index.html`（`recompute()` 约第 607–647 行；左栏 markup 约第 340–356 行；带宽账本 markup 约第 380–397 行）
- Test: `demo/e2e/bandwidth.spec.ts`

- [ ] **Step 1: 写带宽测试（会失败）**

创建 `demo/e2e/bandwidth.spec.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:demo -- --config demo/playwright.config.ts demo/e2e/bandwidth.spec.ts`
Expected: FAIL — `#topoCtl` 不存在。

- [ ] **Step 3: 加左栏「生成位置」分段控件**

在 `demo/index.html` 左栏（第 341–344 行「语言频道」那个 `.rg` 之前）插入：

```html
      <div class="rg">
        <div class="rt">生成位置<span class="rt-x" id="topoNow">云端</span></div>
        <div class="ctls" id="topoCtl">
          <button class="ctl on" type="button" data-topo="cloud" aria-pressed="true">
            <span class="cd"></span><span class="cl">云端生成</span><span class="cq">上行 ×1</span></button>
          <button class="ctl" type="button" data-topo="edge" aria-pressed="false">
            <span class="cd"></span><span class="cl">端侧生成</span><span class="cq">上行 ×N</span></button>
        </div>
      </div>
```

在 `renderChans()` 函数之前插入其渲染与事件：

```js
/* ── 左栏：生成位置（端侧 / 云端）——只改上行侧公式 ── */
function renderTopo(){
  $("topoCtl").querySelectorAll("button").forEach(b=>{
    const on = b.dataset.topo === topo;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  $("topoNow").textContent = topo === "edge" ? "端侧" : "云端";
}
$("topoCtl").querySelectorAll("button").forEach(b=>{
  b.onclick = ()=>{ topo = b.dataset.topo; renderTopo(); recompute(); };
});
```

在文件末尾的初始化链（约第 770 行）

```js
renderChans(); renderQ(); renderSubs(); dests(); renderPlat(); setPgm(1); recompute();
```

改为在 `renderChans()` 之前插入 `renderTopo();`：

```js
renderTopo(); renderChans(); renderQ(); renderSubs(); dests(); renderPlat(); setPgm(1); recompute();
```

- [ ] **Step 4: 改写 recompute()**

把 `demo/index.html` 中 `function recompute(){` 起始的前 12 行（自 `actualQ = targetQ;` 至 `const head = net.cap - uplink;`）替换为：

```js
  const cap = capEffective(), ul = upLanes();
  // 1) ABR：上行总需求 ≤ 有效容量，否则逐级降码
  actualQ = targetQ;
  while (actualQ < LADDER.length-1 && ul*perLaneAt(actualQ) > cap) actualQ++;
  const q = LADDER[actualQ], perLane = perLaneAt(actualQ);

  // 2) 出口：路数 = 在播频道 × 开启平台（与拓扑无关）
  const chN = chOn.filter(Boolean).length, plN = platOn.filter(Boolean).length;
  const lanes = live ? chN*plN : 0;
  const egress = lanes*perLane;

  // 3) 上行：目标需求（触发 ABR 的原因）与实际发送分开显示
  const uplinkNeed = uplinkNeedMbps();
  const uplink = uplinkRealMbps();
  const gap  = cap - uplinkNeed;
  const head = cap - uplink;
```

随后把该函数「上屏」段中的 `$("bwCap").textContent = net.cap.toFixed(2);` 改为 `$("bwCap").textContent = cap.toFixed(2);`，把两处 `net.cap` 出现的比例计算（`clamp(uplink/net.cap*100,0,100)`、`uplink>net.cap`、`uplink>net.cap*.8`）中的 `net.cap` 全部替换为 `cap`。

并在 `$("bwHead")` 那两行之后追加：

```js
  $("bwNeed").textContent = uplinkNeed.toFixed(2);
  $("bwGap").textContent  = (gap>=0?"+":"") + gap.toFixed(2);
  $("bwGap").className    = "bv " + (gap<0?"bad":gap<1?"warn":"ok");
  $("bwUpLanes").textContent = ul;
```

同时把 ABR 提示文案一行改为：

```js
  if(abr) $("abrTxt").textContent =
    `上行需求 ${uplinkNeed.toFixed(2)} Mbps 超出容量 ${cap.toFixed(2)} Mbps，已自动降至 ${q.id}`;
```

- [ ] **Step 5: 扩充带宽账本 markup**

把 `demo/index.html` 带宽账本中「手机上行」那一行（约第 388–389 行）替换为：

```html
          <div class="bwrow"><span class="bk">上行需求 <small id="bwUpLanes">1</small> 路</span>
            <span class="bv" id="bwNeed">0.00</span><span class="bs">Mbps</span></div>
          <div class="bwrow"><span class="bk">实际上行</span>
            <span class="bv" id="bwUp">0.00</span><span class="bs">/ <span id="bwCap">8.25</span> Mbps</span></div>
```

把「链路余量」那一行（约第 392–393 行）之前插入：

```html
          <div class="bwrow"><span class="bk">容量缺口</span><span class="bv ok" id="bwGap">+8.25</span>
            <span class="bs">Mbps</span></div>
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm run test:demo`
Expected: PASS，7 passed。

- [ ] **Step 7: 提交**

```bash
git add demo/index.html demo/e2e/bandwidth.spec.ts
git -c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com" commit -m "feat(demo): add edge/cloud topology switch and uplink ledger

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: QoD 保障开关（受接入制式约束）

**Files:**
- Modify: `demo/index.html`（底栏「链路条件」区块约第 429–432 行；链路切换函数约第 568 行）
- Test: `demo/e2e/bandwidth.spec.ts`

- [ ] **Step 1: 写 QoD 测试（会失败）**

在 `demo/e2e/bandwidth.spec.ts` 末尾追加：

```ts
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
});

test('4G 档位不支持 QoD，开关灰置并说明原因', async ({ page }) => {
  await openDemo(page);
  await page.locator('#netList button').nth(2).click();   // 拥塞 = 4G

  const s = await state(page);
  expect(s.qodAvailable).toBe(false);
  await expect(page.locator('#qodCtl')).toBeDisabled();
  await expect(page.locator('#qodNote')).toContainText('当前接入制式不支持');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:demo -- demo/e2e/bandwidth.spec.ts`
Expected: FAIL — `#qodCtl` 不存在。

- [ ] **Step 3: 加 QoD 开关 markup**

把 `demo/index.html` 底栏「链路条件」区块（约第 429–432 行）替换为：

```html
    <section class="bus">
      <div class="bus-t">链路条件<em>决定容量，触发自动降码</em></div>
      <div class="netrow" id="netList" role="group" aria-label="链路条件"></div>
      <div class="qodrow">
        <button class="ctl" id="qodCtl" type="button" aria-pressed="false">
          <span class="cd"></span><span class="cl">QoD 保障</span><span class="cq" id="qodCap">—</span></button>
        <span class="qodnote" id="qodNote">为关键业务流提供确定性上行保障</span>
      </div>
    </section>
```

在 CSS `/* ── 底部机架 ── */` 段末尾插入：

```css
.qodrow{display:flex;align-items:center;gap:10px;margin-top:9px}
.qodrow .ctl{flex:none;min-width:168px}
.qodrow .ctl[disabled]{opacity:.4;cursor:not-allowed}
.qodnote{font-size:10.5px;color:var(--t3);line-height:1.5}
```

- [ ] **Step 4: 接线 QoD 渲染与事件**

在 `renderTopo()` 之后插入：

```js
/* ── QoD 保障：不凭空造带宽，依赖接入制式的保障能力 ── */
function renderQod(){
  const ok = qodAvailable();
  const btn = $("qodCtl");
  btn.disabled = !ok;
  if(!ok) qod = false;
  btn.classList.toggle("on", qod);
  btn.setAttribute("aria-pressed", String(qod));
  $("qodCap").textContent = ok ? QOD_GUARANTEE[net.m].toFixed(2) + "M" : "不可用";
  $("qodNote").textContent = ok
    ? `${net.m} 可为关键业务流保障 ${QOD_GUARANTEE[net.m].toFixed(2)} Mbps 上行`
    : `当前接入制式不支持 QoD 保障（${net.m}）`;
}
$("qodCtl").onclick = ()=>{ if(!qodAvailable()) return; qod = !qod; renderQod(); recompute(); };
```

在链路档位切换处理函数（`/* ── 链路档位 ── */` 段内，选中新档位后调用 `recompute()` 的地方）的 `recompute()` 之前插入一行 `renderQod();`。

把初始化链再改为在 `renderTopo();` 之后插入 `renderQod();`：

```js
renderTopo(); renderQod(); renderChans(); renderQ(); renderSubs(); dests(); renderPlat(); setPgm(1); recompute();
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test:demo`
Expected: PASS，9 passed。

- [ ] **Step 6: 提交**

```bash
git add demo/index.html demo/e2e/bandwidth.spec.ts
git -c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com" commit -m "feat(demo): add QoD guarantee gated by access technology

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 时延模型与 PROGRAM 指标条

**Files:**
- Modify: `demo/index.html`（Task 1 的 `e2eMs()` / `avSkewMs()` 桩；`.pgm-side` markup；`recompute()` 上屏段）
- Test: `demo/e2e/latency-audio.spec.ts`

- [ ] **Step 1: 写时延测试（会失败）**

创建 `demo/e2e/latency-audio.spec.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:demo -- demo/e2e/latency-audio.spec.ts`
Expected: FAIL — `e2eMs()` 桩返回 0。

- [ ] **Step 3: 实现时延模型**

把 Task 1 插入的两行桩：

```js
function e2eMs(){ return 0; }        // Task 7 实现
function avSkewMs(){ return 0; }     // Task 7 实现
```

替换为：

```js
/* ── 时延与音画同步模型 ──
   E2E 端侧 = 链路 RTT + 端侧本地化推理
   E2E 云端 = 链路 RTT + 跨洲往返 + 云端本地化推理 + 分发
   音画错位不由 RTT 直接决定：它来自视频路径与语音链路(ASR/翻译/TTS)处理长度不一致，
   抖动会在此基础上继续放大。端侧的段级流水线把这个差值压到 40ms 量级。 */
const LAT = { edge:{ infer:180, extra:0 }, cloud:{ infer:420, extra:250+155 } };
const AV_BASE = { edge:40, cloud:440 };
function e2eMs(){ const L = LAT[topo]; return Math.round(net.rtt + L.infer + L.extra); }
function avSkewMs(){ return Math.round(AV_BASE[topo] + net.jit*0.6); }
```

- [ ] **Step 4: 加指标条 markup 与样式**

在 CSS `.lz-k` 规则之后插入：

```css
.mbar{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;flex:none}
.mcell{border-radius:var(--r2);padding:9px 11px;background:var(--glass);
  backdrop-filter:blur(18px) saturate(150%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.07)}
.mcell .mk{font-family:var(--mono);font-size:8.5px;letter-spacing:.14em;color:var(--t3);display:block}
.mcell .mv{font-family:var(--mono);font-size:16px;margin-top:3px;display:block}
.mcell .mv.ok{color:var(--ok)} .mcell .mv.warn{color:var(--warn)} .mcell .mv.bad{color:var(--crit)}
```

在 `renderPgmSide()` 中，把 `$("pgmSide").innerHTML = ` 的模板改为在文案面板**之前**插入指标条：

```js
  $("pgmSide").innerHTML = `
    <div class="mbar">
      <div class="mcell"><span class="mk">E2E 时延</span><span class="mv" id="mE2E">— ms</span></div>
      <div class="mcell"><span class="mk">A-V SYNC</span><span class="mv" id="mAV">— ms</span></div>
      <div class="mcell"><span class="mk">上行码率</span><span class="mv" id="mBr">— M</span></div>
    </div>
    <div class="lz">
      <div class="lz-h"><b>本地化文案对照</b><em>${isSrc ? "原始信号" : s.label}</em></div>
      ${rows}
    </div>`;
  paintMetrics();
```

并在 `renderPgmSide()` 之后新增：

```js
/* 指标条数值：与带宽账本同源，避免两处各算一遍 */
function paintMetrics(){
  if(!$("mE2E")) return;
  const e = e2eMs(), a = avSkewMs();
  const cls = (v,good,warn)=> v<=good ? "mv ok" : v<=warn ? "mv warn" : "mv bad";
  $("mE2E").textContent = e + " ms";  $("mE2E").className = cls(e,300,700);
  $("mAV").textContent  = a + " ms";  $("mAV").className  = cls(a,80,250);
  $("mBr").textContent  = uplinkRealMbps().toFixed(2) + " M";
  $("mBr").className    = "mv";
}
```

在 `recompute()` 的上屏段末尾追加一行 `paintMetrics();`。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test:demo`
Expected: PASS，11 passed。

- [ ] **Step 6: 提交**

```bash
git add demo/index.html demo/e2e/latency-audio.spec.ts
git -c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com" commit -m "feat(demo): model E2E latency and A/V skew per topology

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 音频通路——双元素偏移实现真实音画错位

**Files:**
- Modify: `demo/index.html`（body 新增 `<audio>`；`setPgm()`；`start()` / `stop()`；新增对齐 tick）
- Test: `demo/e2e/latency-audio.spec.ts`

**背景（不要改成 WebAudio）**：已实测 `file://` 下 Chrome 对本地媒体的 `createMediaElementSource` 输出全零并报 `MediaElementAudioSource outputs zeroes due to CORS access restrictions`。四个 `<video>` 全程 `muted` 只负责画面，单个 `<audio>` 承载 PROGRAM 那一路的声音。

- [ ] **Step 1: 写音频测试（会失败）**

在 `demo/e2e/latency-audio.spec.ts` 末尾追加：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:demo -- demo/e2e/latency-audio.spec.ts`
Expected: FAIL — `#pgmAudio` 不存在。

- [ ] **Step 3: 加 audio 元素**

在 `demo/index.html` 的 `.pgm-frame` 结束标签之后、`<div class="pgm-side" ...>` 之前插入：

```html
          <audio id="pgmAudio" loop preload="auto" aria-hidden="true"></audio>
```

- [ ] **Step 4: 实现音源切换与偏移对齐**

在 `paintMetrics()` 之后插入：

```js
/* ── 音频通路：单元素承载 PROGRAM 路声音，currentTime 落后画面 avSkew ──
   file:// 下 WebAudio 对本地媒体输出全零（CORS），故不用 DelayNode。
   对齐优先用 playbackRate 牵引，偏差过大才硬 seek，避免跳音。 */
function syncAudioSource(){
  const a = $("pgmAudio"), want = SRC[pgm].vid;
  if(a.getAttribute("src") !== want){
    a.setAttribute("src", want);
    a.load();
    if(live) a.play().catch(()=>{});
  }
}
function alignAudio(){
  const a = $("pgmAudio"), v = tiles[pgm] && tiles[pgm].vd;
  if(!live || !v || !v.duration) return;
  const target = Math.max(0, v.currentTime - avSkewMs()/1000);
  const drift = a.currentTime - target;          // >0 表示音频跑快了
  if(Math.abs(drift) > 0.4){ a.currentTime = target; a.playbackRate = 1; }
  else if(drift >  0.08)  a.playbackRate = 0.97;
  else if(drift < -0.08)  a.playbackRate = 1.03;
  else                    a.playbackRate = 1;
}
setInterval(alignAudio, 250);
```

在 `setPgm()` 末尾（`renderPgmSide();` 之后）追加一行 `syncAudioSource();`。

- [ ] **Step 5: 在开播/停播时起停音频**

在 `start()` 函数体末尾追加：

```js
  const a = $("pgmAudio");
  a.muted = false; a.volume = 1;
  syncAudioSource();
  a.play().catch(()=>{});          // 由「开始直播」点击手势触发，满足自动播放策略
```

在 `stop()` 函数体末尾追加：

```js
  const a = $("pgmAudio");
  a.pause(); a.currentTime = 0;
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm run test:demo`
Expected: PASS，13 passed。

- [ ] **Step 7: 人工听感验收**

用 Chrome 双击打开 `demo/index.html`，点「开始直播」，切到日本频道。
确认：能听到日语配音；此时（云端拓扑）声音明显晚于口型；点「端侧生成」后声音在 1–2 秒内追上并对齐。

- [ ] **Step 8: 提交**

```bash
git add demo/index.html demo/e2e/latency-audio.spec.ts
git -c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com" commit -m "feat(demo): audible A/V skew via dual-element offset

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 顶栏能力边界标注与右栏平台流量数据

**Files:**
- Modify: `demo/index.html`（顶栏约第 330 行；右栏「观众数据」区块约第 402–420 行；`renderPlat()` / `recompute()`）
- Test: `demo/e2e/smoke.spec.ts`

- [ ] **Step 1: 写测试（会失败）**

在 `demo/e2e/smoke.spec.ts` 末尾追加：

```ts
test('顶栏标注能力边界，右栏按平台列出口流量', async ({ page }) => {
  await openDemo(page);

  const caps = page.locator('#capBar .capcell');
  await expect(caps).toHaveCount(4);
  await expect(caps.nth(0)).toContainText('输入');
  await expect(caps.nth(0)).toContainText('预生成素材');
  await expect(caps.nth(3)).toContainText('QoD');

  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));

  const rows = page.locator('#flowList .flowrow');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText('YouTube');
  await expect(page.locator('#flowTotal')).not.toHaveText('0.0');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:demo -- --grep "能力边界"`
Expected: FAIL — `#capBar` 不存在。

- [ ] **Step 3: 加顶栏能力边界条**

把 `demo/index.html` 第 330 行 `<div class="sp"></div>` 替换为：

```html
    <div class="capbar" id="capBar" aria-label="能力边界">
      <span class="capcell"><b>输入</b><em>预生成素材 · 模拟</em></span>
      <span class="capcell"><b>网络</b><em id="capNet">优秀 5G SA · 模拟</em></span>
      <span class="capcell"><b>推理</b><em id="capInfer">云端 · 模拟</em></span>
      <span class="capcell"><b>QoD</b><em id="capQod">未启用 · 模拟</em></span>
    </div>
    <div class="sp"></div>
```

在 CSS `/* ── 顶栏 ── */` 段末尾插入：

```css
.capbar{display:flex;gap:14px;align-items:center;padding:0 4px}
.capcell{display:flex;flex-direction:column;line-height:1.35}
.capcell b{font-family:var(--mono);font-size:8.5px;letter-spacing:.14em;color:var(--t3);font-weight:600}
.capcell em{font-style:normal;font-size:10.5px;color:var(--t2);white-space:nowrap}
```

- [ ] **Step 4: 用平台流量数据替换观众数据**

把 `demo/index.html` 右栏「观众数据」整个 `<section class="panel">…</section>`（约第 402–420 行）替换为：

```html
      <section class="panel">
        <div class="p-h"><span class="p-t">平台流量数据</span><span class="p-x">出口 = 语言 × 平台 × 码率</span></div>
        <div class="p-b">
          <div class="flowtop"><span class="flowbig" id="flowTotal">0.0</span><span class="flowu">Mbps</span>
            <span class="flowl">出口合计</span></div>
          <div id="flowList"></div>
        </div>
      </section>
```

在 CSS `/* ── 右栏 ── */` 段末尾插入：

```css
.flowtop{display:flex;align-items:baseline;gap:5px;margin-bottom:9px}
.flowbig{font-family:var(--mono);font-size:23px}
.flowu{font-size:10px;color:var(--t3)}
.flowl{margin-left:auto;font-size:10px;color:var(--t3)}
.flowrow{display:flex;align-items:center;gap:8px;padding:6px 0;
  border-top:1px solid rgba(255,255,255,.06);font-size:11.5px}
.flowrow:first-child{border-top:none}
.flowrow .fw-n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.flowrow .fw-v{font-family:var(--mono);font-size:11.5px}
.flowrow .fw-q{font-family:var(--mono);font-size:9.5px;color:var(--t3);min-width:42px;text-align:right}
.flowrow.off{opacity:.35}
```

- [ ] **Step 5: 渲染平台流量并接入 recompute**

在 `paintMetrics()` 之后插入：

```js
/* ── 右栏：平台流量数据（运维口径，非宣传板） ── */
function renderFlow(){
  const chN = chOn.filter(Boolean).length, perLane = perLaneAt(actualQ);
  const per = live ? chN*perLane : 0;
  $("flowList").innerHTML = PLAT.map((p,i)=>`
    <div class="flowrow${platOn[i]?"":" off"}">
      <span class="fw-n" style="color:${platOn[i]?p.c:"inherit"}">${p.n}</span>
      <span class="fw-v">${(platOn[i]?per:0).toFixed(2)}</span>
      <span class="fw-q">${platOn[i]?LADDER[actualQ].id:"待开播"}</span>
    </div>`).join("");
  const total = per * platOn.filter(Boolean).length;
  $("flowTotal").textContent = total.toFixed(1);
}
```

在 `recompute()` 上屏段末尾（`paintMetrics();` 之后）追加：

```js
  renderFlow();
  $("capNet").textContent   = `${net.n} ${net.m} · 模拟`;
  $("capInfer").textContent = `${topo === "edge" ? "端侧" : "云端"} · 模拟`;
  $("capQod").textContent   = qod ? "已启用 · 模拟" : "未启用 · 模拟";
```

删除 `/* ── 观众数据：与在播路数、画质挂钩 ── */` 起、至其 `},1000);` 结束的整段（约第 747–769 行），**保留其后的初始化调用行**。

注意两点：

- 评论模块用的是独立计数器 `cmtN`，不依赖 `vw/lk/cm/sh2`，删除安全。
- **但该段顺带在驱动四个监看小窗的数字标签 `t.num`**，直接删掉会让小窗数字永久停在 `—`。改为在 `renderFlow()` 末尾接管，并换成更贴题的每路上行码率：

```js
  // 小窗数字标签：显示该路上行码率（原为观众数，与流量叙事无关）
  tiles.forEach((t,i)=>{
    const on = !t.el.classList.contains("off");
    t.num.textContent = (live && on) ? perLane.toFixed(2)+"M" : "—";
  });
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm run test:demo`
Expected: PASS，14 passed。检查控制台无 `Cannot read properties of null`（观众数据删干净的标志）。

- [ ] **Step 7: 提交**

```bash
git add demo/index.html demo/e2e/smoke.spec.ts
git -c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com" commit -m "feat(demo): capability-boundary bar and per-platform egress table

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: 证据抽屉与页脚声明

**Files:**
- Modify: `demo/index.html`（页脚约第 439 行）
- Test: `demo/e2e/smoke.spec.ts`

- [ ] **Step 1: 写测试（会失败）**

在 `demo/e2e/smoke.spec.ts` 末尾追加：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:demo -- --grep "证据抽屉"`
Expected: FAIL — `#evidence` 不存在。

- [ ] **Step 3: 替换页脚**

把 `demo/index.html` 第 439 行整行替换为：

```html
  <p class="legal">成片为<b>预生成素材</b> · 网络 / Edge / QoD / 时延为<b>可控模拟</b>，不代表生产部署或商用 SLA · 画面劣化与带宽账本为<b>实时计算</b>
    　·　空格 开播 · 1–4 链路 · Q/W/E 切频道
    <button class="evbtn" id="evToggle" type="button" aria-expanded="false" aria-controls="evidence">实测证据</button></p>
  <div class="evidence" id="evidence" hidden>
    <div class="ev-h">以下为本项目真实可运行部分的实测记录，均可在仓库中追溯</div>
    <ul>
      <li>真实 RTMP 推流：数字人 + 语音推出 h264/aac 直播流<span>docs/superpowers/m3a-results.md</span></li>
      <li>推流韧性：sink 被杀 1.3s 检出、10.3s 自动恢复<span>docs/superpowers/m3a-results.md</span></li>
      <li>真实网络损伤：clumsy WinDivert 内核级丢包 / 限速 / 乱序<span>engine/netlab/README.md</span></li>
      <li>双端实测 RTT：WS ping/pong 传输层往返，非蜂窝 RTT<span>docs/superpowers/m3b-results.md</span></li>
      <li>引擎端到端时延：中位 674ms（浏览器采集全链路）<span>docs/superpowers/m1c-results.md</span></li>
      <li>回归网：Python 171 项 + 控制台 E2E 5/5 + 手机传输 33/33<span>docs/superpowers/m4-results.md</span></li>
    </ul>
  </div>
```

在 CSS 末尾（`</style>` 之前）插入：

```css
.evbtn{margin-left:10px;font:inherit;font-size:10.5px;color:var(--brand2);background:none;
  border:1px solid color-mix(in srgb,var(--brand2) 40%,transparent);border-radius:5px;
  padding:2px 9px;cursor:pointer}
.evbtn:hover{background:color-mix(in srgb,var(--brand2) 12%,transparent)}
.evidence{margin:0 18px 14px;padding:12px 15px;border-radius:var(--r2);background:var(--glass);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
.ev-h{font-size:10.5px;color:var(--t3);margin-bottom:8px}
.evidence ul{margin:0;padding-left:16px}
.evidence li{font-size:11.5px;line-height:1.75;color:var(--t2)}
.evidence li span{font-family:var(--mono);font-size:9.5px;color:var(--t3);margin-left:8px}
```

在文件末尾测试钩子之前插入：

```js
$("evToggle").onclick = ()=>{
  const d = $("evidence"), open = d.hidden;
  d.hidden = !open;
  $("evToggle").setAttribute("aria-expanded", String(open));
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:demo`
Expected: PASS，15 passed。

- [ ] **Step 5: 核对证据条目属实**

Run: `ls docs/superpowers/m1c-results.md docs/superpowers/m3a-results.md docs/superpowers/m3b-results.md docs/superpowers/m4-results.md engine/netlab/README.md`
Expected: 五个文件都存在。任何一个不存在，就把对应条目改成实际存在的来源文件——**不允许引用不存在的证据**。

- [ ] **Step 6: 提交**

```bash
git add demo/index.html demo/e2e/smoke.spec.ts
git -c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com" commit -m "feat(demo): evidence drawer with traceable measured results

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: 六步动线走查与三段式数字回归

**Files:**
- Create: `demo/e2e/walkthrough.spec.ts`
- Test: 同上

- [ ] **Step 1: 写动线走查测试**

创建 `demo/e2e/walkthrough.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { openDemo, state } from './helpers';

const SHOTS = 'artifacts/demo-walkthrough';

test('六步动线全程可走，逐步留证', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openDemo(page);

  // 1 开播
  await page.locator('#go').click();
  await page.waitForFunction(() => document.body.classList.contains('live'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/1-live.png` });

  // 2 本地化深度
  await page.locator('#mv .tile').nth(1).click();
  await expect(page.locator('#pgmSide .lz-row')).toHaveCount(3);
  await page.screenshot({ path: `${SHOTS}/2-localized.png` });

  // 3 拧网络
  await page.locator('#netList button').nth(2).click();
  await expect(page.locator('#abr')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/3-congested.png` });
  await page.locator('#netList button').nth(0).click();

  // 4 切拓扑
  await page.locator('#topoCtl button[data-topo="edge"]').click();
  let s = await state(page);
  expect(s.gap).toBeCloseTo(-10.23, 2);
  expect(s.quality).toBe('480P');
  expect(s.av).toBe(40);
  await page.screenshot({ path: `${SHOTS}/4-edge.png` });

  // 5 开 QoD
  await page.locator('#qodCtl').click();
  s = await state(page);
  expect(s.quality).toBe('1080P');
  expect(s.gap).toBeCloseTo(3.52, 2);
  await page.screenshot({ path: `${SHOTS}/5-qod.png` });

  // 6 加平台（先全关再逐个开，验证出口线性增长）
  const plats = page.locator('#plats button');
  const n = await plats.count();
  for (let i = 0; i < n; i++) await plats.nth(i).click();       // 全关
  const zero = await page.locator('#flowTotal').textContent();
  expect(Number(zero)).toBe(0);
  for (let i = 0; i < n; i++) await plats.nth(i).click();       // 全开
  const full = Number(await page.locator('#flowTotal').textContent());
  expect(full).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/6-platforms.png` });

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
```

- [ ] **Step 2: 运行并修复**

Run: `npm run test:demo`
Expected: 全部 PASS（17 passed）。若第 6 步全关平台后 `flowTotal` 非 0，检查 `renderFlow()` 是否在平台开关回调里被调用——`renderPlat()` 的 `onclick` 里已有 `recompute()`，而 `renderFlow()` 由 `recompute()` 末尾调用，链路应自然打通。

- [ ] **Step 3: 人工核对截图**

Run: `ls artifacts/demo-walkthrough/`
逐张打开 6 张截图，确认：无裁切、无重叠、无文字溢出；第 4 张能看到缺口为负与 480P；第 5 张回到 1080P。

- [ ] **Step 4: 提交**

```bash
git add demo/e2e/walkthrough.spec.ts
git -c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com" commit -m "test(demo): six-step walkthrough with screenshot evidence

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: 文档同步与最终验收

**Files:**
- Modify: `demo/README.md`
- Modify: `.gitignore`（忽略走查截图产物）

- [ ] **Step 1: 忽略截图产物**

在 `.gitignore` 末尾追加：

```
artifacts/demo-walkthrough/
artifacts/demo-playwright-results/
```

- [ ] **Step 2: 重写 demo/README.md 的动线表**

把 `demo/README.md` 中「现场怎么演（建议动线）」的表格整块替换为：

```markdown
| # | 动作 | 评委看到什么 |
|---|------|--------------|
| 1 | 点 **「开始直播」** | 四窗同屏：一位中国主播说中文，同时播出日语和服版、拉美西语版、印度英语版——场景与服装整体本地化 |
| 2 | 点 **日本频道** | PROGRAM 切日语版，右侧逐句显示中文原文 ↔ 日语译文。这不是加字幕，是整条内容重制 |
| 3 | 链路切 **「拥塞」** | 画面按丢包真丢帧、按带宽真降采样、按抖动真延迟绘制，画质自动降级并告警。切回「优秀」 |
| 4 | 生成位置切 **「端侧生成」** | 上行需求 6.16 → 18.48 Mbps，缺口转负 −10.23，ABR 强制降到 480P；**同时** E2E 860 → 215ms，音画错位 440 → 40ms，**声音当场追上口型** |
| 5 | 开 **「QoD 保障」** | 保障容量抬到 22 Mbps，三路并发装得下，画质弹回 1080P 且保持同步 |
| 6 | 逐个开 **推流平台** | 出口 = 语言 × 平台 × 码率，平台流量表线性增长 |

> 第 4 步是全场转折点：评委自己会得出结论——云端省上行但跨洲回传让音画错位到无法互动；端侧能实时同步，代价是上行翻三倍而链路吃不下。第 5 步给出唯一的解。
```

把「换成你自己的数字人素材」一节的文件名表格更新为 `original-zh.mp4` / `japan-ja.mp4` / `latam-es.mp4` / `india-en.mp4` 与同名 `.jpg`，并把「规格建议」一列改为「竖屏 9:16，12–20 秒，可循环，**需带音轨**」。

同时删除该节末尾「当前 `assets/` 里是**占位视频**（由形象图加缓慢运镜生成），换成真素材后演示效果会有质的提升」这句——它已经不成立了。

把「诚实边界」一节的第一条改为：

```markdown
- **预生成**：四段成片为提前生成的素材，不是现场实时渲染
- **可控模拟**：网络参数、Edge、QoD、时延数值为模拟值，不代表生产部署或商用 SLA
- **真实计算**：网络劣化对画面的影响、带宽账本与 ABR 降级均为实时计算
- **可追溯证据**：页脚「实测证据」抽屉列出本项目真实可运行部分的实测记录与来源文件
```

- [ ] **Step 3: 全量回归**

```bash
npm run test:demo
```
Expected: 17 passed。

- [ ] **Step 4: 离线双击验收（人工，必做）**

断开网络，用资源管理器双击 `demo/index.html`。
确认：四段视频都能播；点「开始直播」后能听到声音；六步动线全部可走；浏览器控制台无报错。

- [ ] **Step 5: 确认未越界**

```bash
git diff --stat master -- engine mobile src server playwright.config.ts
```
Expected: 空输出（这些目录一行未动）。

- [ ] **Step 6: 提交**

```bash
git add demo/README.md .gitignore
git -c user.name="wangxz0803-lab" -c user.email="wangxzee@gmail.com" commit -m "docs(demo): sync runbook with competition walkthrough

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## 完成标准

- `npm run test:demo` 全绿（17 项）
- 六张走查截图人工核对通过
- 断网双击 `demo/index.html` 可完整演完六步且有声
- `engine/` `mobile/` `src/` `server/` 与根 `playwright.config.ts` 零改动
- `demo/README.md` 动线与实现一致
