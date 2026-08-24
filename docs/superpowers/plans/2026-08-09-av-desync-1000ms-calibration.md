# 1000ms 音画错位校准 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将导演第 3 步的本地化视频音频延迟从 1500 ms 降到 1000 ms，同时保持第 4 步 100 ms 恢复效果和界面遥测一致。

**Architecture:** 继续由 `localizedAudioDelayMs(profileId, deployment)` 作为单一延迟来源；`MarketCard` 的 Web Audio、`deriveExperience` 的 A/V SYNC 遥测以及测试都消费同一规则。不修改视觉结构或字体。

**Tech Stack:** TypeScript、React、Web Audio API、Vitest、Playwright、系统 Edge。

## Global Constraints

- 第 3 步 `latency + cloud` 必须为 1000 ms。
- 第 4 步 `latency + edge` 必须保持 100 ms。
- 其他网络状态必须保持 0 ms。
- 延迟属于 EMULATED，不得标为 LIVE。
- 保留当前未提交、未合并、未推送状态。

---

### Task 1: 用测试锁定 1000ms 行为

**Files:**
- Modify: `tests/playback.test.ts`
- Modify: `tests/network.test.ts`
- Modify: `tests/localized-stage.test.tsx`
- Modify: `tests/e2e/mock-demo.spec.ts`

**Interfaces:**
- Consumes: `localizedAudioDelayMs(profileId, deployment): number`
- Produces: 第 3 步的单元、组件和浏览器验收期望均为 `1000`。

- [ ] **Step 1: Write the failing tests**

```ts
expect(localizedAudioDelayMs('latency', 'cloud')).toBe(1000);
expect(cloud.avOffsetMs).toBe(1000);
expect(screen.getByTestId('localized-video')).toHaveAttribute('data-audio-delay-ms', '1000');
await expect(page.getByTestId('localized-video')).toHaveAttribute(
  'data-applied-audio-delay-ms',
  '1000',
);
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
npm.cmd test -- --run tests/playback.test.ts tests/network.test.ts tests/localized-stage.test.tsx
```

Expected: FAIL because production still returns `1500`.

---

### Task 2: 修改单一延迟来源并同步演示文档

**Files:**
- Modify: `src/core/playback.ts`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/DEMO_RUNBOOK.md`

**Interfaces:**
- Consumes: `NetworkProfileId` and `DeploymentMode`
- Produces: `localizedAudioDelayMs('latency', 'cloud') === 1000`

- [ ] **Step 1: Write minimal implementation**

```ts
export function localizedAudioDelayMs(
  profileId: NetworkProfileId,
  deployment: DeploymentMode,
): number {
  if (profileId !== 'latency') return 0;
  return deployment === 'edge' ? 100 : 1000;
}
```

- [ ] **Step 2: Update current product documentation**

Replace the current third-step wording with `1000 ms / 1.0 秒`, while keeping Edge recovery at `100 ms` and provenance at `EMULATED`.

- [ ] **Step 3: Run targeted tests to verify GREEN**

Run:

```powershell
npm.cmd test -- --run tests/playback.test.ts tests/network.test.ts tests/localized-stage.test.tsx tests/media-element-audio-delay.test.ts
```

Expected: 19 tests pass.

---

### Task 3: 完整验证真实浏览器参数

**Files:**
- Verify: `src/media/mediaElementAudioDelay.ts`
- Verify: `tests/e2e/mock-demo.spec.ts`

**Interfaces:**
- Consumes: right-side localized `<video>` and Web Audio `DelayNode`
- Produces: 第 3 步实际 `delayTime = 1.0`，第 4 步实际 `delayTime = 0.1`。

- [ ] **Step 1: Run quality gates**

Run:

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd run test
npm.cmd run test:e2e
```

Expected: all commands exit 0; unit/component tests and all Edge E2E tests pass.

- [ ] **Step 2: Inspect real Web Audio state in system Edge**

Play the localized video, enter Director Step 3 and read the live `DelayNode.delayTime.value`; advance to Step 4 and read it again.

Expected:

```json
{
  "cloudSeconds": 1,
  "edgeSeconds": 0.1,
  "contextState": "running"
}
```

- [ ] **Step 3: Preserve worktree state**

Do not stage, commit, merge, push, or delete the current worktree.
