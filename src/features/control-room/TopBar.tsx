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
      ? '真人直播样例 · 模拟 EMULATED'
      : sourceConnected
        ? `${sourceKind === 'phone' ? '手机 WEBRTC' : '本机摄像头'} · 实时 LIVE`
        : '待机';

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
      <div className="status-rail" role="group" aria-label="系统状态">
        <StatusRailItem
          label="场景"
          value={realSourceConnected ? '真人实时直播 LIVE' : '真人跨境直播'}
          state={realSourceConnected ? 'live' : 'neutral'}
        />
        <StatusRailItem
          label="主直播源"
          value={sourceLabel}
          state={realSourceConnected ? 'live' : sourceKind === 'mock' ? 'neutral' : 'warning'}
        />
        <StatusRailItem
          label="网络"
          value={`${profileId === 'premium' ? '优享 5G' : experience.profile.shortLabel} · 模拟`}
          state={profileId === 'weak' ? 'warning' : 'neutral'}
        />
        <StatusRailItem
          label="AI生成位置"
          value={deployment === 'edge' ? '端侧AI终端 · 模拟' : '云端生成 · 模拟'}
          state={deployment === 'edge' ? 'edge' : 'neutral'}
        />
        <StatusRailItem
          label="QoD"
          value={qod ? '已保障 · 模拟' : '未启用 · 模拟'}
          state={qod ? 'edge' : 'neutral'}
        />
      </div>
      <div className="top-actions">
        <button
          className={`director-button ${directorRunning ? 'director-button--active' : ''}`}
          data-testid="director-start"
          type="button"
          onClick={runDirector}
          aria-label={directorRunning ? '暂停自动演示' : '开始自动演示'}
        >
          <Icon name={directorRunning ? 'pause' : 'play'} size={16} />
          <span>
            {directorRunning
              ? `第 ${directorStep + 1} 步 · ${DIRECTOR_PRESETS[directorStep].label}`
              : '开始演示'}
          </span>
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={() => setDrawerOpen(!drawerOpen)}
          aria-label="打开网络设置"
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
          aria-label="切换全屏"
        >
          <Icon name="fullscreen" />
        </button>
      </div>
      {fullscreenError && (
        <div className="toast" role="status">
          浏览器阻止了全屏，演示模式仍可继续。
        </div>
      )}
    </header>
  );
}
