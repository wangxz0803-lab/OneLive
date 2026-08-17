# OneLive A/V Desync Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Step 3 audibly delay localized-video audio by 650 ms, reduce the delay to 100 ms in Step 4, and remove the visible “AI 生成 · 已授权” label.

**Architecture:** A pure playback-state mapper determines the required delay from network profile and deployment. A small Web Audio controller routes the existing localized `<video>` audio through a `DelayNode`, while a React hook owns controller lifetime and updates delay without replacing the media player. Existing network provenance remains internal and visible fallback warnings remain intact.

**Tech Stack:** React 19, TypeScript strict mode, Web Audio API, Vitest, Testing Library, Playwright with system Edge.

## Global Constraints

- Step 3 (`latency` + `cloud`) uses exactly 650 ms of browser audio delay.
- Step 4 (`latency` + `edge`) uses exactly 100 ms of browser audio delay.
- Every other profile/deployment combination uses 0 ms.
- Do not modify or regenerate MP4 assets.
- Do not add runtime dependencies.
- Preserve native video play, pause, seek, volume and fullscreen controls.
- Web Audio setup failure must leave the video usable and must not throw an unhandled rejection.
- Remove the visible localized-media label “AI 生成 · 已授权” from Control Room and Comparison.
- Keep locale badges, original-fallback warnings, `data-provenance="EMULATED"`, LIVE / EMULATED rules, six Director steps and shortcuts.
- Work only in `codex/four-video-demo`; do not commit, push or merge.

---

### Task 1: Deterministic Playback Offset Model

**Files:**
- Create: `src/core/playback.ts`
- Create: `tests/playback.test.ts`

**Interfaces:**
- Consumes: `NetworkProfileId` and `DeploymentMode` from `src/core/types.ts`.
- Produces: `localizedAudioDelayMs(profileId: NetworkProfileId, deployment: DeploymentMode): number`.

- [ ] **Step 1: Write the failing mapping test**

```ts
import { describe, expect, it } from 'vitest';
import { localizedAudioDelayMs } from '@/core/playback';

describe('localized audio playback delay', () => {
  it('makes cloud latency obvious and lets Edge nearly recover sync', () => {
    expect(localizedAudioDelayMs('latency', 'cloud')).toBe(650);
    expect(localizedAudioDelayMs('latency', 'edge')).toBe(100);
  });

  it.each(['premium', 'congested', 'weak'] as const)(
    'keeps %s playback synchronized',
    (profileId) => {
      expect(localizedAudioDelayMs(profileId, 'cloud')).toBe(0);
      expect(localizedAudioDelayMs(profileId, 'edge')).toBe(0);
    },
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm.cmd run test -- tests/playback.test.ts`

Expected: FAIL because `@/core/playback` does not exist.

- [ ] **Step 3: Implement the minimal pure mapper**

```ts
import type { DeploymentMode, NetworkProfileId } from '@/core/types';

export function localizedAudioDelayMs(
  profileId: NetworkProfileId,
  deployment: DeploymentMode,
): number {
  if (profileId !== 'latency') return 0;
  return deployment === 'edge' ? 100 : 650;
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npm.cmd run test -- tests/playback.test.ts`

Expected: 2 tests PASS.

- [ ] **Step 5: Checkpoint without committing**

Run: `git diff --check -- src/core/playback.ts tests/playback.test.ts`

Expected: exit 0. Do not stage or commit.

---

### Task 2: Web Audio Delay Controller and React Lifetime Hook

**Files:**
- Create: `src/media/mediaElementAudioDelay.ts`
- Create: `src/hooks/useMediaElementAudioDelay.ts`
- Create: `tests/media-element-audio-delay.test.ts`

**Interfaces:**
- Consumes: an existing `HTMLMediaElement`, delay in milliseconds, and optionally `() => AudioContext` for tests.
- Produces: `createMediaElementAudioDelay(element, initialDelayMs, createContext?)`, returning `{ setDelay(delayMs), resume(), dispose() } | null`.
- Produces: `useMediaElementAudioDelay(videoRef, delayMs)`, returning an async activation callback for the video `onPlay` event.

- [ ] **Step 1: Write a failing controller test with fake Web Audio nodes**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createMediaElementAudioDelay } from '@/media/mediaElementAudioDelay';

