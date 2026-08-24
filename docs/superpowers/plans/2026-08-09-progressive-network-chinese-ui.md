# Progressive Network Reveal and Chinese UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OneLive content-first for Chinese leadership by translating the primary interface and revealing Network Path only when the network story begins.

**Architecture:** Add one Zustand-owned `networkStoryRevealed` state and centralize reveal behavior in existing store actions. `App` conditionally mounts Network Path and changes the control-stage layout; components consume the same domain and director state as before, with Chinese-first display copy only.

**Tech Stack:** React 19, TypeScript strict mode, Zustand, Framer Motion, vanilla CSS, Vitest/Testing Library, Playwright with system Edge.

## Global Constraints

- Keep Connect → Congestion → Latency → Edge → QoD → Business unchanged.
- Preserve Space / Backspace / R / F / E / Q / 1–4 / C / M.
- Keep LIVE / EMULATED provenance visible as `实时 LIVE` / `模拟 EMULATED` where space permits.
- Preserve WebRTC, Provider, Source Tools, Comparison, Business, and Broadcaster behavior.
- No new runtime dependency and no real-time AI, face replacement, voice cloning, or streaming implementation.
- At 1440 × 900, both the content-first and revealed-network states must fit without page scroll.
- Do not commit or push; the user asked to keep the worktree uncommitted for now.

---

## File Map

- `src/store/useOneLiveStore.ts`: single source of truth for network-story visibility and reveal triggers.
- `src/app/App.tsx`: keyboard integration and conditional Network Path mounting.
- `src/features/control-room/TopBar.tsx`: Chinese primary actions and status labels.
- `src/features/control-room/LocalizedStage.tsx`: Chinese stage headings and market labels.
- `src/features/control-room/SourcePanel.tsx`: Chinese source headings, controls, and provenance copy.
- `src/features/control-room/MarketCard.tsx`: Chinese channel states, provenance, and labels.
- `src/features/control-room/DirectorHud.tsx`: Chinese director controls and accessible names.
- `src/features/control-room/NetworkDrawer.tsx`: Chinese network controls and action labels.
- `src/features/control-room/NetworkPath.tsx`: Chinese path labels while retaining technical acronyms.
- `src/features/comparison/ComparisonView.tsx`: Chinese comparison narrative.
- `src/features/business/BusinessView.tsx`: Chinese leadership-facing business close.
- `src/features/broadcast/BroadcasterPage.tsx`: Chinese primary broadcaster actions only.
- `src/styles/four-video-demo.css`: content-first and revealed-network desktop layouts.
- `tests/director.test.ts`: store red/green tests.
- `tests/localized-stage.test.tsx`: Chinese stage copy.
- `tests/comparison-business.test.tsx`: Chinese comparison/business copy.
- `tests/e2e/mock-demo.spec.ts`: reveal/reset/shortcut behavior and accessible names.
- `tests/e2e/visual.spec.ts`: before/after layout and screenshot artifacts.
- `docs/DEMO_RUNBOOK.md`: Chinese action names and progressive reveal script.

---

### Task 1: Store-owned network story state

**Files:**
- Modify: `tests/director.test.ts`
- Modify: `src/store/useOneLiveStore.ts`

**Interfaces:**
- Produces: `networkStoryRevealed: boolean`
- Produces: `revealNetworkStory(): void`
- Existing `reset()` sets `networkStoryRevealed` to `false`.
- Existing `applyDirectorStep`, `setProfile`, `setDeployment`, `toggleDeployment`, `setQod`, and `toggleQod` reveal the network story.

- [ ] **Step 1: Write failing store tests**

Add assertions that initial/reset state is hidden and network/director actions reveal it:

```ts
expect(useOneLiveStore.getState().networkStoryRevealed).toBe(false);
useOneLiveStore.getState().revealNetworkStory();
expect(useOneLiveStore.getState().networkStoryRevealed).toBe(true);
useOneLiveStore.getState().reset();
expect(useOneLiveStore.getState().networkStoryRevealed).toBe(false);

useOneLiveStore.getState().setProfile('congested');
expect(useOneLiveStore.getState().networkStoryRevealed).toBe(true);
```

- [ ] **Step 2: Verify RED**

Run: `npm.cmd run test -- tests/director.test.ts`

Expected: FAIL because `networkStoryRevealed` and `revealNetworkStory` do not exist.

- [ ] **Step 3: Implement minimal store state and atomic actions**

