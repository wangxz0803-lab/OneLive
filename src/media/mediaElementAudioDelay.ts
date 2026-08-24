export interface MediaElementAudioDelayController {
  setDelay: (delayMs: number) => void;
  resume: () => Promise<void>;
  dispose: () => void;
}

type AudioContextFactory = () => AudioContext;

export function createMediaElementAudioDelay(
  element: HTMLMediaElement,
  initialDelayMs: number,
  createContext: AudioContextFactory = () => new AudioContext(),
): MediaElementAudioDelayController | null {
  let pendingContext: AudioContext | null = null;

  try {
    const context = createContext();
    pendingContext = context;
    const delay = context.createDelay(2);
    delay.delayTime.value = initialDelayMs / 1000;
    const source = context.createMediaElementSource(element);
    source.connect(delay);
    delay.connect(context.destination);
    element.dataset.appliedAudioDelayMs = String(initialDelayMs);
    pendingContext = null;

    return {
      setDelay(delayMs) {
        delay.delayTime.setValueAtTime(delayMs / 1000, context.currentTime);
        element.dataset.appliedAudioDelayMs = String(delayMs);
      },
      async resume() {
        if (context.state === 'suspended') await context.resume();
      },
      dispose() {
        source.disconnect();
        delay.disconnect();
        delete element.dataset.appliedAudioDelayMs;
        void context.close().catch(() => undefined);
      },
    };
  } catch {
    void pendingContext?.close().catch(() => undefined);
    return null;
  }
}
