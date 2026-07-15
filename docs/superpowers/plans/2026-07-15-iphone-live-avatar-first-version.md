# OneLive iPhone Live Avatar First Version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real iPhone-to-desktop facial-performance loop that drives three market-specific avatars, exposes honest WebRTC telemetry, and visibly responds to network, Edge, and QoD controls without requiring a discrete GPU.

**Architecture:** Keep the existing WebRTC media and Socket.IO session path. Add a validated, rate-limited `AvatarPoseFrame` side channel, run MediaPipe Face Landmarker locally on the iPhone, pass frames through deterministic per-market experience queues, and render locally bundled 2.5D portrait avatars with lightweight CSS/Canvas motion. Preserve SeededPoseProvider and the six-step Mock Demo as the unconditional fallback.

**Tech Stack:** React 19, TypeScript strict, Vite, Zustand, Socket.IO, WebRTC, `@mediapipe/tasks-vision`, CSS transforms/Canvas, Vitest, Testing Library, Playwright.

---

## File map

- `src/core/types.ts`: canonical pose, casting, and telemetry domain types.
- `src/features/tracking/pose-frame.ts`: MediaPipe result normalization with no React or transport dependency.
- `src/realtime/avatar-pose.ts`: shared envelope validation and size/range guards.
- `src/realtime/protocol.ts`: typed Socket.IO pose events and per-socket sequence state.
- `server/signaling.ts`: role-checked, rate-limited pose relay.
- `src/core/pose-experience.ts`: deterministic delay/jitter/loss policy and bounded delivery buffer.
- `src/features/tracking/mediapipe-face-tracker.ts`: optional MediaPipe adapter with local assets and explicit fallback result.
- `src/features/tracking/useFaceTracking.ts`: lifecycle, adaptive sampling, and cleanup for a live `<video>`.
- `src/realtime/stats.ts`: direction-aware WebRTC stats parser/collector.
- `src/realtime/useBroadcasterPeer.ts`: outbound stats callback from the active sender peer.
- `src/realtime/usePoseReceiver.ts`: receive validated pose frames on the control socket.
- `src/hooks/useDeliveredPose.ts`: React bridge from raw pose to a market-specific bounded queue.
- `src/config/avatars.ts`: market/gender/wardrobe asset manifest.
- `src/features/avatars/AvatarStage.tsx`: 2.5D portrait renderer; no network math.
- `src/features/avatars/AvatarCastingControls.tsx`: accessible gender and wardrobe selection.
- `src/store/useOneLiveStore.ts`: raw live pose, tracking provenance, gender, and wardrobe state.
- `src/features/broadcast/BroadcasterPage.tsx`: iPhone face tracking, pose emit, and LIVE uplink telemetry.
- `src/features/control-room/SourcePanel.tsx`: pose receive and source telemetry.
- `src/features/control-room/MarketCard.tsx`: consumes one delivered pose and selected avatar variant.
- `src/app/App.tsx`: supplies deployment/profile/channel inputs to cards.
- `src/styles/index.css`: portrait stage, casting controls, tracking HUD, mobile telemetry, responsive states.
- `public/mediapipe/wasm/*`, `public/models/face_landmarker.task`: runtime-local MediaPipe assets.
- `public/avatars/*.png`: twelve market/gender/wardrobe portrait variants generated as local assets.
- `tests/*.test.ts`: pure domain, protocol, queue, stats, config, and fallback tests.
- `tests/e2e/live-avatar.spec.ts`: observable three-avatar response, casting, degraded/recovered pose, and mobile layout.

### Task 1: Canonical avatar pose mapping

**Files:**
- Modify: `src/core/types.ts`
- Create: `src/features/tracking/pose-frame.ts`
- Test: `tests/pose-frame.test.ts`

- [ ] **Step 1: Write the failing pose normalization tests**

```ts
import { describe, expect, it } from 'vitest';
import { createNeutralPose, mapFaceResultToPose } from '../src/features/tracking/pose-frame';

describe('mapFaceResultToPose', () => {
  it('maps and clamps live blendshapes', () => {
    const pose = mapFaceResultToPose({
      sequence: 7,
      capturedAt: 1_000,
      trackingFps: 14,
      categories: [
        { categoryName: 'eyeBlinkLeft', score: 0.75 },
        { categoryName: 'eyeBlinkRight', score: 1.4 },
        { categoryName: 'jawOpen', score: 0.62 },
        { categoryName: 'mouthSmileLeft', score: 0.8 },
        { categoryName: 'mouthSmileRight', score: 0.4 },
      ],
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      audioLevel: 0.2,
    });
    expect(pose).toMatchObject({ schemaVersion: 1, sequence: 7, provenance: 'LIVE' });
    expect(pose.blinkLeft).toBeCloseTo(0.75);
    expect(pose.blinkRight).toBe(1);
    expect(pose.jawOpen).toBeCloseTo(0.62);
    expect(pose.mouthSmile).toBeCloseTo(0.6);
  });

  it('returns an emulated neutral frame when no face exists', () => {
    expect(createNeutralPose(9, 2_000, 'Face not detected')).toMatchObject({
      sequence: 9,
      facePresent: false,
      provenance: 'EMULATED',
      fallbackReason: 'Face not detected',
    });
  });
});
```

- [ ] **Step 2: Run the test and observe the missing module failure**

Run: `npm run test -- tests/pose-frame.test.ts`  
Expected: FAIL with `Cannot find module '../src/features/tracking/pose-frame'`.

- [ ] **Step 3: Add the domain type and pure mapper**

