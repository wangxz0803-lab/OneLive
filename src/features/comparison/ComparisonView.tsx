import { Icon } from '@/components/Icon';
import { MARKET_PROFILES } from '@/config/markets';
import { deriveExperience } from '@/core/network';
import type { ChannelExperience, ExperienceSnapshot } from '@/core/types';
import { AvatarStage } from '@/features/avatars/AvatarStage';

function ChannelRail({ experience }: { experience: ExperienceSnapshot }) {
  return (
    <div className="comparison-channel-rail">
      {experience.channels.map((channel, index) => (
        <div key={channel.marketId} data-status={channel.status}>
          <span>0{index + 1}</span>
          <strong>{channel.status === 'live' ? 'LOCKED' : channel.status.toUpperCase()}</strong>
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
}: {
  side: 'cloud' | 'edge';
  experience: ExperienceSnapshot;
}) {
  const market = MARKET_PROFILES[0];
  const channel = experience.channels[0] as ChannelExperience;
  const optimized = side === 'edge';
  return (
    <section
      className={`scenario-panel scenario-panel--${side}`}
      data-testid={optimized ? 'comparison-edge-qod' : 'comparison-cloud'}
    >
      <header>
        <div>
          <span className="section-kicker">{optimized ? 'ASSURED PATH' : 'BEST EFFORT PATH'}</span>
          <h2>{optimized ? 'Edge AI + QoD' : 'Cloud + Best Effort'}</h2>
        </div>
        <div
          className={`scenario-state ${optimized ? 'scenario-state--good' : 'scenario-state--bad'}`}
        >
          <Icon name={optimized ? 'shield' : 'alert'} size={15} />
          {optimized ? 'EXPERIENCE LOCKED' : 'EXPERIENCE DEGRADED'}
        </div>
      </header>
      <div className="scenario-stage">
        <AvatarStage
          market={market}
          profileId={experience.profile.id}
          qod={experience.qod}
          channel={channel}
          compact
        />
        <div className={`scenario-caption ${optimized ? '' : 'scenario-caption--backlog'}`}>
          <span>EN-US · {optimized ? '42 MS BACKLOG' : '680 MS BACKLOG'}</span>
          <p>Built for all-day comfort with a dedicated low-latency mode.</p>
        </div>
        <div className="scenario-timecode">TC 18:24:07:{optimized ? '18' : '05'}</div>
      </div>
      <ChannelRail experience={experience} />
      <footer>
        <span>
          <Icon name="signal" size={14} /> {experience.profile.uplinkKbps / 1000} Mbps uplink
        </span>
        <span>
          <Icon name={optimized ? 'server' : 'cloud'} size={14} />{' '}
          {optimized ? 'Edge simulation' : 'Cloud simulation'}
        </span>
        <span>
          <Icon name="radio" size={14} /> {experience.activeChannels}/3 active channels
        </span>
      </footer>
    </section>
  );
}

export function ComparisonView() {
  const cloud = deriveExperience({ profileId: 'congested', deployment: 'cloud', qod: false });
  const edge = deriveExperience({ profileId: 'congested', deployment: 'edge', qod: true });
  const metrics = [
    {
      label: 'E2E LATENCY',
      left: `${cloud.e2eLatencyMs} ms`,
      right: `${edge.e2eLatencyMs} ms`,
      delta: `−${cloud.e2eLatencyMs - edge.e2eLatencyMs} ms`,
    },
    {
      label: 'AVATAR FPS',
      left: `${cloud.averageFps}`,
      right: `${edge.averageFps}`,
      delta: `+${edge.averageFps - cloud.averageFps} fps`,
    },
    {
      label: 'A/V OFFSET',
      left: `${cloud.avOffsetMs} ms`,
      right: `${edge.avOffsetMs} ms`,
      delta: `−${cloud.avOffsetMs - edge.avOffsetMs} ms`,
    },
    {
      label: 'ACTIVE',
      left: `${cloud.activeChannels}/3`,
      right: `${edge.activeChannels}/3`,
      delta: `+${edge.activeChannels - cloud.activeChannels}`,
    },
    {
      label: 'EXPERIENCE',
      left: `${cloud.score}`,
      right: `${edge.score}`,
      delta: `+${edge.score - cloud.score}`,
    },
  ];
  return (
    <main id="main-content" className="comparison-view" data-testid="comparison-view">
      <h1 className="visually-hidden">Cloud versus Edge AI and Quality on Demand comparison</h1>
      <div className="comparison-title">
        <span>SAME SOURCE</span>
        <i />
        <strong>DIFFERENT NETWORK EXPERIENCE</strong>
        <i />
        <span>VISIBLE IMPACT</span>
      </div>
      <div className="comparison-grid">
        <ScenarioPanel side="cloud" experience={cloud} />
        <aside className="delta-spine" aria-label="Experience difference">
          <header>
            <span>Δ</span>
            <strong>EXPERIENCE</strong>
            <small>EMULATED</small>
          </header>
          <div className="delta-list">
            {metrics.map((metric) => (
              <div key={metric.label}>
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
            <span>EDGE ADVANTAGE</span>
          </footer>
        </aside>
        <ScenarioPanel side="edge" experience={edge} />
      </div>
    </main>
  );
}