it('routes one media element through a DelayNode and updates its delay', async () => {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const delayTime = { value: 0, setTargetAtTime: vi.fn() };
  const delay = { connect: vi.fn(), disconnect: vi.fn(), delayTime };
  const context = {
    currentTime: 4,
    state: 'suspended',
    destination: {},
    createDelay: vi.fn(() => delay),
    createMediaElementSource: vi.fn(() => source),
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const element = document.createElement('video');

  const controller = createMediaElementAudioDelay(
    element,
    650,
    () => context as unknown as AudioContext,
  );

  expect(controller).not.toBeNull();
  expect(source.connect).toHaveBeenCalledWith(delay);
  expect(delay.connect).toHaveBeenCalledWith(context.destination);
  expect(delayTime.value).toBe(0.65);

  controller?.setDelay(100);
  expect(delayTime.setTargetAtTime).toHaveBeenCalledWith(0.1, 4, 0.08);
  await controller?.resume();
  expect(context.resume).toHaveBeenCalled();
  controller?.dispose();
  expect(context.close).toHaveBeenCalled();
});

it('returns null instead of breaking playback when Web Audio setup fails', () => {
  const controller = createMediaElementAudioDelay(
    document.createElement('video'),
    650,
    () => {
      throw new Error('AudioContext unavailable');
    },
  );
  expect(controller).toBeNull();
});
```

- [ ] **Step 2: Run the controller test and verify RED**

Run: `npm.cmd run test -- tests/media-element-audio-delay.test.ts`

Expected: FAIL because `@/media/mediaElementAudioDelay` does not exist.

- [ ] **Step 3: Implement the controller**

```ts
export interface MediaElementAudioDelayController {
  setDelay: (delayMs: number) => void;
  resume: () => Promise<void>;
  dispose: () => void;
}

type AudioContextFactory = () => AudioContext;

export function createMediaElementAudioDelay(
  element: HTMLMediaElement,
  initialDelayMs: number,
  createContext: AudioContextFactory = () => new AudioContext(),
): MediaElementAudioDelayController | null {
  let context: AudioContext | null = null;
  try {
    context = createContext();
    const delay = context.createDelay(1);
    delay.delayTime.value = initialDelayMs / 1000;
    const source = context.createMediaElementSource(element);
    source.connect(delay);
    delay.connect(context.destination);

    return {
      setDelay(delayMs) {
        delay.delayTime.setTargetAtTime(delayMs / 1000, context!.currentTime, 0.08);
      },
      async resume() {
        if (context?.state === 'suspended') await context.resume();
      },
      dispose() {
        source.disconnect();
        delay.disconnect();
        void context?.close().catch(() => undefined);
        context = null;
      },
    };
  } catch {
    void context?.close().catch(() => undefined);
    return null;
  }
}
```

- [ ] **Step 4: Implement the hook that reuses or replaces controllers safely**

```ts
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import {
  createMediaElementAudioDelay,
  type MediaElementAudioDelayController,
} from '@/media/mediaElementAudioDelay';

export function useMediaElementAudioDelay(
  mediaRef: RefObject<HTMLVideoElement | null>,
  delayMs: number,
): () => Promise<void> {
  const controllerRef = useRef<MediaElementAudioDelayController | null>(null);
  const elementRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    controllerRef.current?.setDelay(delayMs);
  }, [delayMs]);

  useEffect(
    () => () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      elementRef.current = null;
    },
    [],
  );

  return useCallback(async () => {
    const element = mediaRef.current;
    if (!element) return;
    if (elementRef.current !== element) {
      controllerRef.current?.dispose();
      controllerRef.current = createMediaElementAudioDelay(element, delayMs);
      elementRef.current = element;
    }
    await controllerRef.current?.resume().catch(() => undefined);
  }, [delayMs, mediaRef]);
}
```

- [ ] **Step 5: Run the controller test and verify GREEN**

Run: `npm.cmd run test -- tests/media-element-audio-delay.test.ts`

Expected: 2 tests PASS with no unhandled errors.

- [ ] **Step 6: Checkpoint without committing**

Run: `git diff --check -- src/media/mediaElementAudioDelay.ts src/hooks/useMediaElementAudioDelay.ts tests/media-element-audio-delay.test.ts`

Expected: exit 0. Do not stage or commit.

---

### Task 3: Connect Director State to the Localized Video

**Files:**
- Modify: `src/features/control-room/LocalizedStage.tsx`
- Modify: `src/features/control-room/MarketCard.tsx`
- Modify: `src/core/network.ts`
- Modify: `tests/network.test.ts`
- Modify: `tests/localized-stage.test.tsx`
- Modify: `tests/e2e/mock-demo.spec.ts`

**Interfaces:**
- Consumes: `localizedAudioDelayMs(profileId, deployment)` from Task 1.
- Consumes: `useMediaElementAudioDelay(videoRef, delayMs)` from Task 2.
- Produces: `data-audio-delay-ms="0|650|100"` on `data-testid="localized-video"`.
- Produces: matching channel `avOffsetMs` values and warning state: 650 ms/warning in Step 3, 100 ms/no warning in Step 4.

- [ ] **Step 1: Add failing component and E2E assertions**

In `tests/localized-stage.test.tsx`, pass `deployment="cloud"` to `MarketCard` through the rendered stage and assert the localized video exposes `data-audio-delay-ms="650"` for the latency/cloud experience.

In `tests/e2e/mock-demo.spec.ts`, extend the Director flow test:

```ts
await page.keyboard.press('Space'); // Step 2
await page.keyboard.press('Space'); // Step 3
await expect(page.getByTestId('localized-video')).toHaveAttribute('data-audio-delay-ms', '650');
await page.keyboard.press('Space'); // Step 4
await expect(page.getByTestId('localized-video')).toHaveAttribute('data-audio-delay-ms', '100');
await expect(page.getByTestId('av-sync-warning')).toHaveCount(0);
await page.keyboard.press('r');
await expect(page.getByTestId('localized-video')).toHaveAttribute('data-audio-delay-ms', '0');
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm.cmd run test -- tests/localized-stage.test.tsx`

Expected: FAIL because the video has no delay attribute and `MarketCard` has no deployment input.

- [ ] **Step 3: Pass deployment into MarketCard and activate the delay graph**

Update `LocalizedStage` to read `deployment` from the store and pass it to `MarketCard`.

Update `MarketCard` props:

```ts
deployment: DeploymentMode;
```

Then compute and connect the delay:

```ts
const audioDelayMs = localizedAudioDelayMs(profileId, deployment);
const activateAudioDelay = useMediaElementAudioDelay(videoRef, audioDelayMs);
```

Add to the localized video:

```tsx
data-audio-delay-ms={audioDelayMs}
onPlay={() => {
  setActiveRecording('localized');
  void activateAudioDelay();
}}
```

Update `deriveExperience` so `latency` profile channel telemetry uses `localizedAudioDelayMs(profileId, deployment)` directly. Set `syncWarning` from `avOffsetMs > 140`, producing 650 ms/warning for cloud and 100 ms/no warning for Edge.

- [ ] **Step 4: Run component and E2E tests and verify GREEN**

Run: `npm.cmd run test -- tests/localized-stage.test.tsx tests/playback.test.ts tests/media-element-audio-delay.test.ts`

Expected: all targeted tests PASS.

Run: `npx.cmd playwright test tests/e2e/mock-demo.spec.ts --project=system-msedge --grep "runs the six-step director"`

Expected: targeted Edge E2E PASS.

- [ ] **Step 5: Checkpoint without committing**

Run: `git diff --check -- src/features/control-room/LocalizedStage.tsx src/features/control-room/MarketCard.tsx tests/localized-stage.test.tsx tests/e2e/mock-demo.spec.ts`

Expected: exit 0. Do not stage or commit.

---

### Task 4: Remove the Visible Localized Provenance Label

**Files:**
- Modify: `src/config/demoMedia.ts`
- Modify: `src/features/control-room/MarketCard.tsx`
- Modify: `src/features/comparison/ComparisonView.tsx`
- Modify: `tests/markets.test.ts`
- Modify: `tests/localized-stage.test.tsx`
- Modify: `tests/comparison-business.test.tsx`
- Modify: `tests/e2e/mock-demo.spec.ts`

**Interfaces:**
- Removes: `LocalizedDemoMedia.provenanceLabel`.
- Preserves: `OriginalDemoMedia.provenanceLabel`, locale badges and explicit fallback text.

- [ ] **Step 1: Change tests first to require the label to be absent**

```ts
expect(screen.queryByText('AI 生成 · 已授权')).not.toBeInTheDocument();
expect(screen.getByText('ja-JP')).toBeInTheDocument();
```

Remove the localized `provenanceLabel` expectation from `tests/markets.test.ts`. Add E2E assertions that Control Room and Comparison contain zero instances of the label.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm.cmd run test -- tests/localized-stage.test.tsx tests/comparison-business.test.tsx tests/markets.test.ts`