```ts
// src/core/types.ts
export interface AvatarPoseFrame {
  schemaVersion: 1;
  sequence: number;
  capturedAt: number;
  headYaw: number;
  headPitch: number;
  headRoll: number;
  blinkLeft: number;
  blinkRight: number;
  jawOpen: number;
  mouthSmile: number;
  mouthPucker: number;
  browUp: number;
  eyeLookX: number;
  eyeLookY: number;
  audioLevel: number;
  facePresent: boolean;
  trackingFps: number;
  provenance: Provenance;
  fallbackReason?: string;
}

export type AvatarGender = 'female' | 'male';
export type AvatarWardrobe = 'studio' | 'executive';
```

```ts
// src/features/tracking/pose-frame.ts
import type { AvatarPoseFrame } from '@/core/types';

export interface BlendshapeCategory { categoryName: string; score: number }
const clamp01 = (value = 0) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const clampSigned = (value = 0) => Math.min(1, Math.max(-1, Number.isFinite(value) ? value : 0));

export function createNeutralPose(sequence: number, capturedAt: number, fallbackReason?: string): AvatarPoseFrame {
  return {
    schemaVersion: 1, sequence, capturedAt, headYaw: 0, headPitch: 0, headRoll: 0,
    blinkLeft: 0, blinkRight: 0, jawOpen: 0, mouthSmile: 0, mouthPucker: 0,
    browUp: 0, eyeLookX: 0, eyeLookY: 0, audioLevel: 0, facePresent: false,
    trackingFps: 0, provenance: 'EMULATED', ...(fallbackReason ? { fallbackReason } : {}),
  };
}

export function mapFaceResultToPose(input: {
  sequence: number; capturedAt: number; trackingFps: number;
  categories: BlendshapeCategory[]; matrix?: number[]; audioLevel?: number;
}): AvatarPoseFrame {
  const scores = new Map(input.categories.map(({ categoryName, score }) => [categoryName, clamp01(score)]));
  const score = (name: string) => scores.get(name) ?? 0;
  const matrix = input.matrix ?? [];
  return {
    ...createNeutralPose(input.sequence, input.capturedAt),
    headYaw: clampSigned(Math.atan2(matrix[8] ?? 0, matrix[10] ?? 1) / 0.7),
    headPitch: clampSigned(Math.atan2(-(matrix[9] ?? 0), Math.hypot(matrix[8] ?? 0, matrix[10] ?? 1)) / 0.55),
    headRoll: clampSigned(Math.atan2(matrix[4] ?? 0, matrix[0] ?? 1) / 0.55),
    blinkLeft: score('eyeBlinkLeft'), blinkRight: score('eyeBlinkRight'),
    jawOpen: score('jawOpen'),
    mouthSmile: (score('mouthSmileLeft') + score('mouthSmileRight')) / 2,
    mouthPucker: score('mouthPucker'),
    browUp: Math.max(score('browInnerUp'), score('browOuterUpLeft'), score('browOuterUpRight')),
    eyeLookX: clampSigned(score('eyeLookOutRight') - score('eyeLookOutLeft')),
    eyeLookY: clampSigned(score('eyeLookDownLeft') - score('eyeLookUpLeft')),
    audioLevel: clamp01(input.audioLevel), facePresent: true,
    trackingFps: Math.max(0, Math.min(60, input.trackingFps)), provenance: 'LIVE',
    fallbackReason: undefined,
  };
}
```

- [ ] **Step 4: Run the focused test and the existing suite**

Run: `npm run test -- tests/pose-frame.test.ts && npm run test`  
Expected: the focused file and all existing tests PASS.

- [ ] **Step 5: Commit the pose model**

```bash
git add src/core/types.ts src/features/tracking/pose-frame.ts tests/pose-frame.test.ts
git commit -m "feat: define normalized live avatar pose"
```

### Task 2: Validated Socket.IO pose relay

**Files:**
- Create: `src/realtime/avatar-pose.ts`
- Modify: `src/realtime/protocol.ts`
- Modify: `server/signaling.ts`
- Test: `tests/avatar-pose-protocol.test.ts`

- [ ] **Step 1: Write failing validation tests**

```ts
import { describe, expect, it } from 'vitest';
import { createNeutralPose } from '../src/features/tracking/pose-frame';
import { validateAvatarPoseEnvelope } from '../src/realtime/avatar-pose';

describe('avatar pose protocol', () => {
  const valid = { sessionId: 'ONE-DEMO', pose: { ...createNeutralPose(2, 1_000), provenance: 'LIVE' as const } };
  it('accepts a bounded schema-v1 frame', () => expect(validateAvatarPoseEnvelope(valid, 1)).toEqual({ ok: true }));
  it('rejects replayed sequences', () => expect(validateAvatarPoseEnvelope(valid, 2)).toMatchObject({ ok: false, reason: 'STALE_SEQUENCE' }));
  it('rejects out-of-range values', () => expect(validateAvatarPoseEnvelope({ ...valid, pose: { ...valid.pose, jawOpen: 9 } }, 1)).toMatchObject({ ok: false, reason: 'INVALID_RANGE' }));
});
```

- [ ] **Step 2: Run and observe the missing validator failure**

Run: `npm run test -- tests/avatar-pose-protocol.test.ts`  
Expected: FAIL because `avatar-pose.ts` does not exist.

- [ ] **Step 3: Implement envelope validation and typed events**

