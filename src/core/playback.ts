import type { DeploymentMode, NetworkProfileId } from '@/core/types';

export function localizedAudioDelayMs(
  profileId: NetworkProfileId,
  deployment: DeploymentMode,
): number {
  if (profileId !== 'latency') return 0;
  return deployment === 'edge' ? 100 : 1000;
}
