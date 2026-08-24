import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { DEMO_MEDIA } from '@/config/demoMedia';
import { DEMO_LINES } from '@/config/scripts';
import { localizedAudioDelayMs } from '@/core/playback';
import type {
  ChannelExperience,
  DeploymentMode,
  MarketProfile,
  NetworkProfileId,
} from '@/core/types';
import { useEmulatedDelay } from '@/hooks/useEmulatedDelay';
import { useMediaElementAudioDelay } from '@/hooks/useMediaElementAudioDelay';
import { useOneLiveStore } from '@/store/useOneLiveStore';

const COMMENTS = {
  japan: ['調理モードが見やすいです。', '操作がとても簡単ですね。', '商品がよく分かります。'],
  latam: [
    'Se entiende cada función al instante.',
    '¿También mantiene la comida caliente?',
    'La demostración se ve muy clara.',
  ],
  india: [
    'The cooking modes are easy to follow.',
    'Can it schedule rice in advance?',
    'That looks useful for everyday meals.',
  ],
} satisfies Record<MarketProfile['id'], string[]>;

const STATUS_LABEL: Record<ChannelExperience['status'], string> = {
  live: '已保障',
  'low-res': '低清',
  buffering: '缓冲中',
  'audio-only': '仅音频',
  paused: '已暂停',
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
  deployment,
  qod,
  scriptIndex,
}: {
  market: MarketProfile;
  channel: ChannelExperience;
  profileId: NetworkProfileId;
  deployment: DeploymentMode;
  qod: boolean;
  scriptIndex: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [mediaUnavailable, setMediaUnavailable] = useState(false);
  const { activeRecording, setActiveRecording } = useOneLiveStore();
  const media = DEMO_MEDIA.localized[market.id];
  const line = DEMO_LINES[scriptIndex % DEMO_LINES.length];
  const deliveryDelay = Math.max(60, channel.latencyMs - 180);
  const subtitle = useEmulatedDelay(line.translations[market.id], deliveryDelay);
  const comment = useMemo(
    () => COMMENTS[market.id][scriptIndex % COMMENTS[market.id].length],
    [market.id, scriptIndex],
  );
  const degraded = channel.status !== 'live';
  const source = usingFallback ? DEMO_MEDIA.original.src : media.src;
  const audioDelayMs = localizedAudioDelayMs(profileId, deployment);
  const activateAudioDelay = useMediaElementAudioDelay(videoRef, audioDelayMs);

  useEffect(() => {
    setUsingFallback(false);
    setMediaUnavailable(false);
  }, [market.id]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (activeRecording !== 'localized') {
      video.pause();
      return;
    }
    const result = video.play();
    result?.catch(() => undefined);
  }, [activeRecording, market.id, source]);

  const handleMediaError = () => {
    if (!usingFallback) {
      setUsingFallback(true);
      return;
    }
    setMediaUnavailable(true);
    setActiveRecording(null);
  };

  return (
    <article
      className={`market-card market-card--video market-card--${market.visualTheme} ${degraded ? 'market-card--degraded' : ''}`}
      data-testid={`channel-card-${market.id}`}
      data-channel-status={channel.status}
      data-status={channel.status}
      data-quality={channel.quality}
      data-sync={channel.syncWarning ? 'warning' : 'ok'}
      data-provenance="EMULATED"
      data-deployment={deployment}
      data-qod={qod}
      lang={market.locale}
      aria-label={`${market.market} · ${market.language}本地化录屏`}
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

      <div className={`localized-video-frame localized-video-frame--${channel.status}`}>
        {!mediaUnavailable && (
          <video
            key={`${market.id}-${source}`}
            ref={videoRef}
            data-testid="localized-video"
            data-audio-delay-ms={audioDelayMs}
            src={source}
            poster={usingFallback ? DEMO_MEDIA.original.poster : media.poster}
            preload="metadata"
            playsInline
            controls
            loop
            onPlay={() => {
              setActiveRecording('localized');
              void activateAudioDelay();
            }}
            onEnded={() => setActiveRecording(null)}
            onError={handleMediaError}
          />
        )}
        <div className="recording-badges">
          {usingFallback && <span>原片回退 · 模拟 EMULATED</span>}
          <span>{media.locale}</span>
        </div>
        {usingFallback && (
          <div className="media-fallback-note" role="status">
            本地化素材待补充 · 当前显示原片回退
          </div>
        )}
        {mediaUnavailable && (
          <div className="media-unavailable" role="status">
            <Icon name="alert" size={20} />
            <strong>演示素材不可用</strong>
            <span>请加入 {media.src.replace('/demo-media/', '')} 恢复该市场。</span>
          </div>
        )}
        {channel.status !== 'live' && (
          <div className={`video-network-state video-network-state--${channel.status}`}>
            <Icon name={channel.status === 'buffering' ? 'rotate' : 'signal'} size={18} />
            <strong>{STATUS_LABEL[channel.status]}</strong>
            <span>{channel.resolution} 传输 · 网络模拟</span>
          </div>
        )}
        {channel.syncWarning && (
          <div className="sync-warning" data-testid="av-sync-warning" role="alert">
            <Icon name="alert" size={14} /> 音画同步警告
          </div>
        )}
      </div>

      <div
        className={`localized-caption ${subtitle.pending ? 'localized-caption--pending' : ''}`}
        aria-live="polite"
      >
        <span>{market.locale} · 本地化文案</span>
        <p>{subtitle.value}</p>
        {subtitle.pending && <i>翻译处理中 ···</i>}
      </div>

      <div className="channel-telemetry">
        <Metric label="视频" value={`${channel.resolution} · ${channel.fps}fps`} />
        <Metric label="码率" value={`${channel.allocatedKbps} kbps`} />
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
    </article>
  );
}
