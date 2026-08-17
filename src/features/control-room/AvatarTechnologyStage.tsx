import { Icon } from '@/components/Icon';
import { MARKET_PROFILES } from '@/config/markets';
import { DEMO_LINES } from '@/config/scripts';
import type {
  ChannelExperience,
  ExperienceSnapshot,
  MarketProfile,
  NetworkProfileId,
} from '@/core/types';
import { AvatarStage } from '@/features/avatars/AvatarStage';
import { useEmulatedDelay } from '@/hooks/useEmulatedDelay';
import { useOneLiveStore } from '@/store/useOneLiveStore';

const COMMENTS = {
  japan: ['調理モードが見やすいです。', '操作がとても簡単ですね。', '商品の特徴がよく分かります。'],
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

function AvatarTechnologyCard({
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
  const comment = COMMENTS[market.id][scriptIndex % COMMENTS[market.id].length];
  const degraded = channel.status !== 'live';

  return (
    <article
      className={`market-card market-card--avatar market-card--${market.visualTheme} ${degraded ? 'market-card--degraded' : ''}`}
      data-testid={`avatar-channel-${market.id}`}
      data-status={channel.status}
      data-quality={channel.quality}
      data-sync={channel.syncWarning ? 'warning' : 'ok'}
      data-provenance="EMULATED"
      lang={market.locale}
      aria-label={`${market.market}程序化数字人技术预览`}
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
        <span>{market.locale} · 实时文案模拟</span>
        <p>{subtitle.value}</p>
        {subtitle.pending && <i>处理中文案…</i>}
      </div>

      <div className="channel-telemetry">
        <Metric label="视频" value={`${channel.resolution} · ${channel.fps}fps`} />
        <Metric label="码率" value={`${channel.allocatedKbps} kbps`} />
        <Metric
          label="端到端"
          value={`${channel.latencyMs} ms`}
          warning={channel.latencyMs > 700}
        />
        <Metric label="音画同步" value={`${channel.avOffsetMs} ms`} warning={channel.syncWarning} />
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
        <div className="sync-warning" data-testid="avatar-av-sync-warning" role="alert">
          <Icon name="alert" size={14} /> 音画同步警告
        </div>
      )}
    </article>
  );
}

export function AvatarTechnologyStage({ experience }: { experience: ExperienceSnapshot }) {
  const { profileId, qod, scriptIndex } = useOneLiveStore();

  return (
    <section
      className="avatar-technology-stage panel"
      data-testid="avatar-technology-stage"
      data-provenance="EMULATED"
      aria-label="数字人技术视图"
    >
      <header className="avatar-technology-stage__header">
        <div>
          <span className="section-kicker">可选技术预览</span>
          <strong>数字人技术视图</strong>
        </div>
        <p>程序化人脸、口型与姿态 · EMULATED</p>
      </header>

      <div className="market-grid avatar-technology-grid">
        {MARKET_PROFILES.map((market, index) => (
          <AvatarTechnologyCard
            key={market.id}
            market={market}
            channel={
              experience.channels.find((channel) => channel.marketId === market.id) ??
              experience.channels[index]
            }
            profileId={profileId}
            qod={qod}
            scriptIndex={scriptIndex}
          />
        ))}
      </div>
    </section>
  );
}
