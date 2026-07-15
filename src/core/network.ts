import { MARKET_PROFILES } from '@/config/markets';
import type {
  ChannelExperience,
  ChannelQuality,
  ChannelStatus,
  DeploymentMode,
  ExperienceSnapshot,
  MarketProfile,
  NetworkParameters,
  NetworkProfile,
  NetworkProfileId,
  ProcessingLatency,
} from '@/core/types';

export const NETWORK_PROFILES: Record<NetworkProfileId, NetworkProfile> = {
  premium: {
    id: 'premium',
    label: 'Premium 5G',
    shortLabel: '5G',
    description: 'High-capacity cellular uplink',
    uplinkKbps: 20_000,
    rttMs: 38,
    jitterMs: 6,
    lossPct: 0.2,
  },
  congested: {
    id: 'congested',
    label: 'Congested Network',
    shortLabel: 'CONGESTED',
    description: 'Competing traffic, jitter and light loss',
    uplinkKbps: 3200,
    rttMs: 180,
    jitterMs: 75,
    lossPct: 3,
  },
  weak: {
    id: 'weak',
    label: 'Weak Coverage',
    shortLabel: 'WEAK',
    description: 'Cell-edge capacity and packet loss',
    uplinkKbps: 850,
    rttMs: 460,
    jitterMs: 180,
    lossPct: 12,
  },
  latency: {
    id: 'latency',
    label: 'High Latency',
    shortLabel: 'HIGH RTT',
    description: 'Capacity remains high, responsiveness does not',
    uplinkKbps: 16_000,
    rttMs: 880,
    jitterMs: 110,
    lossPct: 1.5,
  },
};

const PROCESSING: Record<DeploymentMode, ProcessingLatency> = {
  cloud: { poseMs: 220, translationMs: 380, voiceMs: 240, pathNodes: 6 },
  edge: { poseMs: 55, translationMs: 95, voiceMs: 80, pathNodes: 4 },
};

export function resolveNetwork(
  profileId: NetworkProfileId,
  overrides: Partial<NetworkParameters> = {},
): NetworkProfile {
  return { ...NETWORK_PROFILES[profileId], ...overrides };
}

export function getProcessingLatency(deployment: DeploymentMode): ProcessingLatency {
  return PROCESSING[deployment];
}

export function allocateChannelResources(
  network: NetworkParameters,
  markets: MarketProfile[] = MARKET_PROFILES,
  qod = false,
): Record<string, number> {
  const usableBudget = Math.floor(network.uplinkKbps * (qod ? 0.94 : 0.7));
  const result: Record<string, number> = {};

  if (qod) {
    let remaining = usableBudget;
    for (const market of [...markets].sort((a, b) => a.priority - b.priority)) {
      const guarantee = Math.min(market.minimumStableKbps, remaining);
      result[market.id] = guarantee;
      remaining -= guarantee;
    }
    const weights = [0.5, 0.3, 0.2];
    [...markets]
      .sort((a, b) => a.priority - b.priority)
      .forEach((market, index) => {
        const headroom = Math.max(0, market.targetKbps - (result[market.id] ?? 0));
        result[market.id] = (result[market.id] ?? 0) + Math.min(headroom, Math.floor(remaining * weights[index]));
      });
  } else {
    const weights = [0.48, 0.31, 0.21];
    [...markets]
      .sort((a, b) => a.priority - b.priority)
      .forEach((market, index) => {
        result[market.id] = Math.min(market.targetKbps, Math.floor(usableBudget * weights[index]));
      });
  }

  return result;
}

function statusFor(
  profileId: NetworkProfileId,
  qod: boolean,
  market: MarketProfile,
): ChannelStatus {
  if (profileId === 'premium' || profileId === 'latency') return 'live';
  if (profileId === 'congested') {
    if (qod) return 'live';
    return market.priority === 1 ? 'low-res' : market.priority === 2 ? 'buffering' : 'low-res';
  }
  if (qod) return market.priority === 1 ? 'low-res' : market.priority === 2 ? 'buffering' : 'audio-only';
  return market.priority === 1 ? 'low-res' : market.priority === 2 ? 'buffering' : 'paused';
}