```ts
// src/realtime/avatar-pose.ts
import type { AvatarPoseFrame } from '@/core/types';
import { SESSION_ID_PATTERN, type AvatarPoseEnvelope } from './protocol';

const unit = ['blinkLeft','blinkRight','jawOpen','mouthSmile','mouthPucker','browUp','audioLevel'] as const;
const signed = ['headYaw','headPitch','headRoll','eyeLookX','eyeLookY'] as const;

export function validateAvatarPoseEnvelope(payload: unknown, lastSequence = -1): { ok: true } | { ok: false; reason: string } {
  const envelope = payload as AvatarPoseEnvelope;
  const pose = envelope?.pose as AvatarPoseFrame;
  if (!envelope || !SESSION_ID_PATTERN.test(envelope.sessionId ?? '') || pose?.schemaVersion !== 1) return { ok: false, reason: 'INVALID_SCHEMA' };
  if (!Number.isSafeInteger(pose.sequence) || pose.sequence <= lastSequence) return { ok: false, reason: 'STALE_SEQUENCE' };
  if (!Number.isFinite(pose.capturedAt) || !Number.isFinite(pose.trackingFps) || JSON.stringify(envelope).length > 2_048) return { ok: false, reason: 'INVALID_SIZE' };
  if (unit.some((key) => !Number.isFinite(pose[key]) || pose[key] < 0 || pose[key] > 1) || signed.some((key) => !Number.isFinite(pose[key]) || pose[key] < -1 || pose[key] > 1)) return { ok: false, reason: 'INVALID_RANGE' };
  if (pose.provenance !== 'LIVE' && pose.provenance !== 'EMULATED') return { ok: false, reason: 'INVALID_PROVENANCE' };
  return { ok: true };
}
```

```ts
// additions to src/realtime/protocol.ts
export interface AvatarPoseEnvelope { sessionId: string; pose: AvatarPoseFrame }
// ClientToServerEvents: 'avatar:pose': (payload: AvatarPoseEnvelope) => void;
// ServerToClientEvents: 'avatar:pose': (payload: AvatarPoseEnvelope) => void;
// SocketData: lastPoseSequence?: number; lastPoseAt?: number;
```

In `server/signaling.ts`, accept only broadcaster members, enforce at most one relay per 40 ms, validate against `socket.data.lastPoseSequence`, update sequence/time, and emit to the session room excluding the sender. Invalid frames use the existing safe `INVALID_MESSAGE` response.

```ts
socket.on('avatar:pose', (payload) => {
  if (!requireMembership(socket, payload?.sessionId, ['broadcaster'])) return;
  const now = Date.now();
  if (now - (socket.data.lastPoseAt ?? 0) < 40) return;
  const validation = validateAvatarPoseEnvelope(payload, socket.data.lastPoseSequence ?? -1);
  if (!validation.ok) {
    invalid(socket, `Invalid avatar pose: ${validation.reason}.`);
    return;
  }
  socket.data.lastPoseAt = now;
  socket.data.lastPoseSequence = payload.pose.sequence;
  socket.to(payload.sessionId).emit('avatar:pose', payload);
});
```

- [ ] **Step 4: Run protocol and full tests**

Run: `npm run test -- tests/avatar-pose-protocol.test.ts && npm run test`  
Expected: all tests PASS.

- [ ] **Step 5: Commit the transport contract**

```bash
git add src/realtime/avatar-pose.ts src/realtime/protocol.ts server/signaling.ts tests/avatar-pose-protocol.test.ts
git commit -m "feat: relay validated live avatar pose"
```

### Task 3: Deterministic pose experience queue

**Files:**
- Create: `src/core/pose-experience.ts`
- Create: `src/hooks/useDeliveredPose.ts`
- Test: `tests/pose-experience.test.ts`

- [ ] **Step 1: Write failing policy and bounded-buffer tests**

```ts
import { describe, expect, it } from 'vitest';
import { createNeutralPose } from '../src/features/tracking/pose-frame';
import { PoseDeliveryBuffer, derivePosePolicy } from '../src/core/pose-experience';

describe('pose experience', () => {
  it('makes edge faster than cloud and QoD favors priority one', () => {
    const cloud = derivePosePolicy({ profileId: 'congested', deployment: 'cloud', qod: false, priority: 1 });
    const edge = derivePosePolicy({ profileId: 'congested', deployment: 'edge', qod: false, priority: 1 });
    const protectedMain = derivePosePolicy({ profileId: 'congested', deployment: 'edge', qod: true, priority: 1 });
    const protectedThird = derivePosePolicy({ profileId: 'congested', deployment: 'edge', qod: true, priority: 3 });
    expect(edge.delayMs).toBeLessThan(cloud.delayMs);
    expect(protectedMain.lossPct).toBeLessThan(protectedThird.lossPct);
  });

  it('delivers the newest due frame and never grows beyond twelve frames', () => {
    const buffer = new PoseDeliveryBuffer();
    const policy = { delayMs: 100, jitterMs: 0, lossPct: 0, maxAgeMs: 1_000 };
    for (let sequence = 1; sequence <= 20; sequence += 1) buffer.push(createNeutralPose(sequence, sequence), policy, 0);
    expect(buffer.size).toBe(12);
    expect(buffer.take(100)?.sequence).toBe(20);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/pose-experience.test.ts`  
Expected: FAIL because `pose-experience.ts` is missing.

- [ ] **Step 3: Implement pure policy and bounded queue**

