import { describe, expect, it } from 'vitest';
import { DEMO_LINES } from '@/config/scripts';
import {
  BrowserTTSProvider,
  DemoTranslationProvider,
  SeededPoseProvider,
  SimulatedNetworkCapabilityProvider,
} from '@/providers/demoProviders';

describe('demo translation provider', () => {
  it('returns the curated translation for every market with explicit provenance', async () => {
    const provider = new DemoTranslationProvider();
    const fallback = DEMO_LINES[0];

    for (const marketId of ['north-america', 'japan', 'spanish'] as const) {
      await expect(provider.translate('arbitrary live speech', marketId, fallback)).resolves.toEqual({
        value: fallback.translations[marketId],
        provenance: 'EMULATED',
      });
    }
  });
});

describe('seeded pose provider', () => {
  it('is deterministic for the same timestamp and marks the pose as emulated', () => {
    const provider = new SeededPoseProvider();

    expect(provider.nextPose(1234)).toEqual(provider.nextPose(1234));
    expect(provider.nextPose(1234).provenance).toBe('EMULATED');
  });

  it('keeps every procedural pose signal inside safe animation bounds', () => {
    const provider = new SeededPoseProvider();

    for (let timeMs = 0; timeMs <= 30_000; timeMs += 137) {
      const { value } = provider.nextPose(timeMs);
      expect(value.headX).toBeGreaterThanOrEqual(-0.08);
      expect(value.headX).toBeLessThanOrEqual(0.08);
      expect(value.headY).toBeGreaterThanOrEqual(-0.045);
      expect(value.headY).toBeLessThanOrEqual(0.045);
      expect(value.shoulderTilt).toBeGreaterThanOrEqual(-0.04);
      expect(value.shoulderTilt).toBeLessThanOrEqual(0.04);
      expect(value.mouthOpen).toBeGreaterThanOrEqual(0.18);
      expect(value.mouthOpen).toBeLessThanOrEqual(0.42);
      expect([0, 1]).toContain(value.blink);
    }
  });
});

describe('safe-mode capability providers', () => {
  it('simulates a successful QoD reservation without claiming live provenance', async () => {
    const provider = new SimulatedNetworkCapabilityProvider();

    await expect(provider.requestQoD('E2E-SESSION')).resolves.toEqual({
      value: { active: true },
      provenance: 'EMULATED',
    });
  });

  it('falls back immediately when browser speech synthesis is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
    Reflect.deleteProperty(window, 'speechSynthesis');

    try {
      const provider = new BrowserTTSProvider();
      expect(provider.available).toBe(false);
      await expect(provider.speak('Hello', 'en-US', ['English'])).resolves.toEqual({
        value: undefined,
        provenance: 'EMULATED',
        fallbackReason: 'Browser TTS unavailable',
      });
      expect(() => provider.stop()).not.toThrow();
    } finally {
      if (descriptor) Object.defineProperty(window, 'speechSynthesis', descriptor);
    }
  });
});
