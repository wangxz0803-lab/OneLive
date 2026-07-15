import type { DemoLine } from '@/config/scripts';
import type { MarketId, PoseState } from '@/core/types';
import type {
  AvatarProvider,
  NetworkCapabilityProvider,
  ProviderResult,
  TTSProvider,
  TranslationProvider,
} from '@/providers/contracts';

export class DemoTranslationProvider implements TranslationProvider {
  async translate(_text: string, marketId: MarketId, fallback: DemoLine): Promise<ProviderResult<string>> {
    return { value: fallback.translations[marketId], provenance: 'EMULATED' };
  }
}

export class BrowserTTSProvider implements TTSProvider {
  readonly available = typeof window !== 'undefined' && 'speechSynthesis' in window;

  async speak(text: string, locale: string, voiceHints: string[]): Promise<ProviderResult<void>> {
    if (!this.available) {
      return { value: undefined, provenance: 'EMULATED', fallbackReason: 'Browser TTS unavailable' };
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = locale;
    const voices = window.speechSynthesis.getVoices();
    utterance.voice =
      voices.find((voice) => voiceHints.some((hint) => voice.name.includes(hint))) ??
      voices.find((voice) => voice.lang.toLowerCase().startsWith(locale.slice(0, 2).toLowerCase())) ??
      null;
    await new Promise<void>((resolve) => {
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
      window.setTimeout(resolve, Math.max(1800, text.length * 110));
    });
    return { value: undefined, provenance: 'LIVE' };
  }

  stop(): void {
    if (this.available) window.speechSynthesis.cancel();
  }
}

export class SeededPoseProvider implements AvatarProvider {
  nextPose(timeMs: number): ProviderResult<PoseState> {
    const t = timeMs / 1000;
    return {
      provenance: 'EMULATED',
      value: {
        headX: Math.sin(t * 0.72) * 0.08,
        headY: Math.sin(t * 0.48 + 1.2) * 0.045,
        shoulderTilt: Math.sin(t * 0.62) * 0.04,
        leftArm: -0.18 + Math.sin(t * 0.52) * 0.12,
        rightArm: 0.22 + Math.sin(t * 0.66 + 0.8) * 0.16,
        mouthOpen: 0.18 + Math.max(0, Math.sin(t * 7.2)) * 0.24,
        blink: Math.sin(t * 1.74) > 0.985 ? 1 : 0,
      },
    };
  }
}

export class SimulatedNetworkCapabilityProvider implements NetworkCapabilityProvider {
  async requestQoD(_sessionId: string): Promise<ProviderResult<{ active: boolean }>> {
    return { value: { active: true }, provenance: 'EMULATED' };
  }
}