```ts
// src/core/pose-experience.ts
import { NETWORK_PROFILES, getProcessingLatency } from './network';
import type { AvatarPoseFrame, DeploymentMode, NetworkProfileId } from './types';

export interface PoseDeliveryPolicy { delayMs: number; jitterMs: number; lossPct: number; maxAgeMs: number }
export function derivePosePolicy(input: { profileId: NetworkProfileId; deployment: DeploymentMode; qod: boolean; priority: 1 | 2 | 3 }): PoseDeliveryPolicy {
  const network = NETWORK_PROFILES[input.profileId];
  const processing = getProcessingLatency(input.deployment);
  const qodLossFactor = input.qod ? (input.priority === 1 ? 0.16 : input.priority === 2 ? 0.62 : 0.9) : 1;
  return {
    delayMs: Math.round(network.rttMs * (input.deployment === 'edge' ? 0.45 : 0.8) + processing.poseMs + (input.qod && input.priority === 1 ? -25 : input.priority * 12)),
    jitterMs: Math.round(network.jitterMs * (input.qod && input.priority === 1 ? 0.35 : 1)),
    lossPct: Math.min(60, network.lossPct * qodLossFactor + (input.priority - 1) * (input.qod ? 1.2 : 0.4)),
    maxAgeMs: input.profileId === 'latency' ? 1_800 : 900,
  };
}

const noise = (sequence: number) => ((sequence * 9301 + 49297) % 233280) / 233280;
export class PoseDeliveryBuffer {
  private queue: Array<{ frame: AvatarPoseFrame; dueAt: number; expiresAt: number }> = [];
  get size() { return this.queue.length; }
  clear() { this.queue = []; }
  push(frame: AvatarPoseFrame, policy: PoseDeliveryPolicy, now = performance.now()) {
    if (noise(frame.sequence) * 100 < policy.lossPct) return false;
    const jitter = (noise(frame.sequence + 17) * 2 - 1) * policy.jitterMs;
    this.queue.push({
      frame,
      dueAt: now + Math.max(0, policy.delayMs + jitter),
      expiresAt: now + policy.maxAgeMs,
    });
    this.queue = this.queue.slice(-12);
    return true;
  }
  take(now = performance.now()) {
    const due = this.queue.filter((entry) => entry.dueAt <= now && entry.expiresAt >= now);
    this.queue = this.queue.filter((entry) => entry.dueAt > now);
    return due.at(-1)?.frame;
  }
}
```

`useDeliveredPose.ts` owns one buffer per mounted market, pushes when the raw frame/policy changes, polls with `requestAnimationFrame`, and clears on unmount/profile reset. It returns the last delivered frame and queue age; it does not mutate the global store.

```ts
export function useDeliveredPose(frame: AvatarPoseFrame, policy: PoseDeliveryPolicy) {
  const buffer = useRef(new PoseDeliveryBuffer());
  const [delivered, setDelivered] = useState(frame);
  useEffect(() => { buffer.current.push(frame, policy); }, [frame, policy]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const next = buffer.current.take();
      if (next) setDelivered(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); buffer.current.clear(); };
  }, []);
  return { pose: delivered, ageMs: Math.max(0, Date.now() - delivered.capturedAt) };
}
```

- [ ] **Step 4: Run focused and full tests**

Run: `npm run test -- tests/pose-experience.test.ts && npm run test`  
Expected: all tests PASS.

- [ ] **Step 5: Commit queue behavior**

```bash
git add src/core/pose-experience.ts src/hooks/useDeliveredPose.ts tests/pose-experience.test.ts
git commit -m "feat: apply network conditions to avatar pose"
```

