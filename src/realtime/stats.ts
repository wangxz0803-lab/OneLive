export interface WebRtcLiveStats {
  provenance: 'LIVE';
  sampledAt: number;
  bitrateKbps: number | null;
  fps: number | null;
  framesDropped: number | null;
  packetsLost: number | null;
  jitterMs: number | null;
  rttMs: number | null;
}

interface StatsAccumulator {
  sampledAt: number;
  bytesReceived?: number;
  framesDecoded?: number;
}

interface GenericStats {
  id?: string;
  type?: string;
  kind?: string;
  mediaType?: string;
  timestamp?: number;
  bytesReceived?: number;
  framesDecoded?: number;
  framesDropped?: number;
  framesPerSecond?: number;
  packetsLost?: number;
  jitter?: number;
  currentRoundTripTime?: number;
  nominated?: boolean;
  state?: string;
}

export const startStatsCollector = (
  peerConnection: RTCPeerConnection,
  onStats: (stats: WebRtcLiveStats) => void,
  intervalMs = 1_000,
): (() => void) => {
  let previous: StatsAccumulator | undefined;
  let collecting = false;
  let stopped = false;

  const collect = async (): Promise<void> => {
    if (collecting || stopped || peerConnection.connectionState === 'closed') return;
    collecting = true;
    try {
      const report = await peerConnection.getStats();
      let inboundVideo: GenericStats | undefined;
      let selectedPair: GenericStats | undefined;

      report.forEach((rawStat) => {
        const stat = rawStat as unknown as GenericStats;
        if (
          stat.type === 'inbound-rtp' &&
          (stat.kind === 'video' || stat.mediaType === 'video')
        ) {
          inboundVideo = stat;
        }
        if (
          stat.type === 'candidate-pair' &&
          stat.state === 'succeeded' &&
          (stat.nominated || selectedPair === undefined)
        ) {
          selectedPair = stat;
        }
      });

      const sampledAt = inboundVideo?.timestamp ?? performance.now();
      const elapsedMs = previous ? Math.max(1, sampledAt - previous.sampledAt) : 0;
      const bitrateKbps =
        previous &&
        inboundVideo?.bytesReceived !== undefined &&
        previous.bytesReceived !== undefined
          ? Math.max(0, Math.round(((inboundVideo.bytesReceived - previous.bytesReceived) * 8) / elapsedMs))
          : null;
      const fpsFromDelta =
        previous &&
        inboundVideo?.framesDecoded !== undefined &&
        previous.framesDecoded !== undefined
          ? Math.max(
              0,
              Math.round(
                ((inboundVideo.framesDecoded - previous.framesDecoded) * 1_000) / elapsedMs,
              ),
            )
          : null;

      onStats({
        provenance: 'LIVE',
        sampledAt: Date.now(),
        bitrateKbps,
        fps: inboundVideo?.framesPerSecond ?? fpsFromDelta,
        framesDropped: inboundVideo?.framesDropped ?? null,
        packetsLost: inboundVideo?.packetsLost ?? null,
        jitterMs:
          inboundVideo?.jitter === undefined ? null : Math.round(inboundVideo.jitter * 1_000),
        rttMs:
          selectedPair?.currentRoundTripTime === undefined
            ? null
            : Math.round(selectedPair.currentRoundTripTime * 1_000),
      });

      previous = {
        sampledAt,
        bytesReceived: inboundVideo?.bytesReceived,
        framesDecoded: inboundVideo?.framesDecoded,
      };
    } catch {
      // Stats support varies across browsers; unavailable fields remain visibly unknown.
    } finally {
      collecting = false;
    }
  };

  const timer = window.setInterval(() => void collect(), intervalMs);
  void collect();
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
};

