import { beforeEach, describe, expect, it } from 'vitest';
import {
  DIRECTOR_PRESETS,
  clampDirectorStep,
  directorPreset,
} from '@/core/director';
import { useOneLiveStore } from '@/store/useOneLiveStore';

describe('director presets', () => {
  it('defines the approved six-step judging narrative in order', () => {
    expect(DIRECTOR_PRESETS.map((preset) => preset.id)).toEqual([
      'connect',
      'congestion',
      'latency',
      'edge',
      'qod',
      'business',
    ]);
    expect(DIRECTOR_PRESETS.map((preset) => preset.step)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it.each([
    [-99, 0],
    [0, 0],
    [2, 2],
    [5, 5],
    [99, 5],
  ])('clamps step %s to %s', (input, expected) => {
    expect(clampDirectorStep(input)).toBe(expected);
    expect(directorPreset(input)).toBe(DIRECTOR_PRESETS[expected]);
  });

  it('encodes the required network, compute, QoD and closing-view transitions', () => {
    expect(directorPreset(0)).toMatchObject({
      profileId: 'premium',
      deployment: 'cloud',
      qod: false,
      view: 'control',
    });
    expect(directorPreset(2)).toMatchObject({
      profileId: 'latency',
      deployment: 'cloud',
      qod: false,
    });
    expect(directorPreset(3)).toMatchObject({
      profileId: 'latency',
      deployment: 'edge',
      qod: false,
    });
    expect(directorPreset(4)).toMatchObject({
      profileId: 'congested',
      deployment: 'edge',
      qod: true,
    });
    expect(directorPreset(5)).toMatchObject({ view: 'business' });
  });
});

describe('director store state machine', () => {
  beforeEach(() => {
    useOneLiveStore.getState().reset();
    useOneLiveStore.getState().applyDirectorStep(0);
  });

  it('applies every preset atomically', () => {
    for (const preset of DIRECTOR_PRESETS) {
      useOneLiveStore.getState().applyDirectorStep(preset.step);
      expect(useOneLiveStore.getState()).toMatchObject({
        directorStep: preset.step,
        profileId: preset.profileId,
        deployment: preset.deployment,
        qod: preset.qod,
        view: preset.view,
        presenterMode: true,
        networkOverrides: {},
      });
    }
  });

  it('moves forward and backward without crossing the sequence boundaries', () => {
    useOneLiveStore.getState().previousDirectorStep();
    expect(useOneLiveStore.getState().directorStep).toBe(0);

    for (let index = 0; index < 10; index += 1) {
      useOneLiveStore.getState().nextDirectorStep();
    }
    expect(useOneLiveStore.getState().directorStep).toBe(5);
    expect(useOneLiveStore.getState().view).toBe('business');

    useOneLiveStore.getState().previousDirectorStep();
    expect(useOneLiveStore.getState()).toMatchObject({
      directorStep: 4,
      view: 'control',
      qod: true,
    });
  });

  it('resets all presentation mutations while retaining the current session', () => {
    const sessionId = useOneLiveStore.getState().sessionId;
    useOneLiveStore.getState().applyDirectorStep(5);
    useOneLiveStore.getState().setSource('local-camera', false);
    useOneLiveStore.getState().setNetworkOverride('rttMs', 1200);
    useOneLiveStore.getState().setDirectorRunning(true);
    useOneLiveStore.getState().reset();

    expect(useOneLiveStore.getState()).toMatchObject({
      sessionId,
      sourceKind: 'mock',
      sourceConnected: true,
      profileId: 'premium',
      networkOverrides: {},
      deployment: 'cloud',
      qod: false,
      view: 'control',
      presenterMode: false,
      directorRunning: false,
      directorStep: 0,
      bootComplete: true,
    });
  });
});