### Task 4: Local MediaPipe provider and offline assets

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/features/tracking/mediapipe-face-tracker.ts`
- Create: `src/features/tracking/useFaceTracking.ts`
- Create: `public/models/face_landmarker.task`
- Create: `public/mediapipe/wasm/*`
- Test: `tests/face-tracker.test.ts`

- [ ] **Step 1: Write a failing provider lifecycle/fallback test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createFaceTracker } from '../src/features/tracking/mediapipe-face-tracker';

describe('MediaPipe face tracker', () => {
  it('returns an explicit fallback when the model cannot initialize', async () => {
    const tracker = await createFaceTracker({
      loadVision: vi.fn().mockRejectedValue(new Error('model unavailable')),
      timeoutMs: 20,
    });
    expect(tracker.available).toBe(false);
    expect(tracker.fallbackReason).toContain('model');
    expect(() => tracker.close()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/face-tracker.test.ts`  
Expected: FAIL because the provider module is missing.

- [ ] **Step 3: Install and bundle the runtime locally**

Run: `npm install @mediapipe/tasks-vision@0.10.35`  
Expected: package and lockfile update successfully.

Copy the package's `wasm` directory into `public/mediapipe/wasm`. Download the official model only from:

```text
https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task
```

Save it as `public/models/face_landmarker.task`. Verify the model is non-empty and larger than 3 MB before continuing.

- [ ] **Step 4: Implement the injectable provider and adaptive hook**

```ts
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision';

export interface FaceTrackerSample {
  categories: Array<{ categoryName: string; score: number }>;
  matrix?: number[];
  facePresent: boolean;
}
export interface FaceTracker {
  available: boolean;
  fallbackReason?: string;
  detect(video: HTMLVideoElement, timestampMs: number): FaceTrackerSample;
  close(): void;
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('model initialization timed out')), timeoutMs);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { window.clearTimeout(timer); }
};

const defaultLoader = () => import('@mediapipe/tasks-vision');

export async function createFaceTracker(options: FaceTrackerFactoryOptions = {}): Promise<FaceTracker> {
  try {
    const vision = await withTimeout((options.loadVision ?? defaultLoader)(), options.timeoutMs ?? 5_000);
    const fileset = await vision.FilesetResolver.forVisionTasks('/mediapipe/wasm');
    const landmarker = await vision.FaceLandmarker.createFromOptions(
      fileset,
      { baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true },
    );
    return {
      available: true,
      detect(video, timestampMs) {
        const result: FaceLandmarkerResult = landmarker.detectForVideo(video, timestampMs);
        const face = result.faceBlendshapes[0];
        const matrix = result.facialTransformationMatrixes[0];
        return {
          categories: face?.categories.map(({ categoryName, score }) => ({ categoryName, score })) ?? [],
          matrix: matrix ? Array.from(matrix.data) : undefined,
          facePresent: Boolean(result.faceLandmarks[0]),
        };
      },
      close: () => landmarker.close(),
    };
  } catch (error) {
    const fallbackReason = error instanceof Error ? `Face model unavailable: ${error.message}` : 'Face model unavailable.';
    return { available: false, fallbackReason, detect: () => ({ categories: [], facePresent: false }), close: () => undefined };
  }
}
```

`useFaceTracking` initializes only while a live front-camera stream exists, samples at 12–15 Hz, skips duplicate `video.currentTime`, converts samples through `mapFaceResultToPose`, emits a neutral EMULATED pose after 800 ms with no face, and always closes the task/cancels timers on camera switch, stop, background pause, and unmount.

- [ ] **Step 5: Run focused test, build, and full suite**

Run: `npm run test -- tests/face-tracker.test.ts && npm run build && npm run test`  
Expected: provider fallback test, strict TypeScript build, and full suite PASS.

- [ ] **Step 6: Commit local face tracking**

```bash
git add package.json package-lock.json public/models public/mediapipe src/features/tracking tests/face-tracker.test.ts
git commit -m "feat: track iPhone facial performance locally"
```

### Task 5: Outbound WebRTC telemetry and mobile pose emission

**Files:**
- Modify: `src/realtime/stats.ts`
- Modify: `src/realtime/useBroadcasterPeer.ts`
- Modify: `src/features/broadcast/BroadcasterPage.tsx`
- Modify: `src/styles/index.css`
- Test: `tests/webrtc-stats.test.ts`

- [ ] **Step 1: Write failing direction-aware stats tests**

```ts
import { describe, expect, it } from 'vitest';
import { extractWebRtcLiveStats } from '../src/realtime/stats';

describe('WebRTC live stats', () => {
  it('computes outbound bitrate from bytesSent and remote RTT', () => {
    const report = [
      { type: 'outbound-rtp', kind: 'video', timestamp: 2_000, bytesSent: 250_000, framesPerSecond: 24 },
      { type: 'remote-inbound-rtp', kind: 'video', roundTripTime: 0.082, packetsLost: 3, jitter: 0.012 },
    ];
    const result = extractWebRtcLiveStats(report, 'outbound', { sampledAt: 1_000, bytes: 100_000 });
    expect(result.stats.bitrateKbps).toBe(1200);
    expect(result.stats.rttMs).toBe(82);
    expect(result.stats.provenance).toBe('LIVE');
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/webrtc-stats.test.ts`  
Expected: FAIL because `extractWebRtcLiveStats` is not exported.

- [ ] **Step 3: Refactor stats parsing and expose outbound samples**

Add `direction: 'inbound' | 'outbound'` to the collector, use `bytesReceived/framesDecoded` for inbound and `bytesSent/framesEncoded` for outbound, use `candidate-pair.currentRoundTripTime` or `remote-inbound-rtp.roundTripTime`, and keep unavailable fields as `null`. Add `onStats?: (stats: WebRtcLiveStats) => void` to `BroadcasterPeerOptions`; start the collector after peer creation and stop it in every cleanup path.

```ts
interface GenericStats {
  type?: string; kind?: string; mediaType?: string; timestamp?: number;
  bytesReceived?: number; bytesSent?: number; framesDecoded?: number; framesEncoded?: number;
  framesPerSecond?: number; framesDropped?: number; packetsLost?: number; jitter?: number;
  roundTripTime?: number; currentRoundTripTime?: number; state?: string; nominated?: boolean;
}
export interface StatsAccumulator { sampledAt: number; bytes?: number; frames?: number }
export function extractWebRtcLiveStats(
  values: Iterable<unknown>,
  direction: 'inbound' | 'outbound',
  previous?: StatsAccumulator,
): { stats: WebRtcLiveStats; accumulator: StatsAccumulator } {
  const rows = Array.from(values) as GenericStats[];
  const media = rows.find((row) => row.type === `${direction}-rtp` && (row.kind === 'video' || row.mediaType === 'video'));
  const remote = rows.find((row) => row.type === 'remote-inbound-rtp' && (row.kind === 'video' || row.mediaType === 'video'));
  const pair = rows.find((row) => row.type === 'candidate-pair' && row.state === 'succeeded' && row.nominated);
  const sampledAt = media?.timestamp ?? performance.now();
  const bytes = direction === 'inbound' ? media?.bytesReceived : media?.bytesSent;
  const frames = direction === 'inbound' ? media?.framesDecoded : media?.framesEncoded;
  const elapsed = previous ? Math.max(1, sampledAt - previous.sampledAt) : 0;
  const bitrateKbps = previous && bytes !== undefined && previous.bytes !== undefined ? Math.round(((bytes - previous.bytes) * 8) / elapsed) : null;
  return {
    stats: {
      provenance: 'LIVE', sampledAt: Date.now(), bitrateKbps,
      fps: media?.framesPerSecond ?? null, framesDropped: media?.framesDropped ?? null,
      packetsLost: remote?.packetsLost ?? media?.packetsLost ?? null,
      jitterMs: (remote?.jitter ?? media?.jitter) === undefined ? null : Math.round((remote?.jitter ?? media?.jitter ?? 0) * 1_000),
      rttMs: (remote?.roundTripTime ?? pair?.currentRoundTripTime) === undefined ? null : Math.round((remote?.roundTripTime ?? pair?.currentRoundTripTime ?? 0) * 1_000),
    },
    accumulator: { sampledAt, bytes, frames },
  };
}
```

- [ ] **Step 4: Wire tracking and telemetry into the iPhone page**

In `BroadcasterPage.tsx`:

```ts
const [outboundStats, setOutboundStats] = useState<WebRtcLiveStats | null>(null);
const tracking = useFaceTracking({ video: videoRef.current, active: state === 'live' && facingMode === 'user' });
useEffect(() => {
  if (!realtime.joined || !tracking.pose) return;
  realtime.socket.emit('avatar:pose', { sessionId, pose: tracking.pose });
}, [realtime.joined, realtime.socket, sessionId, tracking.pose]);
```

Pass `onStats: setOutboundStats` into `useBroadcasterPeer`. Add a compact HUD with exact labels `UPLINK LIVE`, `RTC RTT LIVE`, and `FACE LIVE/EMULATED`; render `—` instead of profile values before the first real sample. Keep Start/Stop as the only primary action and preserve safe-area insets.

- [ ] **Step 5: Run tests, lint, and mobile E2E**

Run: `npm run test -- tests/webrtc-stats.test.ts && npm run lint && npm run test:e2e -- tests/e2e/fallbacks.spec.ts`  
Expected: all commands PASS.

- [ ] **Step 6: Commit the iPhone live signal UI**

```bash
git add src/realtime/stats.ts src/realtime/useBroadcasterPeer.ts src/features/broadcast/BroadcasterPage.tsx src/styles/index.css tests/webrtc-stats.test.ts
git commit -m "feat: publish live face pose and uplink telemetry"
```

### Task 6: Desktop pose receive, store, and honest source telemetry

**Files:**
- Create: `src/realtime/usePoseReceiver.ts`
- Modify: `src/realtime/index.ts`
- Modify: `src/store/useOneLiveStore.ts`
- Modify: `src/features/control-room/SourcePanel.tsx`
- Test: `tests/store-pose.test.ts`

- [ ] **Step 1: Write a failing store provenance test**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createNeutralPose } from '../src/features/tracking/pose-frame';
import { useOneLiveStore } from '../src/store/useOneLiveStore';

describe('live pose store', () => {
  beforeEach(() => useOneLiveStore.getState().reset());
  it('accepts a newer live frame and ignores a replay', () => {
    const store = useOneLiveStore.getState();
    store.acceptPose({ ...createNeutralPose(4, 100), facePresent: true, provenance: 'LIVE' });
    store.acceptPose({ ...createNeutralPose(3, 90), facePresent: true, provenance: 'LIVE' });
    expect(useOneLiveStore.getState().poseFrame.sequence).toBe(4);
    expect(useOneLiveStore.getState().poseFrame.provenance).toBe('LIVE');
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/store-pose.test.ts`  
Expected: FAIL because the store has no `acceptPose` action.

- [ ] **Step 3: Implement receiver and atomic store updates**

Add `poseFrame`, `poseReceivedAt`, and `acceptPose(frame)` to the store. `acceptPose` only replaces state for a larger sequence. Reset restores an EMULATED neutral frame without changing session ID.

`usePoseReceiver(socket, joined, sessionId, onPose)` subscribes to `avatar:pose`, revalidates the envelope client-side, filters other sessions, invokes `onPose`, and unregisters exactly the same handler on cleanup.

- [ ] **Step 4: Attach receiver to the existing control socket**

Call `usePoseReceiver` inside `SourcePanel` so no second `control` socket can replace the current session. Change the POSE telemetry from hard-coded `SEEDED / EMULATED` to:

```tsx
<strong>{poseFrame.provenance === 'LIVE' && poseFrame.facePresent ? `${Math.round(poseFrame.trackingFps)} FPS` : 'SEEDED'}</strong>
<small>{poseFrame.provenance}</small>
```

If the last LIVE frame is older than 1.5 seconds, atomically switch to a neutral EMULATED pose with reason `Live pose timed out` while keeping the live video source selected.

- [ ] **Step 5: Run store tests and full suite**

Run: `npm run test -- tests/store-pose.test.ts && npm run test`  
Expected: all tests PASS.

- [ ] **Step 6: Commit desktop reception**

```bash
git add src/realtime/usePoseReceiver.ts src/realtime/index.ts src/store/useOneLiveStore.ts src/features/control-room/SourcePanel.tsx tests/store-pose.test.ts
git commit -m "feat: receive live pose in the control room"
```

### Task 7: Market avatar casting manifest and local portrait assets

**Files:**
- Create: `src/config/avatars.ts`
- Create: `src/features/avatars/AvatarCastingControls.tsx`
- Modify: `src/store/useOneLiveStore.ts`
- Modify: `src/features/control-room/TopBar.tsx`
- Create: `public/avatars/*.png`
- Test: `tests/avatars.test.ts`

- [ ] **Step 1: Write a failing config completeness test**

```ts
import { describe, expect, it } from 'vitest';
import { AVATAR_VARIANTS, resolveAvatarVariant } from '../src/config/avatars';
import { MARKET_PROFILES } from '../src/config/markets';

describe('avatar casting manifest', () => {
  it('provides every market, gender, and wardrobe combination', () => {
    for (const market of MARKET_PROFILES) {
      for (const gender of ['female', 'male'] as const) {
        for (const wardrobe of ['studio', 'executive'] as const) {
          expect(resolveAvatarVariant(market.id, gender, wardrobe).src).toMatch(/^\/avatars\/.+\.png$/);
        }
      }
    }
    expect(AVATAR_VARIANTS).toHaveLength(12);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test -- tests/avatars.test.ts`  
Expected: FAIL because `avatars.ts` does not exist.

- [ ] **Step 3: Generate twelve consistent local portrait assets**

Use the image generation skill with one market at a time and the following invariant prompt, changing only market art direction, gender, and wardrobe:

```text
Create a premium half-body authorized synthetic livestream presenter, centered front-facing at eye level, neutral closed-mouth expression, realistic skin and eyes, elegant commercial fashion, shoulders fully visible, near-black seamless background, cyan rim light, no text, no logos, no jewelry crossing the face, no hands, 4:5 portrait. This is a fictional adult AI character and must not resemble a public figure. Keep face placement and camera crop identical across the set.
```

Market direction: North America = graphite/cobalt editorial studio; Japan = pearl/violet precision studio; Spanish market = obsidian/amber warm editorial studio. Wardrobes: `studio` = technical broadcast jacket; `executive` = tailored modern jacket. Save exact names such as `/avatars/north-america-female-studio.png` through `/avatars/spanish-male-executive.png`.

- [ ] **Step 4: Implement manifest and casting controls**

```ts
export interface AvatarVariant {
  marketId: MarketId; gender: AvatarGender; wardrobe: AvatarWardrobe;
  src: string; name: string; faceAnchor: { x: number; y: number; scale: number };
}

export const resolveAvatarVariant = (marketId: MarketId, gender: AvatarGender, wardrobe: AvatarWardrobe) => {
  const match = AVATAR_VARIANTS.find((variant) => variant.marketId === marketId && variant.gender === gender && variant.wardrobe === wardrobe);
  if (!match) throw new Error(`Missing avatar variant: ${marketId}/${gender}/${wardrobe}`);
  return match;
};
```

Add `avatarGender`, `avatarWardrobe`, `setAvatarGender`, and `setAvatarWardrobe` to the Zustand store. `AvatarCastingControls` uses two accessible segmented groups with `aria-pressed`, labels `Female/Male` and `Studio/Executive`, and visible focus rings. Mount it in the existing top control area without increasing the 1440 × 900 page height.

- [ ] **Step 5: Verify assets and tests**

Run: `npm run test -- tests/avatars.test.ts && npm run build`  
Expected: 12 manifest entries, all asset files exist, and build PASS.

- [ ] **Step 6: Commit casting assets and configuration**

```bash
git add public/avatars src/config/avatars.ts src/features/avatars/AvatarCastingControls.tsx src/store/useOneLiveStore.ts src/features/control-room/TopBar.tsx tests/avatars.test.ts
git commit -m "feat: add market-specific avatar casting"
```

### Task 8: Replace autonomous geometry with pose-driven 2.5D avatars

**Files:**
- Modify: `src/features/avatars/AvatarStage.tsx`
- Modify: `src/features/control-room/MarketCard.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/styles/index.css`
- Test: `tests/e2e/live-avatar.spec.ts`

- [ ] **Step 1: Write failing E2E checks for shared real pose and casting**

```ts
import { expect, test } from '@playwright/test';
import { openMockDemo } from './helpers';

test('one received pose drives all three market avatars', async ({ page }) => {
  await openMockDemo(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('onelive:test-pose', { detail: { sequence: 42, headYaw: 0.7, jawOpen: 0.8, blinkLeft: 1, blinkRight: 1 } })));
  for (const id of ['north-america', 'japan', 'spanish']) {
    await expect(page.getByTestId(`avatar-stage-${id}`)).toHaveAttribute('data-pose-sequence', '42');
    await expect(page.getByTestId(`avatar-stage-${id}`)).toHaveAttribute('data-mouth', 'open');
  }
});

test('casting keeps each market asset distinct', async ({ page }) => {
  await openMockDemo(page);
  await page.getByRole('button', { name: 'Male avatar' }).click();
  await page.getByRole('button', { name: 'Executive wardrobe' }).click();
  const sources = await page.locator('[data-testid^="avatar-portrait-"]').evaluateAll((nodes) => nodes.map((node) => (node as HTMLImageElement).src));
  expect(new Set(sources).size).toBe(3);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run test:e2e -- tests/e2e/live-avatar.spec.ts`  
Expected: FAIL because pose/casting attributes and controls do not exist.

- [ ] **Step 3: Implement the presentational avatar stage**

`AvatarStage` receives `pose`, `variant`, and `poseAgeMs` in addition to market/channel. Remove sine-wave head/arm/mouth animation. Compute only CSS variables from the delivered pose:

```tsx
const style = {
  '--head-yaw': `${pose.headYaw * 7}deg`,
  '--head-pitch': `${pose.headPitch * -5}deg`,
  '--head-roll': `${pose.headRoll * 4}deg`,
  '--mouth-open': pose.jawOpen,
  '--smile': pose.mouthSmile,
  '--blink-left': pose.blinkLeft,
  '--blink-right': pose.blinkRight,
  '--audio-level': pose.audioLevel,
} as React.CSSProperties;
```

Render the local portrait as the visual dominant layer, add eye-lid and mouth/viseme overlays anchored by `variant.faceAnchor`, keep localized stage light/particles, watermark, buffering, low-res and pause states. Use transform/opacity only for motion. When `prefers-reduced-motion` is active, update expression states without interpolation.

- [ ] **Step 4: Feed each market through its own queue**

In `MarketCard`, call `useDeliveredPose` with the global raw frame and the current market priority/profile/deployment/QoD. `App.tsx` passes deployment and the channel experience. Expose `data-pose-sequence`, `data-pose-provenance`, `data-pose-age`, and `data-mouth` for deterministic QA. A test-only `onelive:test-pose` listener is enabled only when `import.meta.env.MODE === 'test'` or `?mock=1` and routes through the same store action.

- [ ] **Step 5: Run E2E, full test, lint, and build**

Run: `npm run test:e2e -- tests/e2e/live-avatar.spec.ts && npm run test && npm run lint && npm run build`  
Expected: all commands PASS.

- [ ] **Step 6: Commit pose-driven avatar rendering**

```bash
git add src/features/avatars/AvatarStage.tsx src/features/control-room/MarketCard.tsx src/app/App.tsx src/styles/index.css tests/e2e/live-avatar.spec.ts
git commit -m "feat: drive three portrait avatars from one live pose"
```

### Task 9: Network/Edge/QoD visual causality, docs, and visual QA

**Files:**
- Modify: `tests/e2e/live-avatar.spec.ts`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/DEMO_RUNBOOK.md`
- Modify: `README.md`
- Replace: `artifacts/control-room.png`
- Replace: `artifacts/network-degraded.png`
- Replace: `artifacts/edge-qod-recovered.png`
- Replace: `artifacts/mobile-broadcaster.png`

- [ ] **Step 1: Add failing E2E timing and provenance assertions**

Add tests that inject sequential pose frames, switch to High Latency, assert the latest frame is not visible before the policy delay, switch Edge on, assert the next frame appears sooner, and verify QoD priority-one pose age is lower than priority-three under congestion. Assert all derived values are labeled `EMULATED` or `CONTROLLED LAB`, while RTC metrics remain `LIVE` only after a sample.

```ts
test('high latency delays pose and edge shortens the next delivery', async ({ page }) => {
  await openMockDemo(page);
  await page.keyboard.press('4');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('onelive:test-pose', { detail: { sequence: 70, headYaw: 0.9 } })));
  await page.waitForTimeout(250);
  await expect(page.getByTestId('avatar-stage-north-america')).not.toHaveAttribute('data-pose-sequence', '70');
  await page.keyboard.press('e');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('onelive:test-pose', { detail: { sequence: 71, headYaw: -0.9 } })));
  await expect(page.getByTestId('avatar-stage-north-america')).toHaveAttribute('data-pose-sequence', '71', { timeout: 1_200 });
  await expect(page.getByTestId('avatar-stage-north-america')).toHaveAttribute('data-pose-provenance', /LIVE|EMULATED/);
});
```

- [ ] **Step 2: Run and observe at least one timing/provenance failure**

Run: `npm run test:e2e -- tests/e2e/live-avatar.spec.ts`  
Expected: FAIL on the new pose-age or provenance expectation until UI labels/timing hooks are complete.

- [ ] **Step 3: Finish visual state and documentation**

Add one compact pose-path indicator to each avatar card: `FACE LIVE → QUEUE CONTROLLED LAB → AVATAR LOCAL`. Update architecture, decisions, runbook, and README with exact iPhone certificate steps, local model paths, 12–15 Hz tracking target, LIVE/EMULATED boundaries, and the explicit limitation that external platform publishing is not connected.

- [ ] **Step 4: Run the production-style mock and capture reference sizes**

Run: `npm run demo:mock` and use Playwright at 1440 × 900, 1920 × 1080, and 390 × 844. Replace the four required artifact screenshots. Inspect clipping, overlap, contrast, focus, animation, portrait loading, page overflow, and browser console errors. Fix every P0/P1 issue and repeat the exact affected test.

- [ ] **Step 5: Perform iPhone-ready manual smoke checks available locally**

Verify `/broadcast/ONE-DEMO` starts with no permission prompt until Start, reports model fallback safely when blocked, stops every media track on End, and reconnects the session after a simulated socket disconnect. Record in the runbook that actual iPhone Safari remains `UNVERIFIED` until a physical device run is completed.

- [ ] **Step 6: Commit QA and documentation**

```bash
git add tests/e2e/live-avatar.spec.ts README.md docs artifacts/*.png
git commit -m "docs: verify the iPhone live avatar demo"
```

### Task 10: Fresh final verification

**Files:**
- Modify only files required to fix a verification failure.

- [ ] **Step 1: Run every required quality command from a clean prompt**

```bash
npm run build
npm run lint
npm run test
npm run test:e2e
```

Expected: every command exits 0. Do not summarize from an earlier run.

- [ ] **Step 2: Start the exact offline-safe demo command**

Run: `npm run demo:mock`  
Expected: `/api/health` returns `ok: true`, the control room opens, and Connect → Congestion → Latency → Edge → QoD → Business completes via Space.

- [ ] **Step 3: Check repository and capability claims**

Run: `git status --short` and inspect the browser console.  
Expected: no accidental secrets/certificates, no unhandled rejections, and only intentional uncommitted visual artifacts if any. Confirm the handoff says `iOS Web path implemented` unless a real iPhone test was actually completed.

- [ ] **Step 4: Commit any verification-only fixes and rerun the affected commands**

```bash
git add src/realtime/stats.ts tests/webrtc-stats.test.ts
git commit -m "fix: stabilize live avatar demo verification"
```

The two paths above are an example for a stats failure. Stage only the exact files changed by the observed failure; skip the commit if no fix was needed.
