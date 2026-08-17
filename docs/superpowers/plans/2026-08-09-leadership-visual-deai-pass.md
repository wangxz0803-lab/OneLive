# OneLive 领导演示版轻量去 AI 味 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变双视频结构、六步导演流程和 LIVE / EMULATED 真实性模型的前提下，减少微型等宽字、重复 provenance、内层描边和模板化对比页装饰。

**Architecture:** 继续使用现有 React 组件和原生 CSS。可见文案由现有组件精简，字体和表面通过 `index.css` 与 `four-video-demo.css` 的现有选择器调整；不增加运行时依赖，不改变领域状态、媒体播放或网络模型。

**Tech Stack:** React 19、TypeScript、原生 CSS、Vitest、Testing Library、Playwright、系统 Edge。

## Global Constraints

- 保留左侧原始录屏、右侧当前市场视频和三市场点击切换。
- 保留 Connect → Congestion → Latency → Edge → QoD → Business 六步与既有快捷键。
- 1000 ms / 100 ms 音画延迟逻辑不变。
- 保留全局和混合来源区域的 LIVE / EMULATED 标签；只删除重复展示。
- 常规中文正文/关键状态不小于 13px，辅助标签不小于 11px。
- 等宽字体仅用于数值、locale 和 timecode。
- 1440 × 900 不产生页面纵向滚动；390 × 844 不产生横向溢出。
- 不添加依赖，不 stage、commit、merge、push 或删除当前 worktree。

---

### Task 1: 用测试锁定领导版信息层级

**Files:**
- Create: `tests/leadership-visual-system.test.ts`
- Modify: `tests/localized-stage.test.tsx`
- Modify: `tests/comparison-business.test.tsx`
- Modify: `tests/e2e/mock-demo.spec.ts`

**Interfaces:**
- Consumes: `LocalizedStage`, `ComparisonView`, rendered CSS selectors.
- Produces: 精简 provenance、三项对比摘要和字体 token 的回归约束。

- [ ] **Step 1: Write failing component tests**

```tsx
expect(screen.getByText('3 个市场')).toBeInTheDocument();
expect(screen.queryByText(/03 个市场 · 模拟 EMULATED/)).not.toBeInTheDocument();
expect(screen.getByTestId('channel-card-japan')).toHaveAttribute(
  'data-provenance',
  'EMULATED',
);
expect(screen.queryByText(/模拟 EMULATED/)).not.toBeInTheDocument();

expect(screen.getByText('边缘保障后')).toBeInTheDocument();
expect(screen.getByText('核心体验恢复')).toBeInTheDocument();
expect(screen.getAllByTestId('comparison-delta')).toHaveLength(3);
```

- [ ] **Step 2: Write failing CSS contract test**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const baseCss = readFileSync('src/styles/index.css', 'utf8');
const demoCss = readFileSync('src/styles/four-video-demo.css', 'utf8');

describe('leadership visual system', () => {
  it('separates interface typography from data typography', () => {
    expect(baseCss).toContain('--font-ui:');
    expect(baseCss).toContain('--font-data:');
    expect(demoCss).toMatch(/\.source-telemetry strong\s*\{[^}]*var\(--font-data\)/s);
    expect(demoCss).toMatch(/\.source-telemetry span,[^}]*var\(--font-ui\)/s);
  });

  it('removes the generic highlight layer from top-level panels', () => {
    expect(baseCss).toMatch(/\.panel::after\s*\{[^}]*display:\s*none/s);
  });
});
```

- [ ] **Step 3: Add browser-level assertions**

```ts
await expect(page.getByTestId('source-panel')).not.toContainText('模拟 EMULATED');
await expect(page.getByTestId('channel-grid')).not.toContainText('模拟 EMULATED');
await expect(page.getByRole('group', { name: '系统状态' })).toContainText(
  '本地素材 · 模拟 EMULATED',
);

