import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { DEMO_MEDIA } from '@/config/demoMedia';
import { MARKET_PROFILES } from '@/config/markets';
import { DEMO_LINES } from '@/config/scripts';
import { deriveExperience } from '@/core/network';
import type { ChannelExperience, ExperienceSnapshot, MarketProfile } from '@/core/types';
import { useOneLiveStore } from '@/store/useOneLiveStore';

const CHANNEL_STATUS_LABEL: Record<ChannelExperience['status'], string> = {
  live: '已保障',
  'low-res': '低清',
  buffering: '缓冲中',
  'audio-only': '仅音频',
  paused: '已暂停',
};

function ChannelRail({ experience }: { experience: ExperienceSnapshot }) {
  return (
    <div className="comparison-channel-rail">
      {experience.channels.map((channel, index) => (
        <div key={channel.marketId} data-status={channel.status}>
          <span>0{index + 1}</span>
          <strong>{CHANNEL_STATUS_LABEL[channel.status]}</strong>
          <small>
            {channel.resolution} · {channel.fps}fps
          </small>
        </div>
      ))}
    </div>
  );
}

function ScenarioPanel({
  side,
  experience,
  market,
}: {
  side: 'cloud' | 'edge';
  experience: ExperienceSnapshot;
  market: MarketProfile;
}) {
  const [usingFallback, setUsingFallback] = useState(false);
  const channel =
    experience.channels.find((candidate) => candidate.marketId === market.id) ??
    (experience.channels[0] as ChannelExperience);
  const optimized = side === 'edge';
  const media = DEMO_MEDIA.localized[market.id];
  const source = usingFallback ? DEMO_MEDIA.original.src : media.src;
  return (
    <section
      className={`scenario-panel scenario-panel--${side}`}
      data-testid={optimized ? 'comparison-edge-qod' : 'comparison-cloud'}
    >
      <header>
        <div>
          <span className="section-kicker">{optimized ? '保障链路' : '普通链路'}</span>
          <h2>{optimized ? '边缘 AI · QoD 保障' : '云端处理 · 普通网络'}</h2>
        </div>
        <div
          className={`scenario-state ${optimized ? 'scenario-state--good' : 'scenario-state--bad'}`}
        >
          <Icon name={optimized ? 'shield' : 'alert'} size={15} />
          {optimized ? '体验已保障' : '体验已降级'}
        </div>
      </header>
      <div
        className={`scenario-stage scenario-stage--video ${optimized ? '' : 'scenario-stage--degraded'}`}
      >
        <video
          key={`${side}-${source}`}
          data-testid="comparison-video"
          src={source}
          poster={usingFallback ? DEMO_MEDIA.original.poster : media.poster}
          muted
          autoPlay
          loop
          playsInline
          onError={() => setUsingFallback(true)}
        />
        <div className="recording-badges">
          {usingFallback && <span>原片回退 · 模拟 EMULATED</span>}
          <span>
            {market.market} · {market.locale}
          </span>
        </div>
        {!optimized && (
          <div className="video-network-state video-network-state--buffering">
            <Icon name="rotate" size={18} />
            <strong>拥塞传输</strong>
            <span>
              {channel.resolution} · {channel.allocatedKbps} kbps
            </span>
          </div>
        )}
        <div className={`scenario-caption ${optimized ? '' : 'scenario-caption--backlog'}`}>
          <span>
            {market.locale} · {optimized ? '42 MS 积压' : '680 MS 积压'}
          </span>
          <p>{DEMO_LINES[0].translations[market.id]}</p>
        </div>
        <div className="scenario-timecode">TC 00:00:0{optimized ? '4' : '9'} · 模拟</div>
      </div>
      <ChannelRail experience={experience} />
      <footer>
        <span>
          <Icon name="signal" size={14} /> {experience.profile.uplinkKbps / 1000} Mbps 上行
        </span>
        <span>
          <Icon name={optimized ? 'server' : 'cloud'} size={14} />{' '}
          {optimized ? '边缘模拟' : '云端模拟'}
        </span>
        <span>
          <Icon name="radio" size={14} /> {experience.activeChannels}/3 个在线频道
        </span>
      </footer>
    </section>
  );
}

export function ComparisonView() {
  const selectedMarketId = useOneLiveStore((state) => state.selectedMarketId);
  const market =
    MARKET_PROFILES.find((candidate) => candidate.id === selectedMarketId) ?? MARKET_PROFILES[0];
  const cloud = deriveExperience({ profileId: 'congested', deployment: 'cloud', qod: false });
  const edge = deriveExperience({ profileId: 'congested', deployment: 'edge', qod: true });
  const metrics = [
    {
      label: '端到端时延',
      left: `${cloud.e2eLatencyMs} ms`,
      right: `${edge.e2eLatencyMs} ms`,
      delta: `−${cloud.e2eLatencyMs - edge.e2eLatencyMs} ms`,
    },
    {
      label: '视频帧率',
      left: `${cloud.averageFps} fps`,
      right: `${edge.averageFps} fps`,
      delta: `+${edge.averageFps - cloud.averageFps} fps`,
    },
    {
      label: '音画偏移',
      left: `${cloud.avOffsetMs} ms`,
      right: `${edge.avOffsetMs} ms`,
      delta: `−${cloud.avOffsetMs - edge.avOffsetMs} ms`,
    },
  ];
  return (
    <main id="main-content" className="comparison-view" data-testid="comparison-view">
      <h1 className="visually-hidden">云端普通网络与边缘 AI、QoD 保障对比</h1>
      <div className="comparison-title">
        <span>当前市场：{market.market}</span>
        <i />
        <strong>同一市场视频，不同网络体验</strong>
        <i />
        <span>交付差异可见</span>
      </div>
      <div className="comparison-grid">
        <ScenarioPanel side="cloud" experience={cloud} market={market} />
        <aside className="delta-spine" aria-label="体验改善摘要">
          <header>
            <span>改善结果</span>
            <strong>边缘保障后</strong>
            <small>核心体验恢复</small>
          </header>
          <div className="delta-list">
            {metrics.map((metric) => (
              <div key={metric.label} data-testid="comparison-delta">
                <span>{metric.label}</span>
                <small>
                  {metric.left} → {metric.right}
                </small>
                <strong>{metric.delta}</strong>
              </div>
            ))}
          </div>
          <footer>
            <Icon name="arrow" />
            <span>关键体验已恢复</span>
          </footer>
        </aside>
        <ScenarioPanel side="edge" experience={edge} market={market} />
      </div>
    </main>
  );
}
