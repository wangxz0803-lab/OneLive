import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { OneLiveLogo } from '@/components/OneLiveLogo';
import { DIRECTOR_PRESETS } from '@/core/director';
import { deriveExperience } from '@/core/network';
import { MARKET_PROFILES } from '@/config/markets';
import { BroadcasterPage } from '@/features/broadcast/BroadcasterPage';
import { BusinessView } from '@/features/business/BusinessView';
import { ComparisonView } from '@/features/comparison/ComparisonView';
import { DirectorHud } from '@/features/control-room/DirectorHud';
import { MarketCard } from '@/features/control-room/MarketCard';
import { NetworkDrawer } from '@/features/control-room/NetworkDrawer';
import { NetworkPath } from '@/features/control-room/NetworkPath';
import { SourcePanel } from '@/features/control-room/SourcePanel';
import { TopBar } from '@/features/control-room/TopBar';
import { useOneLiveStore } from '@/store/useOneLiveStore';

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Keep internal details out of the demo surface. */
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-fallback">
        <OneLiveLogo />
        <Icon name="alert" size={32} />
        <h1>OneLive entered Safe Demo mode</h1>
        <p>The visual renderer was reset. Reload to return to the control room.</p>
        <button type="button" onClick={() => window.location.reload()}>
          <Icon name="reset" />
          Reload control room
        </button>
      </main>
    );
  }
}

function BootSequence() {
  return (
    <motion.div
      className="boot-sequence"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.32 }}
    >
      <div className="boot-mark">
        <OneLiveLogo />
        <span />
      </div>
      <p>INITIALIZING GLOBAL BROADCAST FABRIC</p>
      <div className="boot-progress">
        <i />
      </div>
    </motion.div>
  );
}

function ControlRoomPage() {
  const state = useOneLiveStore();
  const {
    bootComplete,
    directorRunning,
    directorStep,
    nextDirectorStep,
    setBootComplete,
    setDirectorRunning,
    setReady,
  } = state;
  const experience = deriveExperience({
    profileId: state.profileId,
    deployment: state.deployment,
    qod: state.qod,
    overrides: state.networkOverrides,
  });

  useEffect(() => {
    setReady(true);
    if (bootComplete) return;
    const timer = window.setTimeout(() => setBootComplete(true), 1050);
    return () => window.clearTimeout(timer);
  }, [bootComplete, setBootComplete, setReady]);

  useEffect(() => {
    if (!directorRunning) return;
    if (directorStep >= DIRECTOR_PRESETS.length - 1) {
      setDirectorRunning(false);
      return;
    }
    const timer = window.setTimeout(() => nextDirectorStep(), 5200);
    return () => window.clearTimeout(timer);
  }, [directorRunning, directorStep, nextDirectorStep, setDirectorRunning]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.repeat || target?.matches('input, textarea, select, [contenteditable="true"]'))
        return;
      const key = event.key.toLowerCase();
      const current = useOneLiveStore.getState();
      if (key === ' ') {
        event.preventDefault();
        current.nextDirectorStep();
      } else if (key === 'backspace') {
        event.preventDefault();
        current.previousDirectorStep();
      } else if (key === 'r') current.reset();
      else if (key === 'e') current.toggleDeployment();
      else if (key === 'q') current.toggleQod();
      else if (key === 'c')
        current.setView(current.view === 'comparison' ? 'control' : 'comparison');
      else if (key === 'm') current.setSource('mock', true);
      else if (['1', '2', '3', '4'].includes(key))
        current.setProfile((['premium', 'congested', 'weak', 'latency'] as const)[Number(key) - 1]);
      else if (key === 'f') document.documentElement.requestFullscreen?.().catch(() => undefined);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <div
      className={`app-shell app-shell--${state.view} ${state.presenterMode ? 'app-shell--presenter' : ''}`}
      data-testid="app-shell"
      data-app-ready={state.ready}
      data-ready={state.ready}
      data-network={state.profileId}
      data-edge={state.deployment === 'edge'}
      data-qod={state.qod}
    >
      <AnimatePresence>{!state.bootComplete && <BootSequence />}</AnimatePresence>
      <TopBar experience={experience} />
      <AnimatePresence mode="wait">
        {state.view === 'control' && (
          <motion.main
            id="main-content"
            key="control"
            className="control-stage"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.24 }}
          >
            <h1 className="visually-hidden">OneLive global broadcast control room</h1>
            <SourcePanel experience={experience} />
            <section
              className="market-grid"
              data-testid="channel-grid"
              aria-label="Localized live markets"
            >
              {MARKET_PROFILES.map((market, index) => (
                <MarketCard
                  key={market.id}
                  market={market}
                  channel={experience.channels[index]}
                  profileId={state.profileId}
                  qod={state.qod}
                  scriptIndex={state.scriptIndex}
                />
              ))}
            </section>
          </motion.main>
        )}
        {state.view === 'comparison' && (
          <motion.div
            key="comparison"
            className="mode-stage"
            initial={{ opacity: 0, scale: 0.992 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28 }}
          >
            <ComparisonView />
          </motion.div>
        )}
        {state.view === 'business' && (
          <motion.div
            key="business"
            className="mode-stage"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
          >
            <BusinessView />
          </motion.div>
        )}
      </AnimatePresence>
      {state.view === 'control' && <NetworkPath experience={experience} />}
      <DirectorHud />
      <NetworkDrawer />
    </div>
  );
}

export function App() {
  return (
    <AppErrorBoundary>
      <MotionConfig reducedMotion="user">
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<ControlRoomPage />} />
            <Route path="/broadcast/:sessionId" element={<BroadcasterPage />} />
            <Route path="*" element={<ControlRoomPage />} />
          </Routes>
        </BrowserRouter>
      </MotionConfig>
    </AppErrorBoundary>
  );
}