const kickerStyle = await page.getByText('原始内容输入').evaluate((element) => {
  const style = getComputedStyle(element);
  return { fontFamily: style.fontFamily, fontSize: Number.parseFloat(style.fontSize) };
});
expect(kickerStyle.fontFamily.toLowerCase()).not.toContain('consolas');
expect(kickerStyle.fontSize).toBeGreaterThanOrEqual(11);
```

- [ ] **Step 4: Run RED**

Run:

```powershell
npm.cmd test -- --run tests/leadership-visual-system.test.ts tests/localized-stage.test.tsx tests/comparison-business.test.tsx
```

Expected: FAIL because current UI still repeats `模拟 EMULATED`, renders five deltas, and lacks `--font-ui` / `--font-data`.

---

### Task 2: 精简重复 provenance 和对比页结论

**Files:**
- Modify: `src/features/control-room/SourcePanel.tsx`
- Modify: `src/features/control-room/LocalizedStage.tsx`
- Modify: `src/features/control-room/MarketCard.tsx`
- Modify: `src/features/comparison/ComparisonView.tsx`

**Interfaces:**
- Consumes: existing store/network data and `data-provenance="EMULATED"`.
- Produces: 一处全局 provenance、必要回退 provenance、三项对比结果摘要。

- [ ] **Step 1: Remove repeated mock provenance from source details**

```tsx
const sourceStatus =
  sourceKind === 'phone'
    ? remoteReady
      ? 'WEBRTC 已连接 · 实时 LIVE'
      : broadcasterPresent && realtime.joined
        ? '手机已加入 · 实时 LIVE'
        : '等待手机连接'
    : sourceKind === 'local-camera'
      ? liveInput
        ? '摄像头已连接 · 实时 LIVE'
        : '摄像头不可用'
      : broadcasterPresent && realtime.joined
        ? '演示素材 · 手机在线 LIVE'
        : '演示素材就绪';

<small>{liveBitrate == null ? '网络配置' : '实时 LIVE'}</small>
<small>{liveInput ? '实时 LIVE' : '演示采集'}</small>
<small>{liveInput ? '实时 LIVE' : '本地素材'}</small>
```

Keep the top-bar `本地素材 · 模拟 EMULATED` unchanged.

- [ ] **Step 2: Simplify market metadata without changing provenance data**

```tsx
<span className="localized-stage__count">3 个市场</span>

data-provenance="EMULATED"

<div className="audience">
  <Icon name="users" size={13} />
  <span>{channel.viewers.toLocaleString('en-US')}</span>
</div>
```

Keep fallback copy `原片回退 · 模拟 EMULATED` unchanged.

- [ ] **Step 3: Reduce comparison metrics to the three perceptual outcomes**

```tsx
const metrics = [
  { label: '端到端时延', left: `${cloud.e2eLatencyMs} ms`, right: `${edge.e2eLatencyMs} ms`, delta: `−${cloud.e2eLatencyMs - edge.e2eLatencyMs} ms` },
  { label: '视频帧率', left: `${cloud.averageFps} fps`, right: `${edge.averageFps} fps`, delta: `+${edge.averageFps - cloud.averageFps} fps` },
  { label: '音画偏移', left: `${cloud.avOffsetMs} ms`, right: `${edge.avOffsetMs} ms`, delta: `−${cloud.avOffsetMs - edge.avOffsetMs} ms` },
];

<aside className="delta-spine" aria-label="体验改善摘要">
  <header>
    <span>改善结果</span>
    <strong>边缘保障后</strong>
    <small>核心体验恢复</small>
  </header>
  <div className="delta-list">
    {metrics.map((metric) => (
      <div key={metric.label} data-testid="comparison-delta">
        <span>{metric.label}</span>
        <small>{metric.left} → {metric.right}</small>
        <strong>{metric.delta}</strong>
      </div>
    ))}
  </div>
  <footer><Icon name="arrow" /><span>关键体验已恢复</span></footer>
</aside>
```

- [ ] **Step 4: Run component tests**

Run:

```powershell
npm.cmd test -- --run tests/localized-stage.test.tsx tests/comparison-business.test.tsx
```

Expected: component copy tests pass; CSS contract still fails until Task 3.

---

### Task 3: 调整字体、表面和对比页视觉层级

**Files:**
- Modify: `src/styles/index.css`
- Modify: `src/styles/four-video-demo.css`

**Interfaces:**
- Consumes: existing class names; no component API changes.
- Produces: `--font-ui`, `--font-data`, larger readable labels, fewer borders/glows, open comparison summary.

- [ ] **Step 1: Add offline-safe font roles**

```css
:root {
  --font-ui: 'Segoe UI Variable Text', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', sans-serif;
  --font-data: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-family: var(--font-ui);
}