function qualityFor(status: ChannelStatus, profileId: NetworkProfileId, priority: number, qod: boolean): ChannelQuality {
  if (status === 'audio-only') return 'audio';
  if (status === 'paused') return 'none';
  if (status === 'buffering') return 'low';
  if (status === 'low-res') return priority === 1 && qod ? 'sd' : 'low';
  if (profileId === 'premium') return priority === 1 ? 'uhd' : 'hd';
  return priority === 1 ? 'hd' : 'sd';
}

function metricsForQuality(quality: ChannelQuality): { fps: number; resolution: string } {
  switch (quality) {
    case 'uhd':
      return { fps: 30, resolution: '1080p' };
    case 'hd':
      return { fps: 30, resolution: '1080p' };
    case 'sd':
      return { fps: 24, resolution: '720p' };
    case 'low':
      return { fps: 12, resolution: '360p' };
    case 'audio':
      return { fps: 0, resolution: 'AUDIO' };
    default:
      return { fps: 0, resolution: 'PAUSED' };
  }
}

export function deriveExperience({
  profileId,
  deployment,
  qod,
  overrides,
}: {
  profileId: NetworkProfileId;
  deployment: DeploymentMode;
  qod: boolean;
  overrides?: Partial<NetworkParameters>;
}): ExperienceSnapshot {
  const profile = resolveNetwork(profileId, overrides);
  const processing = getProcessingLatency(deployment);
  const allocations = allocateChannelResources(profile, MARKET_PROFILES, qod);
  const pathRtt = deployment === 'edge' ? profile.rttMs * 0.55 : profile.rttMs;
  const baseLatency = Math.round(pathRtt + Math.max(processing.poseMs, processing.translationMs));
  const baseOffset = Math.round(profile.jitterMs * 0.8 + profile.rttMs * 0.14 + (deployment === 'cloud' ? 28 : 8));

  const channels: ChannelExperience[] = MARKET_PROFILES.map((market) => {
    const status = statusFor(profileId, qod, market);
    const quality = qualityFor(status, profileId, market.priority, qod);
    const { fps, resolution } = metricsForQuality(quality);
    const latencyMs = baseLatency + market.priority * 12;
    const avOffsetMs = baseOffset + market.priority * 6;
    return {
      marketId: market.id,
      status,
      quality,
      allocatedKbps: allocations[market.id] ?? 0,
      fps,
      resolution,
      latencyMs,
      avOffsetMs,
      viewers: market.viewers,
      syncWarning: avOffsetMs > 140 || profileId === 'latency',
    };
  });

  const activeChannels = channels.filter((channel) => channel.status !== 'paused').length;
  const averageFps = Math.round(channels.reduce((sum, channel) => sum + channel.fps, 0) / channels.length);
  const avOffsetMs = Math.max(...channels.map((channel) => channel.avOffsetMs));
  const latencyPenalty = Math.min(55, baseLatency / 24);
  const syncPenalty = Math.min(22, avOffsetMs / 18);
  const channelPenalty = (3 - activeChannels) * 14;
  const score = Math.max(18, Math.min(99, Math.round(103 - latencyPenalty - syncPenalty - channelPenalty + averageFps / 4)));

  const pathState =
    qod && profileId !== 'premium'
      ? 'protected'
      : profileId === 'weak'
        ? 'critical'
        : profileId === 'congested' || profileId === 'latency'
          ? 'stressed'
          : 'stable';

  return {
    profile,
    deployment,
    qod,
    processing,
    channels,
    e2eLatencyMs: baseLatency,
    averageFps,
    avOffsetMs,
    activeChannels,
    score,
    pathState,
  };
}

export function senderConstraints(profileId: NetworkProfileId): {
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
} {
  const presets = {
    premium: { maxBitrate: 2_500_000, maxFramerate: 30, scaleResolutionDownBy: 1 },
    congested: { maxBitrate: 900_000, maxFramerate: 18, scaleResolutionDownBy: 1.5 },
    weak: { maxBitrate: 350_000, maxFramerate: 10, scaleResolutionDownBy: 3 },
    latency: { maxBitrate: 1_800_000, maxFramerate: 24, scaleResolutionDownBy: 1 },
  };
  return presets[profileId];
}
