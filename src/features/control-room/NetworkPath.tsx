import { Icon, type IconName } from '@/components/Icon';
import type { ExperienceSnapshot } from '@/core/types';

function PathNode({
  icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: IconName;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className={`path-node path-node--${tone}`}>
      <span>
        <Icon name={icon} size={17} />
      </span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

export function NetworkPath({ experience }: { experience: ExperienceSnapshot }) {
  const isEdge = experience.deployment === 'edge';
  const state = experience.pathState;
  const activeStreams = `${experience.activeChannels}/3 路市场直播`;

  return (
    <section
      className={`network-path panel network-path--${state}`}
      data-testid="network-path"
      data-state={state}
      data-topology={isEdge ? 'device-edge' : 'central-cloud'}
      aria-label="真人直播源、AI生成、多路上行与市场分发路径"
    >
      <header className="network-path__header">
        <div>
          <span className="section-kicker">直播生成与上行路径</span>
          <strong>
            {isEdge ? '端侧先生成三路，再进入5G上行' : '单路上传，云端生成三个市场版本'}
          </strong>
        </div>
        <div className="network-legend">
          <span>
            <i className="legend-live" />
            真人主直播源
          </span>
          <span>
            <i className="legend-emulated" />
            AI与网络路径 EMULATED
          </span>
        </div>
      </header>

      <div className="network-path__body">
        <svg viewBox="0 0 1000 72" preserveAspectRatio="none" aria-hidden="true">
          <path
            className="path-line path-line--base"
            d={
              isEdge
                ? 'M72 36H240C290 36 300 18 350 18H478C530 18 540 36 590 36H924'
                : 'M72 36H230C285 36 295 54 350 54H480C540 54 550 36 610 36H924'
            }
          />
          <path
            className="path-line path-line--energy"
            d={
              isEdge
                ? 'M72 36H240C290 36 300 18 350 18H478C530 18 540 36 590 36H924'
                : 'M72 36H230C285 36 295 54 350 54H480C540 54 550 36 610 36H924'
            }
          />
          {state === 'critical' && (
            <>
              <path className="packet-drop" d="M258 35v18" />
              <path className="packet-drop packet-drop--two" d="M512 42v16" />
            </>
          )}
        </svg>

        <div className="path-nodes">
          <PathNode icon="phone" label="真人主直播源" value="一路中文音视频" tone="live" />
          {isEdge ? (
            <>
              <PathNode
                icon="cpu"
                label="端侧AI直播终端"
                value="本地化 · 语音 · 视频"
                tone="edge"
              />
              <PathNode
                icon="signal"
                label="三路并发上行"
                value={`${(experience.profile.uplinkKbps / 1000).toFixed(1)} Mbps 共享`}
                tone={state}
              />
              <PathNode
                icon="shield"
                label="网络会话保障"
                value={experience.qod ? 'QoD 已启用' : '普通网络承载'}
                tone={experience.qod ? 'protected' : state}
              />
            </>
          ) : (
            <>
              <PathNode
                icon="signal"
                label="单路源流上行"
                value={`${(experience.profile.uplinkKbps / 1000).toFixed(1)} Mbps`}
                tone={state}
              />
              <PathNode icon="cloud" label="云端AI生成" value="远端处理 · 模拟" />
              <PathNode
                icon="radio"
                label="三路内容分发"
                value="本地化 · 语音 · 视频"
                tone="edge"
              />
            </>
          )}
          <PathNode
            icon="globe"
            label="三个目标市场"
            value={activeStreams}
            tone={experience.activeChannels === 3 ? 'live' : 'warning'}
          />
        </div>
      </div>

      <div className="path-summary">
        <span
          data-testid="metric-e2e-latency"
          data-value={experience.e2eLatencyMs}
          data-unit="ms"
          data-provenance="emulated"
        >
          端到端 <strong>{experience.e2eLatencyMs} ms</strong>
        </span>
        <span>
          上行拓扑 <strong>{isEdge ? '三路并发' : '单路源流'}</strong>
        </span>
        <span>
          RTT <strong>{experience.profile.rttMs} ms</strong>
        </span>
        <span>
          抖动 <strong>{experience.profile.jitterMs} ms</strong>
        </span>
        <span>
          丢包 <strong>{experience.profile.lossPct}%</strong>
        </span>
        <span>
          会话 <strong>{experience.qod ? 'QoD 已保障' : '普通网络'}</strong>
        </span>
        <small>模拟 EMULATED</small>
      </div>
    </section>
  );
}