.section-kicker {
  font: 600 11px/1.25 var(--font-ui);
  letter-spacing: 0.04em;
}
```

- [ ] **Step 2: Quiet top-level and inner surfaces**

```css
.panel {
  background: rgba(12, 18, 26, 0.98);
  box-shadow: 0 12px 34px rgba(1, 6, 12, 0.16);
}
.panel::after { display: none; }

.source-telemetry {
  border: 0;
  border-top: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
}
```

- [ ] **Step 3: Apply typography by meaning**

```css
.source-telemetry span,
.source-telemetry small,
.market-tab strong,
.market-tab small,
.channel-metric span,
.platform-signature,
.audience,
.director-hud__copy,
.scenario-state,
.comparison-channel-rail strong {
  font-family: var(--font-ui);
}

.source-telemetry strong,
.channel-metric strong,
.recording-badges,
.scenario-timecode,
.delta-list small,
.delta-list strong {
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
}
```

Raise auxiliary labels to `11px` and key state/body text to `13px`; keep only compact numeric path data at `10px`.

- [ ] **Step 4: Reduce decorative market and path effects**

```css
.market-tab { --tab-accent: var(--cyan); border-color: transparent; box-shadow: inset 0 -1px var(--line); }
.market-tab--violet,
.market-tab--amber,
.market-tab--teal { --tab-accent: var(--cyan); }
.market-tab > i { box-shadow: none; }
.path-line--energy { filter: none; }
.path-node { border: 0; box-shadow: none; background: rgba(9, 15, 22, 0.76); }
.director-hud { border-color: var(--line-strong); box-shadow: 0 12px 36px rgba(0, 0, 0, 0.3); }
```

- [ ] **Step 5: Open up the comparison summary**

```css
.comparison-grid { grid-template-columns: minmax(0, 1fr) 156px minmax(0, 1fr); }
.delta-spine {
  border: 0;
  border-inline: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  grid-template-rows: 72px minmax(0, 1fr) 44px;
}
.delta-list { grid-template-rows: repeat(3, 1fr); }
.comparison-channel-rail div { border: 0; border-top: 1px solid var(--line); border-radius: 0; background: transparent; }
```

- [ ] **Step 6: Run CSS and component GREEN**

Run:

```powershell
npm.cmd test -- --run tests/leadership-visual-system.test.ts tests/localized-stage.test.tsx tests/comparison-business.test.tsx
```

Expected: all targeted tests pass.

---

### Task 4: 验证六步演示和视觉结果

**Files:**
- Modify: `tests/e2e/mock-demo.spec.ts`
- Verify: `tests/e2e/visual.spec.ts`
- Create: `artifacts/leadership-visual-pass/01-control-room.png`
- Create: `artifacts/leadership-visual-pass/02-high-latency.png`
- Create: `artifacts/leadership-visual-pass/03-comparison.png`

**Interfaces:**
- Consumes: current preview on system Edge.
- Produces: automated layout evidence and inspected before/after screenshots.

- [ ] **Step 1: Run full quality gates**

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd run test
npm.cmd run test:e2e
```

Expected: lint/build exit 0, 46+ unit/component tests pass, 15 Edge E2E tests pass.

- [ ] **Step 2: Capture the three accepted audit states at 1440 × 900**

Use system Edge with `?mock=1&skipIntro=1&session=LEADERSHIP-VISUAL` and capture:

1. Initial control room.
2. Director Step 3 high latency with `A/V SYNC 1000 ms`.
3. Comparison view with the open three-metric summary.

- [ ] **Step 3: Inspect screenshots**

Confirm:

- videos remain dominant;
- no clipped labels or page scroll;
- initial control and localized panels do not repeat `模拟 EMULATED`;
- common Chinese labels are visibly sans-serif and at least 11px;
- comparison summary is readable without inspecting five tiny rows;
- orange warnings, cyan primary and violet Edge semantics remain distinguishable.

- [ ] **Step 4: Preserve branch state**

Keep `codex/four-video-demo` and its worktree unchanged at the git integration level: no stage, commit, merge, push, or cleanup.
