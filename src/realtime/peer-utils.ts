import type { NetworkProfileId } from '../core/types';
import type { IceServerConfig, SenderConstraints } from './protocol';

export interface SenderParametersResult {
  applied: boolean;
  reason?: string;
}

export const SENDER_CONSTRAINTS: Record<NetworkProfileId, SenderConstraints> = {
  premium: {
    maxBitrateBps: 2_500_000,
    maxFramerate: 30,
    scaleResolutionDownBy: 1,
  },
  congested: {
    maxBitrateBps: 900_000,
    maxFramerate: 18,
    scaleResolutionDownBy: 1.5,
  },
  weak: {
    maxBitrateBps: 350_000,
    maxFramerate: 10,
    scaleResolutionDownBy: 3,
  },
  latency: {
    maxBitrateBps: 1_800_000,
    maxFramerate: 24,
    scaleResolutionDownBy: 1,
  },
};

export const toRtcConfiguration = (iceServers: IceServerConfig[] = []): RTCConfiguration => ({
  iceServers: iceServers.map(({ urls, username, credential }) => ({
    urls,
    ...(username ? { username } : {}),
    ...(credential ? { credential } : {}),
  })),
  bundlePolicy: 'max-bundle',
});

export const applySenderConstraints = async (
  peerConnection: RTCPeerConnection,
  constraints: SenderConstraints,
): Promise<SenderParametersResult> => {
  const videoSenders = peerConnection
    .getSenders()
    .filter((sender) => sender.track?.kind === 'video');
  if (videoSenders.length === 0) {
    return { applied: false, reason: 'No active video sender.' };
  }

  try {
    await Promise.all(
      videoSenders.map(async (sender) => {
        const parameters = sender.getParameters();
        const encoding = parameters.encodings?.[0] ?? {};
        parameters.encodings = [
          {
            ...encoding,
            maxBitrate: constraints.maxBitrateBps,
            maxFramerate: constraints.maxFramerate,
            scaleResolutionDownBy: constraints.scaleResolutionDownBy,
          },
          ...(parameters.encodings?.slice(1) ?? []),
        ];
        await sender.setParameters(parameters);
      }),
    );
    return { applied: true };
  } catch (error) {
    return {
      applied: false,
      reason: error instanceof Error ? error.message : 'Sender parameters are unsupported.',
    };
  }
};

export const safelyAddIceCandidate = async (
  peerConnection: RTCPeerConnection,
  candidate: RTCIceCandidateInit | null,
): Promise<boolean> => {
  try {
    await peerConnection.addIceCandidate(candidate);
    return true;
  } catch {
    return false;
  }
};
