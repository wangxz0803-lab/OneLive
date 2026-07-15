import type { DemoLine } from '@/config/scripts';
import type { MarketId, PoseState, Provenance } from '@/core/types';

export interface ProviderResult<T> {
  value: T;
  provenance: Provenance;
  fallbackReason?: string;
}

export interface SpeechRecognitionProvider {
  readonly available: boolean;
  start(onText: (text: string) => void): Promise<void>;
  stop(): void;
}

export interface TranslationProvider {
  translate(text: string, marketId: MarketId, fallback: DemoLine): Promise<ProviderResult<string>>;
}

export interface TTSProvider {
  readonly available: boolean;
  speak(text: string, locale: string, voiceHints: string[]): Promise<ProviderResult<void>>;
  stop(): void;
}

export interface AvatarProvider {
  nextPose(timeMs: number): ProviderResult<PoseState>;
}

export interface NetworkCapabilityProvider {
  requestQoD(sessionId: string): Promise<ProviderResult<{ active: boolean }>>;
}
