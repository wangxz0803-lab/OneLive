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
    networkOverrides,
    setDrawerOpen,
    setProfile,
    setNetworkOverride,
    toggleDeployment,
    toggleQod,
    setView,
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
        aria-label="Network experience controls"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="section-kicker">NETWORK EXPERIENCE LAB</span>
            <h2>Control plane</h2>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close network controls"
            data-dialog-initial-focus
          >
            <Icon name="close" />
          </button>
        </header>
        <section>
          <div className="drawer-section-title">
            <span>01</span>
            <strong>Deployment profile</strong>
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
            <strong>Network capability</strong>
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
                <strong>{deployment === 'edge' ? 'Edge AI' : 'Cloud AI'}</strong>
                <small>Deployment simulation</small>
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
                <strong>Quality on Demand</strong>
                <small>Session resource assurance</small>
              </span>
            </span>
            <i>{qod ? 'ON' : 'OFF'}</i>
          </button>
        </section>
        <section>
          <div className="drawer-section-title">
            <span>03</span>
            <strong>Manual emulation</strong>
          </div>
          <RangeControl
            label="Uplink"
            value={Math.round(profile.uplinkKbps / 100) / 10}
            min={0.5}
            max={25}
            step={0.5}
            unit=" Mbps"
            onChange={(value) => setNetworkOverride('uplinkKbps', value * 1000)}
          />
          <RangeControl
            label="Round-trip time"
            value={profile.rttMs}
            min={20}
            max={1200}
            step={10}
            unit=" ms"
            onChange={(value) => setNetworkOverride('rttMs', value)}
          />
          <RangeControl
            label="Jitter"
            value={profile.jitterMs}
            min={0}
            max={250}
            step={5}
            unit=" ms"
            onChange={(value) => setNetworkOverride('jitterMs', value)}
          />
          <RangeControl
            label="Packet loss"
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
            <strong>Experience view</strong>
          </div>
          <div className="view-switcher">
            <button
              className={view === 'control' ? 'active' : ''}
              type="button"
              onClick={() => setView('control')}
              aria-pressed={view === 'control'}
            >
              Control room
            </button>
            <button
              className={view === 'comparison' ? 'active' : ''}
              type="button"
              onClick={() => setView('comparison')}
              aria-pressed={view === 'comparison'}
              data-testid="comparison-toggle"
            >
              Compare
            </button>
            <button
              className={view === 'business' ? 'active' : ''}
              type="button"
              onClick={() => setView('business')}
              aria-pressed={view === 'business'}
            >
              Business
            </button>
          </div>
        </section>
        <footer>
          <button type="button" onClick={reset} data-testid="director-reset">
            <Icon name="reset" size={16} />
            Reset demo
          </button>
          <small>All injected capabilities are explicitly marked EMULATED.</small>
        </footer>
      </aside>
    </div>
  );
}
