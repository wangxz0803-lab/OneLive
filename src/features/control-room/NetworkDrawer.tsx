import { useRef } from 'react';
import { Icon } from '@/components/Icon';
import { NETWORK_PROFILES } from '@/core/network';
import type { NetworkProfileId } from '@/core/types';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { useOneLiveStore } from '@/store/useOneLiveStore';

const PROFILE_IDS: NetworkProfileId[] = ['premium', 'congested', 'weak', 'latency'];

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-control">
      <span>
        {label}
        <strong>
          {value}
          {unit}
        </strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function NetworkDrawer() {
  const drawerRef = useRef<HTMLElement>(null);
  const {
    drawerOpen,
    profileId,
    deployment,
    qod,
    view,
    controlStageMode,
    networkOverrides,
    setDrawerOpen,
    setProfile,
    setNetworkOverride,
    toggleDeployment,
    toggleQod,
    setView,
    setControlStageMode,
    reset,
  } = useOneLiveStore();
  useDialogFocus(drawerOpen, drawerRef, () => setDrawerOpen(false));
  if (!drawerOpen) return null;
  const profile = { ...NETWORK_PROFILES[profileId], ...networkOverrides };

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={() => setDrawerOpen(false)}>
      <aside
        ref={drawerRef}
        id="network-drawer"
        className="network-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="网络体验设置"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-kicker">网络体验实验室</span>
            <h2>网络控制面板</h2>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="关闭网络设置"
            data-dialog-initial-focus
          >
            <Icon name="close" />
          </button>
        </header>
        <section>
          <div className="drawer-section-title">
            <span>01</span>
            <strong>网络场景</strong>
          </div>
          <div className="profile-list">
            {PROFILE_IDS.map((id, index) => {
              const item = NETWORK_PROFILES[id];
              return (
                <button
                  key={id}
                  type="button"
                  className={profileId === id ? 'active' : ''}
                  data-testid={`profile-${id}`}
                  onClick={() => setProfile(id)}
                  aria-pressed={profileId === id}
                >
                  <span>{index + 1}</span>
                  <div>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </div>
                  {profileId === id && <Icon name="check" size={16} />}
                </button>
              );
            })}
          </div>
        </section>
        <section>
          <div className="drawer-section-title">
            <span>02</span>
            <strong>网络能力</strong>
          </div>
          <button
            className="capability-toggle"
            type="button"
            onClick={toggleDeployment}
            data-testid="deployment-toggle"
            data-mode={deployment}
            aria-pressed={deployment === 'edge'}
          >
            <span>
              <Icon name={deployment === 'edge' ? 'server' : 'cloud'} />
              <span>
                <strong>{deployment === 'edge' ? '端侧AI直播终端' : '云端AI生成'}</strong>
                <small>生成位置与上行拓扑模拟</small>
              </span>
            </span>
            <i>{deployment === 'edge' ? 'EDGE' : 'CLOUD'}</i>
          </button>
          <button
            className="capability-toggle"
            type="button"
            onClick={toggleQod}
            data-testid="qod-toggle"
            data-active={qod}
            aria-pressed={qod}
          >
            <span>
              <Icon name="shield" />
              <span>
                <strong>QoD 按需保障</strong>
                <small>会话级资源保障</small>
              </span>
            </span>
            <i>{qod ? '开启' : '关闭'}</i>
          </button>
        </section>
        <section>
          <div className="drawer-section-title">
            <span>03</span>
            <strong>手动模拟</strong>
          </div>
          <RangeControl
            label="上行带宽"
            value={Math.round(profile.uplinkKbps / 100) / 10}
            min={0.5}
            max={25}
            step={0.5}
            unit=" Mbps"
            onChange={(value) => setNetworkOverride('uplinkKbps', value * 1000)}
          />
          <RangeControl
            label="往返时延 RTT"
            value={profile.rttMs}
            min={20}
            max={1200}
            step={10}
            unit=" ms"
            onChange={(value) => setNetworkOverride('rttMs', value)}
          />
          <RangeControl
            label="网络抖动"
            value={profile.jitterMs}
            min={0}
            max={250}
            step={5}
            unit=" ms"
            onChange={(value) => setNetworkOverride('jitterMs', value)}
          />
          <RangeControl
            label="丢包率"
            value={profile.lossPct}
            min={0}
            max={20}
            step={0.5}
            unit="%"
            onChange={(value) => setNetworkOverride('lossPct', value)}
          />
        </section>
        <section>
          <div className="drawer-section-title">
            <span>04</span>
            <strong>演示视图</strong>
          </div>
          <div className="stage-mode-switcher" role="group" aria-label="主控制台演示内容">
            <button
              className={controlStageMode === 'video' && view === 'control' ? 'active' : ''}
              type="button"
              onClick={() => setControlStageMode('video')}
              aria-pressed={controlStageMode === 'video' && view === 'control'}
              data-testid="stage-mode-video"
            >
              视频样例
            </button>
            <button
              className={controlStageMode === 'avatar' && view === 'control' ? 'active' : ''}
              type="button"
              onClick={() => setControlStageMode('avatar')}
              aria-pressed={controlStageMode === 'avatar' && view === 'control'}
              data-testid="stage-mode-avatar"
            >
              数字人技术视图
            </button>
          </div>
          <div className="drawer-view-caption">其他页面</div>
          <div className="view-switcher">
            <button
              className={view === 'control' ? 'active' : ''}
              type="button"
              onClick={() => setView('control')}
              aria-pressed={view === 'control'}
            >
              主控制台
            </button>
            <button
              className={view === 'comparison' ? 'active' : ''}
              type="button"
              onClick={() => setView('comparison')}
              aria-pressed={view === 'comparison'}
              data-testid="comparison-toggle"
            >
              对比
            </button>
            <button
              className={view === 'business' ? 'active' : ''}
              type="button"
              onClick={() => setView('business')}
              aria-pressed={view === 'business'}
            >
              业务总结
            </button>
          </div>
        </section>
        <footer>
          <button type="button" onClick={reset} data-testid="director-reset">
            <Icon name="reset" size={16} />
            重置演示
          </button>
          <small>所有注入的网络能力均标记为模拟 EMULATED。</small>
        </footer>
      </aside>
    </div>
  );
}