Add the state and action to `OneLiveState`, initialize false, set true inside the existing network/director actions, and reset false inside `reset()`.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd run test -- tests/director.test.ts`

Expected: all director tests PASS.

---

### Task 2: Conditional Network Path reveal

**Files:**
- Modify: `tests/e2e/mock-demo.spec.ts`
- Modify: `tests/e2e/helpers.ts`
- Modify: `src/app/App.tsx`
- Modify: `src/features/control-room/TopBar.tsx`
- Modify: `src/styles/four-video-demo.css`

**Interfaces:**
- Consumes: `networkStoryRevealed`, `revealNetworkStory()` from Task 1.
- Produces: `.app-shell--network-revealed` and conditional `data-testid="network-path"`.

- [ ] **Step 1: Write failing E2E assertions**

```ts
await openReadyDemo(page);
await expect(page.getByTestId('network-path')).toHaveCount(0);
await page.getByRole('button', { name: '开始演示' }).click();
await expect(page.getByTestId('network-path')).toBeVisible();
await page.getByRole('button', { name: '暂停演示' }).click();
await expect(page.getByTestId('network-path')).toBeVisible();
await page.keyboard.press('r');
await expect(page.getByTestId('network-path')).toHaveCount(0);
```

Add separate assertions that Space, `2`, `e`, `q`, and `c` reveal the story.

- [ ] **Step 2: Verify RED**

Run: `npx.cmd playwright test tests/e2e/mock-demo.spec.ts --project=system-msedge`

Expected: FAIL because Network Path is mounted initially and the Chinese button name is absent.

- [ ] **Step 3: Implement conditional mounting and triggers**

In `App`, add the revealed class and render Network Path only when `state.view === 'control' && state.networkStoryRevealed`. Ensure the `c` shortcut calls `revealNetworkStory()` before entering Comparison. Change the TopBar button visible copy and accessible name to `开始演示` / `暂停演示`.

- [ ] **Step 4: Add content-first CSS layout**

Use one app-grid state for no path and the existing path row when revealed. Keep the transition to `opacity`/`transform`, and remove motion under `prefers-reduced-motion`.

- [ ] **Step 5: Verify GREEN**

Run: `npx.cmd playwright test tests/e2e/mock-demo.spec.ts --project=system-msedge`

Expected: all mock-demo cases PASS.

---

### Task 3: Chinese-first control room and provenance

**Files:**
- Modify: `tests/localized-stage.test.tsx`
- Modify: `src/features/control-room/LocalizedStage.tsx`
- Modify: `src/features/control-room/SourcePanel.tsx`
- Modify: `src/features/control-room/MarketCard.tsx`
- Modify: `src/features/control-room/DirectorHud.tsx`
- Modify: `src/features/control-room/NetworkDrawer.tsx`
- Modify: `src/features/control-room/NetworkPath.tsx`

**Interfaces:**
- Display-only copy changes; domain IDs (`japan`, `latam`, `india`) and technical metrics remain unchanged.

- [ ] **Step 1: Write failing component copy tests**

Assert the localized stage contains `本地化市场版本`, `点击查看不同市场版本`, `日本`, `日语`, `拉美`, `西班牙语`, `印度`, and `英语`, and no longer presents the English stage headings.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd run test -- tests/localized-stage.test.tsx`

Expected: FAIL on missing Chinese headings.

- [ ] **Step 3: Translate primary control-room copy**

Translate headings, buttons, state names, warnings, provenance, and accessible names. Retain `5G`, `Edge AI`, `QoD`, `RTT`, `A/V Sync`, language codes, and units. Use `实时 LIVE` only for real runtime sources and `模拟 EMULATED` for profiles and generated metrics.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd run test -- tests/localized-stage.test.tsx`

Expected: localized-stage tests PASS.

---

### Task 4: Chinese Comparison, Business, and Broadcaster close

**Files:**
- Modify: `tests/comparison-business.test.tsx`
- Modify: `src/features/comparison/ComparisonView.tsx`
- Modify: `src/features/business/BusinessView.tsx`
- Modify: `src/features/broadcast/BroadcasterPage.tsx`

**Interfaces:**
- Display-only copy changes; comparison calculations and broadcaster media behavior remain unchanged.

- [ ] **Step 1: Write failing Chinese leadership-copy tests**

Assert Comparison renders `同一市场视频，不同网络体验`, `云端处理 · 普通网络`, and `边缘 AI · QoD 保障`. Assert Business renders `一次录制，三个市场分别开播` and both content/network value headings.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd run test -- tests/comparison-business.test.tsx`

Expected: FAIL on missing Chinese comparison copy.

- [ ] **Step 3: Translate the views and broadcaster primary actions**

Translate leadership-facing labels without changing comparison metrics, media sources, camera permission handling, or start/stop actions.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd run test -- tests/comparison-business.test.tsx`

Expected: comparison/business tests PASS.

---

### Task 5: Visual QA, runbook, and full verification

**Files:**
- Modify: `tests/e2e/visual.spec.ts`
- Modify: `tests/e2e/fallbacks.spec.ts`
- Modify: `docs/DEMO_RUNBOOK.md`
- Update: `artifacts/control-room.png`
- Update: `artifacts/network-degraded.png`
- Update: `artifacts/edge-qod-recovered.png`
- Update: `artifacts/comparison.png`
- Update: `artifacts/business-summary.png`
- Update: `artifacts/mobile-broadcaster.png`

**Interfaces:**
- Visual tests use the same public test IDs and Chinese accessible names introduced above.

- [ ] **Step 1: Update visual tests before CSS/document changes**

Capture `control-room.png` before reveal, then click `开始演示` before network-degraded/recovered captures. Assert Network Path absence/presence and no vertical/horizontal overflow in both states.

- [ ] **Step 2: Verify affected visual tests fail for stale expectations**

Run: `npx.cmd playwright test tests/e2e/visual.spec.ts --project=system-msedge`

Expected: FAIL until helpers and Chinese names are aligned.

- [ ] **Step 3: Update runbook and finish responsive CSS**

Document the spoken pre-generated-sample sentence, Chinese control names, and the content-first → network-reveal sequence. Keep the 2–3 minute timing.

- [ ] **Step 4: Run exact verification commands**

Run sequentially:

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd run test
npm.cmd run test:e2e
git diff --check
```

Expected: lint/build succeed, 7 Vitest files pass, all Playwright tests pass, and `git diff --check` reports no whitespace errors.

- [ ] **Step 5: Inspect visual artifacts**

Compare the before-reveal control room and revealed network screenshots at 1440 × 900. Confirm Chinese copy, full portrait videos, no clipping, no overlap, readable focus states, and a clear change from content story to network story.
