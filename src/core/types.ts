export type NetworkProfileId = 'premium' | 'congested' | 'weak' | 'latency';
export type DeploymentMode = 'cloud' | 'edge';
export type ViewMode = 'control' | 'comparison' | 'business';
export type SourceKind = 'phone' | 'local-camera' | 'mock';
export type Provenance = 'LIVE' | 'EMULATED';
export type MarketId = 'north-america' | 'japan' | 'spanish';
export type ChannelStatus = 'live' | 'low-res' | 'buffering' | 'audio-only' | 'paused';
export type ChannelQuality = 'uhd' | 'hd' | 'sd' | 'low' | 'audio' | 'none';

export interface NetworkParameters {
  uplinkKbps: number;
  rttMs: number;
  jitterMs: number;
  lossPct: number;
}

export interface NetworkProfile extends NetworkParameters {
  id: NetworkProfileId;
  label: string;
  shortLabel: string;
  description: string;
}

export interface MarketProfile {
  id: MarketId;
  market: string;
  language: string;
  locale: 'en-US' | 'ja-JP' | 'es-ES';
  visualTheme: 'cobalt' | 'violet' | 'amber';
  avatarTheme: string;
  stageTheme: string;
  platformName: string;
  ttsVoicePreference: string[];
  subtitleStyle: string;
  priority: 1 | 2 | 3;
  targetKbps: number;
  minimumStableKbps: number;
  viewers: number;
}

export interface ChannelExperience {
  marketId: MarketId;
  status: ChannelStatus;
  quality: ChannelQuality;
  allocatedKbps: number;
  fps: number;
  resolution: string;
  latencyMs: number;
  avOffsetMs: number;
  viewers: number;
  syncWarning: boolean;
}

export interface ProcessingLatency {
  poseMs: number;
  translationMs: number;
  voiceMs: number;
  pathNodes: number;
}

export interface ExperienceSnapshot {
  profile: NetworkProfile;
  deployment: DeploymentMode;
  qod: boolean;
  processing: ProcessingLatency;
  channels: ChannelExperience[];
  e2eLatencyMs: number;
  averageFps: number;
  avOffsetMs: number;
  activeChannels: number;
  score: number;
  pathState: 'stable' | 'stressed' | 'critical' | 'protected';
}

export interface PoseState {
  headX: number;
  headY: number;
  shoulderTilt: number;
  leftArm: number;
  rightArm: number;
  mouthOpen: number;
  blink: number;
}

export interface DirectorPreset {
  step: number;
  id: 'connect' | 'congestion' | 'latency' | 'edge' | 'qod' | 'business';
  label: string;
  eyebrow: string;
  narrative: string;
  nextHint: string;
  profileId: NetworkProfileId;
  deployment: DeploymentMode;
  qod: boolean;
  view: ViewMode;
}
