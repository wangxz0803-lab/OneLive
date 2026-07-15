import { Icon, type IconName } from '@/components/Icon';
import type { ExperienceSnapshot } from '@/core/types';

function PathNode({ icon, label, value, tone = 'neutral' }: { icon: IconName; label: string; value: string; tone?: string }) {
  return <div className={`path-node path-node--${tone}`}><span><Icon name={icon} size={17} /></span><div><small>{label}</small><strong>{value}</strong></div></div>;
}

export function NetworkPath({ experience }: { experience: ExperienceSnapshot }) {
  const isEdge = experience.deployment === 'edge';
  const state = experience.pathState;
  return (
    <section className={`network-path panel network-path--${state}`} data-testid="network-path" data-state={state} aria-label="End, network, edge, cloud and market data path">
      <header className="network-path__header">
        <div><span className="section-kicker">LIVE SIGNAL TOPOLOGY</span><strong>End · Network · Intelligence · Markets</strong></div>
        <div className="network-legend"><span><i className="legend-live" />LIVE MEDIA</span><span><i className="legend-emulated" />NETWORK EMULATION</span></div>
      </header>
      <div className="network-path__body">
        <svg viewBox="0 0 1000 72" preserveAspectRatio="none" aria-hidden="true">
          <path className="path-line path-line--base" d={isEdge ? 'M72 36H240C290 36 300 18 350 18H478C530 18 540 36 590 36H924' : 'M72 36H230C285 36 295 54 350 54H480C540 54 550 36 610 36H924'} />
          <path className="path-line path-line--energy" d={isEdge ? 'M72 36H240C290 36 300 18 350 18H478C530 18 540 36 590 36H924' : 'M72 36H230C285 36 295 54 350 54H480C540 54 550 36 610 36H924'} />
          {state === 'critical' && <><path className="packet-drop" d="M258 35v18"/><path className="packet-drop packet-drop--two" d="M512 42v16"/></>}
        </svg>
        <div className="path-nodes">
          <PathNode icon="phone" label="SOURCE" value="HOST SIGNAL" tone="live" />
          <PathNode icon="signal" label="5G UPLINK" value={`${(experience.profile.uplinkKbps / 1000).toFixed(1)} MBPS`} tone={state} />
          <PathNode icon={isEdge ? 'server' : 'cloud'} label={isEdge ? 'EDGE ZONE' : 'REGIONAL CLOUD'} value={isEdge ? '18 KM · SIM' : '1,260 KM · SIM'} tone={isEdge ? 'edge' : 'neutral'} />
          <PathNode icon="cpu" label="AI PIPELINE" value={`TRANSLATE · VOICE · AVATAR`} tone="edge" />
          <PathNode icon="globe" label="DISTRIBUTION" value={`${experience.activeChannels}/3 MARKETS LIVE`} tone={experience.activeChannels === 3 ? 'live' : 'warning'} />
        </div>
      </div>
      <div className="path-summary">
        <span data-testid="metric-e2e-latency" data-value={experience.e2eLatencyMs} data-unit="ms" data-provenance="emulated">E2E <strong>{experience.e2eLatencyMs} ms</strong></span>
        <span>RTT <strong>{experience.profile.rttMs} ms</strong></span>
        <span>JITTER <strong>{experience.profile.jitterMs} ms</strong></span>
        <span>LOSS <strong>{experience.profile.lossPct}%</strong></span>
        <span>AI PATH <strong>{experience.processing.pathNodes} NODES</strong></span>
        <span>SESSION <strong>{experience.qod ? 'QoD PROTECTED' : 'BEST EFFORT'}</strong></span>
        <small>EMULATED</small>
      </div>
    </section>
  );
}
