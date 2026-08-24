import { describe, expect, it } from 'vitest';
import { localizedAudioDelayMs } from '@/core/playback';

describe('localized audio playback delay', () => {
  it('makes cloud latency obvious and lets Edge nearly recover sync', () => {
    expect(localizedAudioDelayMs('latency', 'cloud')).toBe(1000);
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