Expected: FAIL because the visible label is still rendered.

- [ ] **Step 3: Remove the localized label from types, data and renderers**

Delete `provenanceLabel` from `LocalizedDemoMedia` and each localized media entry.

Render only the locale badge in `MarketCard`:

```tsx
<div className="recording-badges">
  {usingFallback && <span>原片回退 · 模拟 EMULATED</span>}
  <span>{media.locale}</span>
</div>
```

Render only fallback and market/locale badges in `ComparisonView`:

```tsx
<div className="recording-badges">
  {usingFallback && <span>原片回退 · 模拟 EMULATED</span>}
  <span>{market.market} · {market.locale}</span>
</div>
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm.cmd run test -- tests/localized-stage.test.tsx tests/comparison-business.test.tsx tests/markets.test.ts`

Expected: all targeted tests PASS.

- [ ] **Step 5: Checkpoint without committing**

Run: `git diff --check -- src/config/demoMedia.ts src/features/control-room/MarketCard.tsx src/features/comparison/ComparisonView.tsx tests/markets.test.ts tests/localized-stage.test.tsx tests/comparison-business.test.tsx tests/e2e/mock-demo.spec.ts`

Expected: exit 0. Do not stage or commit.

---

### Task 5: Documentation, Full Verification and Manual Audio Check

