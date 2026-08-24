import { describe, expect, it, vi } from 'vitest';
import { createMediaElementAudioDelay } from '@/media/mediaElementAudioDelay';

describe('media element audio delay', () => {
  it('routes one media element through a DelayNode and updates its delay', async () => {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const delayTime = { value: 0, setValueAtTime: vi.fn() };
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
      1500,
      () => context as unknown as AudioContext,
    );

    expect(controller).not.toBeNull();
    expect(source.connect).toHaveBeenCalledWith(delay);
    expect(delay.connect).toHaveBeenCalledWith(context.destination);
    expect(context.createDelay).toHaveBeenCalledWith(2);
    expect(delayTime.value).toBe(1.5);
    expect(element).toHaveAttribute('data-applied-audio-delay-ms', '1500');

    controller?.setDelay(100);
    expect(delayTime.setValueAtTime).toHaveBeenCalledWith(0.1, 4);
    expect(element).toHaveAttribute('data-applied-audio-delay-ms', '100');
    await controller?.resume();
    expect(context.resume).toHaveBeenCalled();
    controller?.dispose();
    expect(context.close).toHaveBeenCalled();
    expect(element).not.toHaveAttribute('data-applied-audio-delay-ms');
  });

  it('returns null instead of breaking playback when Web Audio setup fails', () => {
    const controller = createMediaElementAudioDelay(
      document.createElement('video'),
      1500,
      () => {
        throw new Error('AudioContext unavailable');
      },
    );

    expect(controller).toBeNull();
  });
});
