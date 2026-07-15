import { create } from 'zustand';
import { DIRECTOR_PRESETS, clampDirectorStep } from '@/core/director';
import type {
  DeploymentMode,
  NetworkParameters,
  NetworkProfileId,
  SourceKind,
  ViewMode,
} from '@/core/types';

interface OneLiveState {
  sessionId: string;
  ready: boolean;
  sourceKind: SourceKind;
  sourceConnected: boolean;
  sourceMuted: boolean;
  profileId: NetworkProfileId;
  networkOverrides: Partial<NetworkParameters>;
  deployment: DeploymentMode;
  qod: boolean;
  view: ViewMode;
  drawerOpen: boolean;
  presenterMode: boolean;
  directorRunning: boolean;
  directorStep: number;
  scriptIndex: number;
  bootComplete: boolean;
  setReady: (ready: boolean) => void;
  setBootComplete: (complete: boolean) => void;
  setSource: (kind: SourceKind, connected?: boolean) => void;
  setSourceConnected: (connected: boolean) => void;
  setSourceMuted: (muted: boolean) => void;
  setProfile: (profileId: NetworkProfileId) => void;
  setNetworkOverride: (key: keyof NetworkParameters, value: number) => void;
  setDeployment: (deployment: DeploymentMode) => void;
  toggleDeployment: () => void;
  setQod: (enabled: boolean) => void;
  toggleQod: () => void;
  setView: (view: ViewMode) => void;
  setDrawerOpen: (open: boolean) => void;
  setPresenterMode: (enabled: boolean) => void;
  togglePresenterMode: () => void;
  setDirectorRunning: (running: boolean) => void;
  applyDirectorStep: (step: number) => void;
  nextDirectorStep: () => void;
  previousDirectorStep: () => void;
  setScriptIndex: (index: number) => void;
  reset: () => void;
}

const query =
  typeof window === 'undefined'
    ? new URLSearchParams()
    : new URLSearchParams(window.location.search);
const generatedSession =
  query.get('session') ?? 'ONE-' + Math.random().toString(36).slice(2, 8).toUpperCase();

const initialState = {
  sessionId: generatedSession,
  ready: false,
  sourceKind: 'mock' as SourceKind,
  sourceConnected: true,
  sourceMuted: false,
  profileId: 'premium' as NetworkProfileId,
  networkOverrides: {},
  deployment: 'cloud' as DeploymentMode,
  qod: false,
  view: 'control' as ViewMode,
  drawerOpen: false,
  presenterMode: false,
  directorRunning: false,
  directorStep: 0,
  scriptIndex: 0,
  bootComplete: query.get('skipIntro') === '1',
};

export const useOneLiveStore = create<OneLiveState>((set, get) => ({
  ...initialState,
  setReady: (ready) => set({ ready }),
  setBootComplete: (bootComplete) => set({ bootComplete }),
  setSource: (sourceKind, sourceConnected = true) => set({ sourceKind, sourceConnected }),
  setSourceConnected: (sourceConnected) => set({ sourceConnected }),
  setSourceMuted: (sourceMuted) => set({ sourceMuted }),
  setProfile: (profileId) => set({ profileId, networkOverrides: {} }),
  setNetworkOverride: (key, value) =>
    set((state) => ({ networkOverrides: { ...state.networkOverrides, [key]: value } })),
  setDeployment: (deployment) => set({ deployment }),
  toggleDeployment: () =>
    set((state) => ({ deployment: state.deployment === 'edge' ? 'cloud' : 'edge' })),
  setQod: (qod) => set({ qod }),
  toggleQod: () => set((state) => ({ qod: !state.qod })),
  setView: (view) => set({ view, drawerOpen: false }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setPresenterMode: (presenterMode) => set({ presenterMode }),
  togglePresenterMode: () => set((state) => ({ presenterMode: !state.presenterMode })),
  setDirectorRunning: (directorRunning) => set({ directorRunning }),
  applyDirectorStep: (step) => {
    const next = clampDirectorStep(step);
    const preset = DIRECTOR_PRESETS[next];
    set({
      directorStep: next,
      profileId: preset.profileId,
      networkOverrides: {},
      deployment: preset.deployment,
      qod: preset.qod,
      view: preset.view,
      drawerOpen: false,
      presenterMode: true,
    });
  },
  nextDirectorStep: () => get().applyDirectorStep(get().directorStep + 1),
  previousDirectorStep: () => get().applyDirectorStep(get().directorStep - 1),
  setScriptIndex: (scriptIndex) => set({ scriptIndex }),
  reset: () => set({ ...initialState, sessionId: get().sessionId, bootComplete: true }),
}));