**Files:**
- Modify: `docs/DECISIONS.md`
- Modify: `docs/DEMO_RUNBOOK.md`
- Update through Playwright: `artifacts/control-room.png`
- Update through Playwright: `artifacts/network-degraded.png`
- Update through Playwright: `artifacts/edge-qod-recovered.png`
- Update through Playwright: `artifacts/comparison.png`

**Interfaces:**
- Documents the visible 650 ms and 100 ms browser delay as EMULATED.
- Removes documentation that instructs the presenter to point out the deleted label.

- [ ] **Step 1: Update truth-boundary documentation**

In `docs/DECISIONS.md`, update D-014 so localized media is identified by market/locale rather than the deleted badge, and add that Step 3/4 use browser Web Audio delay for a visible EMULATED A/V offset.

In `docs/DEMO_RUNBOOK.md`, remove “本地化成片显示‘AI 生成 · 已授权’” and tell the presenter to listen for 650 ms delay in Step 3 and near-sync 100 ms delay in Step 4.

- [ ] **Step 2: Run exact full verification**

Run:

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd run test
npm.cmd run test:e2e
git diff --check
```

Expected: lint/build exit 0, every Vitest and Playwright test passes, diff check exits 0.

- [ ] **Step 3: Inspect fresh visual artifacts**

Inspect 1440 × 900 Control Room, degraded, Edge recovery and Comparison screenshots. Confirm locale badges remain legible, the removed label leaves no awkward empty badge, Network Path remains within the first frame, and no content overlaps.

- [ ] **Step 4: Manually verify audible delay in Edge**

Start `npm.cmd run demo:mock`, open the localized video in system Edge, play it once, advance to Step 3 and confirm speech is roughly 650 ms behind mouth movement. Advance to Step 4 and confirm the delay becomes difficult to notice at roughly 100 ms. Confirm play/pause/seek/volume remain functional and the console has no errors.

- [ ] **Step 5: Preserve the branch without committing**

Run: `git status --short` and `git branch --show-current`.

Expected: branch is `codex/four-video-demo`; worktree contains the intended unstaged changes. Do not commit, push, merge or remove the worktree.
