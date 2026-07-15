import { useMemo } from 'react';
import { Icon } from '@/components/Icon';
import { DEMO_LINES } from '@/config/scripts';
import type { ChannelExperience, MarketProfile, NetworkProfileId } from '@/core/types';
import { AvatarStage } from '@/features/avatars/AvatarStage';
import { useEmulatedDelay } from '@/hooks/useEmulatedDelay';

const COMMENTS = {
  'north-america': [
    'That latency looks incredibly smooth.',
    'Can you show the comfort fit?',
    'The live captions are perfect.',
  ],
  japan: [
    '音声と映像がとても自然です。',
    '軽くて使いやすそうですね。',
    '低遅延モードが気になります。',
  ],
  spanish: [
    'La traducción llega al instante.',
    '¿Es cómodo para todo el día?',
    'La sincronización se ve genial.',
  ],
};

const STATUS_LABEL: Record<ChannelExperience['status'], string> = {
  live: 'LOCKED',
  'low-res': 'LOW RES',
  buffering: 'BUFFERING',
  'audio-only': 'AUDIO ONLY',
  paused: 'PAUSED',
};

function Metric({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: string;
  warning?: boolean;
}) {
  return (
    <div className={`channel-metric ${warning ? 'channel-metric--warning' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function MarketCard({
  market,
  channel,
  profileId,
  qod,
  scriptIndex,
}: {
  market: MarketProfile;
  channel: ChannelExperience;
  profileId: NetworkProfileId;
  qod: boolean;
  scriptIndex: number;
}) {
  const line = DEMO_LINES[scriptIndex % DEMO_LINES.length];
  const deliveryDelay = Math.max(60, channel.latencyMs - 180);
  const subtitle = useEmulatedDelay(line.translations[market.id], deliveryDelay);
  const comment = useMemo(
    () => COMMENTS[market.id][scriptIndex % COMMENTS[market.id].length],
    [market.id, scriptIndex],
  );
  const degraded = channel.status !== 'live';

  return (
    <article
      className={`market-card market-card--${market.visualTheme} ${degraded ? 'market-card--degraded' : ''}`}
      data-testid={`channel-card-${market.id}`}
      data-channel-status={channel.status}
      data-status={channel.status}
      data-quality={channel.quality}
      data-sync={channel.syncWarning ? 'warning' : 'ok'}
      data-provenance="EMULATED"
      lang={market.locale}
      aria-label={`${market.language}, ${market.market} live channel`}
    >
      <header className="market-header">
        <div className="market-identity">
          <span className="market-index">0{market.priority}</span>
          <div>
            <strong>{market.language}</strong>
            <small>{market.market}</small>
          </div>
        </div>
        <div className={`channel-lock channel-lock--${channel.status}`}>
          <i />
          <span>{STATUS_LABEL[channel.status]}</span>
        </div>
      </header>

      <AvatarStage market={market} profileId={profileId} qod={qod} channel={channel} />

      <div
        className={`localized-caption ${subtitle.pending ? 'localized-caption--pending' : ''}`}
        aria-live="polite"
      >
        <span>{market.locale}</span>
        <p>{subtitle.value}</p>
        {subtitle.pending && <i>TRANSLATING ···</i>}
      </div>

      <div className="channel-telemetry">
        <Metric label="VIDEO" value={`${channel.resolution} · ${channel.fps}fps`} />
        <Metric label="BITRATE" value={`${channel.allocatedKbps} kbps`} />
        <Metric label="E2E" value={`${channel.latencyMs} ms`} warning={channel.latencyMs > 700} />
        <Metric label="A/V SYNC" value={`${channel.avOffsetMs} ms`} warning={channel.syncWarning} />
      </div>

      <footer className="market-footer">
        <div className="platform-signature">
          <Icon name="radio" size={13} />
          <span>{market.platformName}</span>
        </div>
        <div className="audience">
          <Icon name="users" size={13} />
          <span>{channel.viewers.toLocaleString('en-US')}</span>
        </div>
        <div className="comment-ticker">
          <strong>{comment}</strong>
        </div>
      </footer>

      {channel.syncWarning && (
        <div className="sync-warning" data-testid="av-sync-warning" role="alert">
          <Icon name="alert" size={14} /> A/V SYNC WARNING
        </div>
      )}
    </article>
  );
}
