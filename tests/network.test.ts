import { describe, expect, it } from 'vitest';
import { MARKET_PROFILES } from '@/config/markets';
import {
  NETWORK_PROFILES,
  allocateChannelResources,
  deriveExperience,
  getProcessingLatency,
  resolveNetwork,
  senderConstraints,
} from '@/core/network';

describe('network profiles', () => {
  it('defines four internally valid and meaningfully different profiles', () => {
    expect(Object.keys(NETWORK_PROFILES)).toEqual(['premium', 'congested', 'weak', 'latency']);

    for (const profile of Object.values(NETWORK_PROFILES)) {
      expect(profile.uplinkKbps).toBeGreaterThan(0);
      expect(profile.rttMs).toBeGreaterThanOrEqual(0);
      expect(profile.jitterMs).toBeGreaterThanOrEqual(0);
      expect(profile.lossPct).toBeGreaterThanOrEqual(0);
      expect(profile.lossPct).toBeLessThanOrEqual(100);
    }

    expect(NETWORK_PROFILES.premium.uplinkKbps).toBeGreaterThan(
      NETWORK_PROFILES.congested.uplinkKbps,
    );
    expect(NETWORK_PROFILES.weak.uplinkKbps).toBeLessThan(
      NETWORK_PROFILES.congested.uplinkKbps,
    );
    expect(NETWORK_PROFILES.latency.uplinkKbps).toBeGreaterThan(
      NETWORK_PROFILES.congested.uplinkKbps,
    );
    expect(NETWORK_PROFILES.latency.rttMs).toBeGreaterThan(NETWORK_PROFILES.weak.rttMs);
  });

  it('applies temporary overrides without mutating the selected preset', () => {
    const original = { ...NETWORK_PROFILES.premium };
    const resolved = resolveNetwork('premium', { uplinkKbps: 6400, lossPct: 2.5 });

    expect(resolved).toMatchObject({ id: 'premium', uplinkKbps: 6400, lossPct: 2.5 });
    expect(NETWORK_PROFILES.premium).toEqual(original);
  });

  it('maps every profile to deterministic sender constraints', () => {
    expect(senderConstraints('premium')).toEqual({
      maxBitrate: 2_500_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1,
    });
    expect(senderConstraints('weak').maxBitrate).toBeLessThan(
      senderConstraints('congested').maxBitrate,
    );
    expect(senderConstraints('weak').scaleResolutionDownBy).toBeGreaterThan(
      senderConstraints('premium').scaleResolutionDownBy,
    );
  });
});

describe('edge and cloud processing', () => {
  it('shortens every processing path at the edge', () => {
    const cloud = getProcessingLatency('cloud');
    const edge = getProcessingLatency('edge');

    expect(edge.poseMs).toBeLessThan(cloud.poseMs);
    expect(edge.translationMs).toBeLessThan(cloud.translationMs);
    expect(edge.voiceMs).toBeLessThan(cloud.voiceMs);
    expect(edge.pathNodes).toBeLessThan(cloud.pathNodes);
  });

  it('improves high-latency experience without changing the selected network profile', () => {
    const cloud = deriveExperience({
      profileId: 'latency',
      deployment: 'cloud',
      qod: false,
    });
    const edge = deriveExperience({ profileId: 'latency', deployment: 'edge', qod: false });

    expect(edge.profile).toEqual(cloud.profile);
    expect(edge.e2eLatencyMs).toBeLessThan(cloud.e2eLatencyMs);
    expect(edge.avOffsetMs).toBeLessThan(cloud.avOffsetMs);
    expect(edge.score).toBeGreaterThan(cloud.score);
  });
});

describe('QoD allocation and visible channel degradation', () => {
  it('never allocates more bandwidth than the usable QoD budget', () => {
    const network = resolveNetwork('congested');
    const allocated = allocateChannelResources(network, MARKET_PROFILES, true);
    const total = Object.values(allocated).reduce((sum, value) => sum + value, 0);

    expect(total).toBeLessThanOrEqual(Math.floor(network.uplinkKbps * 0.94));
  });

  it('reallocates scarce capacity toward the primary market when QoD is enabled', () => {
    const network = resolveNetwork('congested');
    const withoutQod = allocateChannelResources(network, MARKET_PROFILES, false);
    const withQod = allocateChannelResources(network, MARKET_PROFILES, true);

    expect(withQod['north-america']).toBeGreaterThan(withoutQod['north-america']);
    expect(withQod['north-america']).toBeGreaterThan(withQod.japan);
    expect(withQod.japan).toBeGreaterThan(withQod.spanish);
  });

  it('turns congestion into visible channel states and recovers them with QoD', () => {
    const degraded = deriveExperience({
      profileId: 'congested',
      deployment: 'cloud',
      qod: false,
    });
    const recovered = deriveExperience({
      profileId: 'congested',
      deployment: 'edge',
      qod: true,
    });

    expect(degraded.channels.some((channel) => channel.status !== 'live')).toBe(true);
    expect(degraded.pathState).toBe('stressed');
    expect(recovered.channels.every((channel) => channel.status === 'live')).toBe(true);
    expect(recovered.pathState).toBe('protected');
    expect(recovered.activeChannels).toBe(3);
    expect(recovered.score).toBeGreaterThan(degraded.score);
  });

  it('keeps the weakest third channel audio-only with QoD instead of inventing full video', () => {
    const withoutQod = deriveExperience({
      profileId: 'weak',
      deployment: 'edge',
      qod: false,
    });
    const withQod = deriveExperience({ profileId: 'weak', deployment: 'edge', qod: true });
    const thirdWithoutQod = withoutQod.channels.find(
      (channel) => channel.marketId === 'spanish',
    );
    const thirdWithQod = withQod.channels.find((channel) => channel.marketId === 'spanish');

    expect(thirdWithoutQod).toMatchObject({ status: 'paused', quality: 'none', fps: 0 });
    expect(thirdWithQod).toMatchObject({ status: 'audio-only', quality: 'audio', fps: 0 });
  });

  it('models high bandwidth and high latency as a synchronization failure', () => {
    const premium = deriveExperience({
      profileId: 'premium',
      deployment: 'cloud',
      qod: false,
    });
    const highLatency = deriveExperience({
      profileId: 'latency',
      deployment: 'cloud',
      qod: false,
    });

    expect(highLatency.profile.uplinkKbps).toBeGreaterThan(10_000);
    expect(highLatency.e2eLatencyMs).toBeGreaterThan(premium.e2eLatencyMs);
    expect(highLatency.avOffsetMs).toBeGreaterThan(premium.avOffsetMs);
    expect(highLatency.channels.every((channel) => channel.syncWarning)).toBe(true);
  });
});
