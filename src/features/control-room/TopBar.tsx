import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { OneLiveLogo } from '@/components/OneLiveLogo';
import { DIRECTOR_PRESETS } from '@/core/director';
import type { ExperienceSnapshot } from '@/core/types';
import { useOneLiveStore } from '@/store/useOneLiveStore';

function StatusRailItem({
  label,
  value,
  state = 'neutral',
}: {
  label: string;
  value: string;
  state?: 'live' | 'edge' | 'warning' | 'neutral';
}) {
  return (
    <div className={`status-rail-item status-rail-item--${state}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function TopBar({ experience }: { experience: ExperienceSnapshot }) {
  const {
    sourceConnected,
    sourceKind,
    profileId,
    deployment,
    qod,
    drawerOpen,
    directorRunning,
    directorStep,
    setDrawerOpen,
    setDirectorRunning,
    applyDirectorStep,
  } = useOneLiveStore();
  const [fullscreenError, setFullscreenError] = useState(false);
  const realSourceConnected = sourceConnected && sourceKind !== 'mock';
  const sourceLabel =
    sourceKind === 'mock'
      ? 'MOCK · EMULATED'
      : sourceConnected
        ? `${sourceKind === 'phone' ? 'PHONE WEBRTC' : 'LOCAL CAMERA'} · LIVE`
        : 'STANDBY';

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setFullscreenError(true);
      window.setTimeout(() => setFullscreenError(false), 2800);
    }
  };

  const runDirector = () => {
    if (!directorRunning) applyDirectorStep(0);
    setDirectorRunning(!directorRunning);
  };

  return (
    <header className="top-bar">
      <OneLiveLogo />
      <div className="status-rail" role="group" aria-label="System status">
        <StatusRailItem
          label="PROGRAM"
          value={realSourceConnected ? 'LIVE INPUT' : 'DEMO'}
          state={realSourceConnected ? 'live' : 'neutral'}
        />
        <StatusRailItem
          label="SOURCE"
          value={sourceLabel}
          state={realSourceConnected ? 'live' : sourceKind === 'mock' ? 'neutral' : 'warning'}
        />
        <StatusRailItem
          label="NETWORK"
          value={`${profileId === 'premium' ? 'PREMIUM 5G' : experience.profile.shortLabel} · SIM`}
          state={profileId === 'weak' ? 'warning' : 'neutral'}
        />
        <StatusRailItem
          label="INFERENCE"
          value={deployment === 'edge' ? 'EDGE SIM' : 'CLOUD SIM'}
          state={deployment === 'edge' ? 'edge' : 'neutral'}
        />
        <StatusRailItem
          label="QoD"
          value={qod ? 'PROTECTED · SIM' : 'OFF · SIM'}
          state={qod ? 'edge' : 'neutral'}
        />
      </div>
      <div className="top-actions">
        <button
          className={`director-button ${directorRunning ? 'director-button--active' : ''}`}
          data-testid="director-start"
          type="button"
          onClick={runDirector}
          aria-label={
            directorRunning ? 'Pause automatic demo director' : 'Start automatic demo director'
          }
        >
          <Icon name={directorRunning ? 'pause' : 'play'} size={16} />
          <span>
            {directorRunning
              ? `STEP ${directorStep + 1} · ${DIRECTOR_PRESETS[directorStep].label}`
              : 'RUN DEMO'}
          </span>
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={() => setDrawerOpen(!drawerOpen)}
          aria-label="Open network controls"
          aria-expanded={drawerOpen}
          aria-controls="network-drawer"
          aria-haspopup="dialog"
        >
          <Icon name="settings" />
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={toggleFullscreen}
          aria-label="Toggle fullscreen"
        >
          <Icon name="fullscreen" />
        </button>
      </div>
      {fullscreenError && (
        <div className="toast" role="status">
          Fullscreen was blocked. Presenter mode remains active.
        </div>
      )}
    </header>
  );
}
